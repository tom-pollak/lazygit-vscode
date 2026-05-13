import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as process from "process";
import { exec } from "child_process";
import assert = require("assert");

const LAZYGIT_OPEN_COMMAND = "lazygit-vscode.open";
const LAZYGIT_SHOW_EXPLORER_COMMAND = "lazygit-vscode.showExplorer";
const LAZYGIT_SHOW_SEARCH_COMMAND = "lazygit-vscode.showSearch";
const LAZYGIT_SHOW_DEBUG_COMMAND = "lazygit-vscode.showDebug";
const LAZYGIT_SHOW_EXTENSIONS_COMMAND = "lazygit-vscode.showExtensions";
const LAZYGIT_TOGGLE_COMMAND = "lazygit-vscode.toggle";
const LAZYGIT_CONTEXT_KEY = "lazygitFocus";
const IPC_COMMAND_PREFIX = "::lazygit-vscode::";
const IPC_SHOW_EXPLORER = "showExplorer";
const IPC_SHOW_SEARCH = "showSearch";
const IPC_SHOW_DEBUG = "showDebug";
const IPC_SHOW_EXTENSIONS = "showExtensions";

interface WorkbenchViewTarget {
  command: string;
  viewCommand: string;
  ipcCommand: string;
  lazygitKey: string;
  description: string;
}

const WORKBENCH_VIEW_TARGETS: WorkbenchViewTarget[] = [
  {
    command: LAZYGIT_SHOW_EXPLORER_COMMAND,
    viewCommand: "workbench.view.explorer",
    ipcCommand: IPC_SHOW_EXPLORER,
    lazygitKey: "<c-e>",
    description: "Show VSCode Explorer",
  },
  {
    command: LAZYGIT_SHOW_SEARCH_COMMAND,
    viewCommand: "workbench.view.search",
    ipcCommand: IPC_SHOW_SEARCH,
    lazygitKey: "<c-f>",
    description: "Show VSCode Search",
  },
  {
    command: LAZYGIT_SHOW_DEBUG_COMMAND,
    viewCommand: "workbench.view.debug",
    ipcCommand: IPC_SHOW_DEBUG,
    lazygitKey: "<c-d>",
    description: "Show VSCode Run and Debug",
  },
  {
    command: LAZYGIT_SHOW_EXTENSIONS_COMMAND,
    viewCommand: "workbench.view.extensions",
    ipcCommand: IPC_SHOW_EXTENSIONS,
    lazygitKey: "<c-x>",
    description: "Show VSCode Extensions",
  },
];

let lazyGitTerminal: vscode.Terminal | undefined;
let lazyGitOpening: Promise<void> | undefined;
let lazyGitPanelVisible = false;
let lazyGitPanelMaximized = false;
let globalConfig: LazyGitConfig;
let globalConfigJSON: string;
let ipcState:
  | { ipcPath: string; overlayPath: string; watcher: fs.FSWatcher }
  | undefined;
let terminalCloseSubscription: vscode.Disposable | undefined;

/* --- Config --- */

type PanelBehavior = "keep" | "hide" | "hideRestore";

interface PanelOptions {
  sidebar: PanelBehavior;
  panel: PanelBehavior;
  secondarySidebar: PanelBehavior;
}

interface LazyGitConfig {
  lazyGitPath: string;
  configPath: string;
  autoMaximizeWindow: boolean;
  panels: PanelOptions;
  venvActivationDelay: number;
  nativeFileOpening: boolean;
  terminalKeybindingFallback: boolean;
}

function loadConfig(): LazyGitConfig {
  const config = vscode.workspace.getConfiguration("lazygit-vscode");

  // Helper function for getting panel behavior with legacy fallback
  function getPanelBehavior(panelName: string): PanelBehavior {
    const defaultValue = panelName === "panel" ? "keep" : "hide";
    const newSetting = config.get<PanelBehavior>(
      `panels.${panelName}`,
      defaultValue
    );
    if (newSetting !== defaultValue) return newSetting;

    // Legacy fallbacks for published settings
    if (panelName === "sidebar") {
      return config.get<boolean>("autoHideSideBar", false)
        ? "hide"
        : defaultValue;
    } else if (panelName === "panel") {
      return config.get<boolean>("autoHidePanel", false)
        ? "hide"
        : defaultValue;
    }

    return defaultValue;
  }

  return {
    lazyGitPath: config.get<string>("lazygitPath", ""),
    configPath: config.get<string>("configPath", ""),
    autoMaximizeWindow: config.get<boolean>("autoMaximizeWindow", false),
    panels: {
      sidebar: getPanelBehavior("sidebar"),
      panel: getPanelBehavior("panel"),
      secondarySidebar: getPanelBehavior("secondarySidebar"),
    },
    venvActivationDelay: config.get<number>("venvActivationDelay", 200),
    nativeFileOpening: config.get<boolean>("nativeFileOpening", true),
    terminalKeybindingFallback: config.get<boolean>(
      "terminalKeybindingFallback",
      true
    ),
  };
}

async function reloadIfConfigChange() {
  const currentConfig = loadConfig();
  if (JSON.stringify(currentConfig) !== globalConfigJSON) {
    await loadExtension();
  }
}

async function loadExtension() {
  globalConfig = loadConfig();
  globalConfigJSON = JSON.stringify(globalConfig);

  if (globalConfig.configPath) {
    globalConfig.configPath = expandPath(globalConfig.configPath);
  }

  // Validate lazyGitPath
  if (globalConfig.lazyGitPath) {
    globalConfig.lazyGitPath = expandPath(globalConfig.lazyGitPath);
  } else {
    try {
      globalConfig.lazyGitPath = await findExecutableOnPath("lazygit");
    } catch (error) {
      vscode.window.showErrorMessage(
        "LazyGit not found in config or on PATH. Please check your settings."
      );
    }
  }

  if (!fs.existsSync(globalConfig.lazyGitPath)) {
    vscode.window.showErrorMessage(
      `LazyGit not found at ${globalConfig.lazyGitPath}. Please check your settings.`
    );
  }

  if (globalConfig.configPath && !fs.existsSync(globalConfig.configPath)) {
    vscode.window.showWarningMessage(
      `Custom config file not found at ${globalConfig.configPath}. The default config will be used.`
    );
    globalConfig.configPath = "";
  }
}

/* --- Events --- */

export async function activate(context: vscode.ExtensionContext) {
  const updateLazyGitFocusContext = () =>
    setLazyGitFocusContext(isLazyGitTerminalActive());
  const lazyGitStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  lazyGitStatusBarItem.name = "LazyGit";
  lazyGitStatusBarItem.text = "$(source-control) LazyGit";
  lazyGitStatusBarItem.tooltip = "Open LazyGit";
  lazyGitStatusBarItem.command = LAZYGIT_OPEN_COMMAND;
  lazyGitStatusBarItem.show();

  context.subscriptions.push(
    vscode.commands.registerCommand(LAZYGIT_OPEN_COMMAND, openLazyGit),
    ...WORKBENCH_VIEW_TARGETS.map(({ command, viewCommand }) =>
      vscode.commands.registerCommand(command, () =>
        showWorkbenchView(viewCommand).then(undefined, showLazyGitError)
      )
    ),
    vscode.commands.registerCommand(LAZYGIT_TOGGLE_COMMAND, toggleLazyGit),
    lazyGitStatusBarItem,
    vscode.window.onDidChangeActiveTextEditor(updateLazyGitFocusContext),
    vscode.window.onDidChangeActiveTerminal(updateLazyGitFocusContext),
  );
}

export function deactivate() {
  cleanupIpc();
  terminalCloseSubscription?.dispose();
  terminalCloseSubscription = undefined;
}

/* ---  Window --- */

function openLazyGit() {
  showLazyGit().then(undefined, showLazyGitError);
}

async function showWorkbenchView(command: string) {
  if (lazyGitPanelVisible) {
    await closeLazyGitPanel();
    onHide(false);
  }

  await vscode.commands.executeCommand(command);
}

async function showLazyGit() {
  if (lazyGitOpening) {
    await lazyGitOpening;
    return;
  }

  if (lazyGitTerminal) {
    const shouldMaximize = !lazyGitPanelVisible;
    focusWindow();
    await onShown(shouldMaximize);
    return;
  }

  lazyGitOpening = createWindow()
    .then(() => onShown(true))
    .finally(() => {
      lazyGitOpening = undefined;
    });
  await lazyGitOpening;
}

async function toggleLazyGit() {
  if (lazyGitTerminal && lazyGitPanelVisible) {
    await closeWindow();
  } else {
    await showLazyGit();
  }
}

function showLazyGitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  vscode.window.showErrorMessage(`Failed to open LazyGit: ${message}`);
}

async function createWindow() {
  await reloadIfConfigChange();

  const workspaceFolder = getWorkspaceFolder();

  assert(globalConfig.lazyGitPath, "Uncaught error: lazygitpath is undefined!");

  // Set up IPC for native file opening, or fall back to code CLI
  cleanupIpc();
  let configFileArg: string | undefined;
  const env: { [key: string]: string } = {};

  // Ensure the terminal inherits the extension host's full PATH
  env.PATH = process.env.PATH || "";

  if (
    globalConfig.nativeFileOpening ||
    globalConfig.terminalKeybindingFallback
  ) {
    const ipc = setupIpc();
    configFileArg = ipc.configFileArg;
    ipcState = { ...ipc, watcher: startIpcWatcher(ipc.ipcPath) };
  } else if (globalConfig.configPath) {
    configFileArg = globalConfig.configPath;
  }

  // Check if Python venv activation is enabled
  const pythonConfig = vscode.workspace.getConfiguration("python");
  const activateEnvironment = pythonConfig.get<boolean>(
    "terminal.activateEnvironment",
    false
  );

  if (activateEnvironment) {
    // Use default shell so Python extension can inject venv activation
    const callOperator = process.platform === "win32" ? "& " : "";
    let lazyGitCommand = `${callOperator}"${globalConfig.lazyGitPath}"`;
    if (configFileArg) {
      lazyGitCommand += ` --use-config-file="${configFileArg}"`;
    }

    lazyGitTerminal = vscode.window.createTerminal({
      name: "LazyGit",
      cwd: workspaceFolder,
      location: vscode.TerminalLocation.Panel,
      env: env,
    });

    focusWindow();

    setTimeout(() => {
      if (lazyGitTerminal) {
        lazyGitTerminal.sendText(`${lazyGitCommand}; exit`);
      }
    }, globalConfig.venvActivationDelay);
  } else {
    const shellArgs: string[] = [];
    if (configFileArg) {
      shellArgs.push(`--use-config-file=${configFileArg}`);
    }

    lazyGitTerminal = vscode.window.createTerminal({
      name: "LazyGit",
      cwd: workspaceFolder,
      shellPath: globalConfig.lazyGitPath,
      shellArgs: shellArgs,
      location: vscode.TerminalLocation.Panel,
      env: env,
    });

    focusWindow();
  }

  // lazygit window closes, unlink and focus on editor (where lazygit was)
  terminalCloseSubscription?.dispose();
  terminalCloseSubscription = vscode.window.onDidCloseTerminal((terminal) => {
    if (terminal === lazyGitTerminal) {
      lazyGitTerminal = undefined;
      lazyGitPanelVisible = false;
      cleanupIpc();
      closeLazyGitPanel().then(() => onHide(true), showLazyGitError);
    }
  });
}

function focusWindow() {
  assert(lazyGitTerminal, "lazyGitTerminal undefined when trying to show!");
  lazyGitTerminal.show(false); // false: take focus
}

function isLazyGitTerminalActive(): boolean {
  return vscode.window.activeTerminal === lazyGitTerminal;
}

function setLazyGitFocusContext(value: boolean) {
  vscode.commands.executeCommand("setContext", LAZYGIT_CONTEXT_KEY, value);
}

async function closeWindow() {
  await closeLazyGitPanel();
  onHide(true);
}

async function onShown(maximizePanel: boolean) {
  focusWindow();
  lazyGitPanelVisible = true;
  setLazyGitFocusContext(true);

  await vscode.commands.executeCommand("workbench.action.closeSidebar");
  await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");

  if (maximizePanel) {
    await maximizeLazyGitPanel();
  }
}

async function maximizeLazyGitPanel() {
  await vscode.commands.executeCommand("workbench.action.positionPanelBottom");
  await delay(50);
  await vscode.commands.executeCommand("workbench.action.alignPanelCenter");
  await delay(50);
  await vscode.commands.executeCommand("workbench.action.toggleMaximizedPanel");
  lazyGitPanelMaximized = true;
}

async function closeLazyGitPanel() {
  if (lazyGitPanelMaximized) {
    await vscode.commands.executeCommand("workbench.action.toggleMaximizedPanel");
    lazyGitPanelMaximized = false;
  }

  lazyGitPanelVisible = false;
  setLazyGitFocusContext(false);
  await vscode.commands.executeCommand("workbench.action.closePanel");
}

function onHide(focusEditor: boolean) {
  // Restore panels
  const shouldRestore = (behavior: PanelBehavior) => behavior === "hideRestore";

  if (shouldRestore(globalConfig.panels.sidebar)) {
    vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
  }

  if (shouldRestore(globalConfig.panels.secondarySidebar)) {
    vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar");
  }

  if (!focusEditor) {
    return;
  }

  // Editor Focus -- auxiliaryBar will take focus so short delay required
  const timeoutValue =
    globalConfig.panels.secondarySidebar === "hideRestore"
      ? 200
      : 0;
  setTimeout(() => {
    vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  }, timeoutValue);
}

/* --- Utils --- */

function findExecutableOnPath(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const command =
      process.platform === "win32"
        ? `where ${executable}`
        : `${process.env.SHELL || "sh"} -lc "which ${executable}"`;
    exec(command, (error, stdout) => {
      if (error) reject(new Error(`${executable} not found on PATH`));
      else resolve(stdout.trim());
    });
  });
}

function expandPath(pth: string): string {
  pth = pth.replace(/^~(?=$|\/|\\)/, os.homedir());
  if (process.platform === "win32") {
    pth = pth.replace(/%([^%]+)%/g, (_, n) => process.env[n] || "");
  } else {
    pth = pth.replace(/\$([A-Za-z0-9_]+)/g, (_, n) => process.env[n] || "");
  }
  return pth;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getWorkspaceFolder(): string {
  const activeDocumentUri = vscode.window.activeTextEditor?.document.uri;
  let workspaceFolder: vscode.WorkspaceFolder | undefined;

  if (activeDocumentUri) {
    workspaceFolder = vscode.workspace.getWorkspaceFolder(activeDocumentUri);
  }

  if (!workspaceFolder) {
    workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  }

  return workspaceFolder?.uri.fsPath ?? os.homedir();
}

/* --- IPC File Opening --- */

function getDefaultLazygitConfigPath(): string {
  switch (process.platform) {
    case "darwin":
      if (process.env.XDG_CONFIG_HOME) {
        return path.join(process.env.XDG_CONFIG_HOME, "lazygit", "config.yml");
      }
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "lazygit",
        "config.yml"
      );
    case "win32":
      return path.join(process.env.APPDATA || "", "lazygit", "config.yml");
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "lazygit", "config.yml"
      );
  }
}

function setupIpc(): {
  ipcPath: string;
  overlayPath: string;
  configFileArg: string;
} {
  const tmpDir = os.tmpdir();
  const suffix = `${Date.now()}-${process.pid}`;

  const ipcPath = path.join(tmpDir, `lazygit-vscode-ipc-${suffix}.tmp`);
  fs.writeFileSync(ipcPath, "");
  const overlayYaml = [
    ...getNativeFileOpeningYaml(ipcPath),
    ...getTerminalKeybindingFallbackYaml(ipcPath),
    "notARepository: skip",
    "promptToReturnFromSubprocess: false",
    "",
  ].join("\n");

  const overlayPath = path.join(tmpDir, `lazygit-vscode-config-${suffix}.yml`);
  fs.writeFileSync(overlayPath, overlayYaml);

  // --use-config-file replaces the default config, so include user config first,
  // then overlay (later files take priority via lazygit's deep merge)
  const userConfigPath =
    globalConfig.configPath || getDefaultLazygitConfigPath();
  const configFiles: string[] = [];
  if (fs.existsSync(userConfigPath)) {
    configFiles.push(userConfigPath);
  }
  configFiles.push(overlayPath);

  return { ipcPath, overlayPath, configFileArg: configFiles.join(",") };
}

function getNativeFileOpeningYaml(ipcPath: string): string[] {
  if (!globalConfig.nativeFileOpening) {
    return [];
  }

  return [
    "os:",
    `  edit: 'printf "%s\\t0\\n" "{{filename}}" > "${ipcPath}"'`,
    `  editAtLine: 'printf "%s\\t%s\\n" "{{filename}}" "{{line}}" > "${ipcPath}"'`,
  ];
}

function getTerminalKeybindingFallbackYaml(ipcPath: string): string[] {
  if (!globalConfig.terminalKeybindingFallback) {
    return [];
  }

  return [
    "keybinding:",
    "  universal:",
    "    diffingMenu-alt: '<disabled>'",
    "    scrollDownMain-alt2: '<disabled>'",
    "  files:",
    "    findBaseCommitForFixup: '<disabled>'",
    "customCommands:",
    ...WORKBENCH_VIEW_TARGETS.flatMap((target) =>
      getCustomCommandYaml(ipcPath, target)
    ),
  ];
}

function getCustomCommandYaml(
  ipcPath: string,
  target: WorkbenchViewTarget
): string[] {
  const command = createIpcWriteCommand(
    ipcPath,
    `${IPC_COMMAND_PREFIX}${target.ipcCommand}`
  );

  return [
    `  - key: '${target.lazygitKey}'`,
    "    context: 'global'",
    `    command: ${toYamlString(command)}`,
    `    description: '${target.description}'`,
    "    output: none",
  ];
}

function startIpcWatcher(ipcPath: string): fs.FSWatcher {
  return fs.watch(ipcPath, () => {
    const content = fs.readFileSync(ipcPath, "utf8").trim();
    if (!content) {
      return;
    }

    fs.writeFileSync(ipcPath, "");
    handleIpcMessage(content).then(undefined, showLazyGitError);
  });
}

async function handleIpcMessage(line: string) {
  if (line.startsWith(IPC_COMMAND_PREFIX)) {
    await handleIpcCommand(line.slice(IPC_COMMAND_PREFIX.length));
    return;
  }

  const parts = line.split("\t");
  const filePath = parts[0]?.trim();
  const lineNum = parts.length > 1 ? parseInt(parts[1], 10) : 0;

  if (!filePath) return;

  const uri = vscode.Uri.file(filePath);
  try {
    await closeLazyGitPanel();
    onHide(false);

    const doc = await vscode.workspace.openTextDocument(uri);
    const position = new vscode.Position(
      Math.max(0, lineNum > 0 ? lineNum - 1 : 0),
      0
    );
    await vscode.window.showTextDocument(doc, {
      preview: false,
      selection: new vscode.Range(position, position),
    });
  } catch {
    vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
  }
}

async function handleIpcCommand(command: string) {
  const target = WORKBENCH_VIEW_TARGETS.find(
    (viewTarget) => viewTarget.ipcCommand === command
  );
  if (target) {
    await showWorkbenchView(target.viewCommand);
  }
}

function cleanupIpc() {
  if (!ipcState) return;
  ipcState.watcher.close();
  unlinkIfExists(ipcState.ipcPath);
  unlinkIfExists(ipcState.overlayPath);
  ipcState = undefined;
}

function unlinkIfExists(filePath: string) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}

function createIpcWriteCommand(ipcPath: string, payload: string): string {
  if (process.platform === "win32") {
    return [
      "powershell",
      "-NoProfile",
      "-ExecutionPolicy Bypass",
      "-Command",
      `"Set-Content -LiteralPath ${quotePowerShell(ipcPath)} -Value ${quotePowerShell(payload)} -NoNewline"`,
    ].join(" ");
  }

  return `printf '%s\\n' ${quotePosixShell(payload)} > ${quotePosixShell(
    ipcPath
  )}`;
}

function quotePosixShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function toYamlString(value: string): string {
  return JSON.stringify(value);
}
