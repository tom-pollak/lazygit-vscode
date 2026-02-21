import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as process from "process";
import { exec } from "child_process";
import assert = require("assert");

const LAZYGIT_TOGGLE_COMMAND = "lazygit-vscode.toggle";
const LAZYGIT_CONTEXT_KEY = "lazygitFocus";

const IS_WINDOWS = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const OPEN_URI_CMD = IS_WINDOWS ? 'start ""' : IS_MAC ? "open" : "xdg-open";

let lazyGitTerminal: vscode.Terminal | undefined;
let globalConfig: LazyGitConfig;
let globalConfigJSON: string;
let extensionContext: vscode.ExtensionContext;
let lazyGitInjections: LazyGitInjectionConfig = {
  extraConfigPath: "",
  env: {}
};

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
  autoConfigLazygitEditor: "off" | "cli" | "urlScheme";
  lazygitKeybindings: KeybindingsConfig;
  autoMaximizeWindow: boolean;
  panels: PanelOptions;
  venvActivationDelay: number;
}

interface LazyGitInjectionConfig {
  extraConfigPath: string;
  env: { [key: string]: string };
}

interface KeybindingsConfig {
  toggle: string;
  quit: string;
}

function loadConfig(): LazyGitConfig {
  const config = vscode.workspace.getConfiguration("lazygit-vscode");

  // Helper function for getting panel behavior with legacy fallback
  function getPanelBehavior(panelName: string): PanelBehavior {
    const defaultValue = panelName === "secondarySidebar" ? "hide" : "keep";
    const newSetting = config.get<PanelBehavior>(
      `panels.${panelName}`,
      defaultValue
    );
    if (newSetting !== defaultValue) return newSetting;

    // Legacy fallbacks for published settings
    if (panelName === "sidebar") {
      return config.get<boolean>("autoHideSideBar", false) ? "hide" : "keep";
    } else if (panelName === "panel") {
      return config.get<boolean>("autoHidePanel", false) ? "hide" : "keep";
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
    autoConfigLazygitEditor: config.get<"off" | "cli" | "urlScheme">(
      "autoConfigLazygitEditor",
      "cli"
    ),
    lazygitKeybindings: {
      toggle: config.get<string>("lazygitKeybindings.toggle", ""),
      quit: config.get<string>("lazygitKeybindings.quit", ""),
    },
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

  // Resolve the actual Lazygit config file if we need to inject a second, VS Code-specific one
  if (requiresConfigInjection()) {
    if (!globalConfig.configPath) {
      globalConfig.configPath = await resolveImplicitLazyGitConfigPath();
      if (!globalConfig.configPath) {
        vscode.window.showErrorMessage(
          "Could not resolve LazyGit config path. Extra config won't be applied."
        );
      }
    }
    lazyGitInjections = await createLazygitInjections();
  }
}

/* --- Events --- */

export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  async function toggleLazyGit() {
    if (lazyGitTerminal) {
      if (windowFocused()) { // Hide
        closeWindow();
        onHide();
      } else { // Show
        focusWindow();
        onShown();
      }
    } else { // No lazyGitTerminal, create new one.
      await createWindow();
      onShown();
    }
  }

  const updateLazyGitFocusContext = () => {
    vscode.commands.executeCommand("setContext", LAZYGIT_CONTEXT_KEY, windowFocused());
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(LAZYGIT_TOGGLE_COMMAND, toggleLazyGit),
    vscode.window.onDidChangeActiveTextEditor(updateLazyGitFocusContext),
    vscode.window.onDidChangeActiveTerminal(updateLazyGitFocusContext),
    vscode.window.registerUriHandler(new LazygitUriHandler()),
  );
}

export function deactivate() {}

// URI handler for custom Lazygit commands
class LazygitUriHandler implements vscode.UriHandler {
  public handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
    if (uri.path === '/toggle') {
      vscode.commands.executeCommand(LAZYGIT_TOGGLE_COMMAND);
    }
  }
}

/* ---  Window --- */

async function createWindow() {
  await reloadIfConfigChange();

  const workspaceFolder = getWorkspaceFolder();

  assert(globalConfig.lazyGitPath, "Uncaught error: lazygitpath is undefined!");
  let lazyGitCommand = globalConfig.lazyGitPath;

  // Build --use-config-file: user config (if any) + generated editor config
  const configFiles: string[] = [];
  if (globalConfig.configPath) {
    configFiles.push(globalConfig.configPath);
  }
  if (lazyGitInjections.extraConfigPath) {
    configFiles.push(lazyGitInjections.extraConfigPath);
  }
  if (configFiles.length > 0) {
    lazyGitCommand += ` --use-config-file="${configFiles.join(",")}"`;
  }

  // Check if Python venv activation is enabled
  const pythonConfig = vscode.workspace.getConfiguration("python");
  const activateEnvironment = pythonConfig.get<boolean>("terminal.activateEnvironment", true);

  // Determine shellArgs based on venv activation
  // If venv activation is enabled, use empty shellArgs and send command after delay
  // Otherwise, pass command directly to shell for immediate execution
  const shellArgs = activateEnvironment
    ? []
    : IS_WINDOWS
      ? ["/c", lazyGitCommand]
      : ["-c", lazyGitCommand];

  lazyGitTerminal = vscode.window.createTerminal({
    name: "LazyGit",
    cwd: workspaceFolder,
    shellPath:
      IS_WINDOWS
        ? "powershell.exe"
        : await findExecutableOnPath("bash"),
    shellArgs: shellArgs,
    location: vscode.TerminalLocation.Editor,
    env: lazyGitInjections.env,
  });

  focusWindow();

  // If venv activation is enabled, wait for Python extension to inject activation
  // then send lazygit command
  if (activateEnvironment) {
    setTimeout(() => {
      if (lazyGitTerminal) {
        lazyGitTerminal.sendText(`${lazyGitCommand}; exit`);
      }
    }, globalConfig.venvActivationDelay);
  }

  // lazygit window closes, unlink and focus on editor (where lazygit was)
  vscode.window.onDidCloseTerminal((terminal) => {
    if (terminal === lazyGitTerminal) {
      lazyGitTerminal = undefined;
      onHide();
    }
  });
}

function windowFocused(): boolean {
  return (
    vscode.window.activeTextEditor === undefined &&
    vscode.window.activeTerminal === lazyGitTerminal
  );
}

function focusWindow() {
  assert(lazyGitTerminal, "lazyGitTerminal undefined when trying to show!");
  lazyGitTerminal.show(false); // false: take focus
}

function closeWindow() {
  const openTabs = vscode.window.tabGroups.all.flatMap(
    (group) => group.tabs
  ).length;
  if (openTabs === 1 && lazyGitTerminal) {
    // only lazygit tab, close
    lazyGitTerminal.dispose();
  } else {
    // toggle recently used tab in group
    vscode.commands.executeCommand(
      "workbench.action.openPreviousRecentlyUsedEditorInGroup"
    );
  }
}

function onShown() {
  const shouldKeep = (behavior: PanelBehavior) => behavior === "keep";
  const shouldHide = (behavior: PanelBehavior) =>
    behavior === "hide" || behavior === "hideRestore";

  if (globalConfig.autoMaximizeWindow) {
    vscode.commands.executeCommand(
      "workbench.action.maximizeEditorHideSidebar"
    );

    // maximizeEditorHideSidebar closes both sidebars. If keep is true, we need to open them again.
    if (shouldKeep(globalConfig.panels.sidebar)) {
      vscode.commands.executeCommand(
        "workbench.action.toggleSidebarVisibility"
      );
    }
    if (shouldKeep(globalConfig.panels.secondarySidebar)) {
      vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar");
      setTimeout(() => {
        vscode.commands.executeCommand(
          "workbench.action.focusActiveEditorGroup"
        );
      }, 200);
    }
  } else {
    // autoMaximizeWindow: false
    if (shouldHide(globalConfig.panels.sidebar)) {
      vscode.commands.executeCommand("workbench.action.closeSidebar");
    }

    if (shouldHide(globalConfig.panels.secondarySidebar)) {
      vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    }
  }

  // Bottom panel not affected by autoMaximizeWindow
  if (shouldHide(globalConfig.panels.panel)) {
    vscode.commands.executeCommand("workbench.action.closePanel");
  }
}

function onHide() {
  // Restore panels
  const shouldRestore = (behavior: PanelBehavior) => behavior === "hideRestore";

  if (shouldRestore(globalConfig.panels.sidebar)) {
    vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
  }

  if (shouldRestore(globalConfig.panels.secondarySidebar)) {
    vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar");
  }

  if (shouldRestore(globalConfig.panels.panel)) {
    vscode.commands.executeCommand("workbench.action.togglePanel");
  }

  // Unmaximize
  if (globalConfig.autoMaximizeWindow) {
    vscode.commands.executeCommand("workbench.action.evenEditorWidths");
  }

  // Editor Focus -- panel / auxiliaryBar will take focus so short delay required
  const timeoutValue =
    globalConfig.panels.panel === "hideRestore" ||
    globalConfig.panels.secondarySidebar === "hideRestore"
      ? 200
      : 0;
  setTimeout(() => {
    vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  }, timeoutValue);
}

/* --- Config Injection --- */

async function createLazygitInjections(): Promise<LazyGitInjectionConfig> {
  const res: LazyGitInjectionConfig = { extraConfigPath: "", env: {} };
  const parts: string[] = [];

  if (globalConfig.autoConfigLazygitEditor !== "off") {
    // Resolve editor CLI and generate lazygit edit config
    const cli = await resolveCliExecutable();
    if (!cli) {
      vscode.window.showErrorMessage(
        "Could not resolve editor CLI. Opening files with `e` will use LazyGit defaults."
      )
      return res;
    }

    if (cli !== "") {
      let edit: string;
      let editAtLine: string;

      if (globalConfig.autoConfigLazygitEditor === "urlScheme") {
        const uriScheme = vscode.env.uriScheme;
        const scriptPath = createProxyEditScript(uriScheme);
        // Store the script path in an env variable to make Lazygit command log cleaner
        res.env["EDIT"] = scriptPath;
        edit = IS_WINDOWS ? `call "%EDIT%"` : `"$EDIT"`;
        editAtLine = edit;
      } else { // "cli"
        edit = `${cli} -r`;
        editAtLine = `${cli} -rg`;
      }

      // For editAtLineAndWait, we want the command to exit when the file (as opposed to the whole
      // app) is closed. This looks possible only with CLI, so fallback to it for "urlScheme" too.
      const editAndWait = `${cli} -rgw`;

      parts.push(`os:
  edit: '${edit} {{filename}}'
  editAtLine: '${editAtLine} {{filename}}:{{line}}'
  editAtLineAndWait: '${editAndWait} {{filename}}:{{line}}'
  editInTerminal: false
  openDirInEditor: '${edit} {{dir}}'`);
    }
  }

  if (globalConfig.lazygitKeybindings.toggle) {
    parts.push(`customCommands:
  - key: '${globalConfig.lazygitKeybindings.toggle}'
    command: "${OPEN_URI_CMD} '${vscode.env.uriScheme}://${extensionContext.extension.id}/toggle'"
    context: 'global'
    description: 'Toggle Lazygit in VS Code'`);
  }

  if (globalConfig.lazygitKeybindings.quit) {
    parts.push(`keybinding:
  universal:
    quit: '${globalConfig.lazygitKeybindings.quit}'`);
  }

  const globalStorage = extensionContext.globalStorageUri.fsPath;
  const configPath = path.join(globalStorage, "lazygit-editor.yml");
  const content = parts.join('\n');

  try {
    updateFile(configPath, content);
  } catch (error) {
    vscode.window.showErrorMessage('Failed to write auto config file for Lazygit');
    return res;
  }

  res.extraConfigPath = configPath;
  return res;
}

// Generates a wrapper script that opens the URI scheme for the editor. The main reason for its
// existence is to not pollute the Lazygit command log with long commands that come with having to
// URL-encode stuff with built-in shell commands like `sed`.
function createProxyEditScript(uriScheme: string): string {
  // Rudimentary percent-encoding that is both too little (no brackets or unicode) and too much (one
  // could argue nobody in their right mind would use anything but [A-Za-z0-9.-_] in filenames).
  let filename: string;
  let opts: fs.WriteFileOptions;
  let content: string;
  if (IS_WINDOWS) {
    filename = "lazygit-open.cmd";
    opts = {};
    content = `@echo off
setlocal enabledelayedexpansion
set "P=%~1"
set "P=!P:%%=%%25!"
set "P=!P: =%%20!"
set "P=!P:#=%%23!"
set "P=!P:&=%%26!"
set "P=!P:+=%%2B!"
${OPEN_URI_CMD} "${uriScheme}://file/!P!"
`;
  } else {
    filename = "lazygit-open.sh";
    opts = { mode: 0o755 };
    content = `eval "${OPEN_URI_CMD} \\"${uriScheme}://file/$(echo "$1" | \
sed -e 's/%/%25/g' -e 's/ /%20/g' -e 's/#/%23/g' -e 's/&/%26/g' -e 's/+/%2B/g')\\""`;
  }

  const globalStorage = extensionContext.globalStorageUri.fsPath;
  const scriptPath = path.join(globalStorage, filename);
  try {
    updateFile(scriptPath, content, opts);
  } catch (error) {
    vscode.window.showErrorMessage('Failed to write proxy edit script for Lazygit');
    return "";
  }
  return scriptPath;
}

/* --- Utils --- */

// Finds the VS Code (or fork) CLI executable name
async function resolveCliExecutable(): Promise<string> {
  const lowerAppName = vscode.env.appName.toLowerCase();
  const root = vscode.env.appRoot;
  const candidates = [
    path.join(root, "bin"),
    path.join(root, "..", "bin"),
    path.join(root, "..", "..", "bin"),
    path.join(root, "..", "..", "..", "bin")
  ];

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        // It's .cmd on Windows, so drop the extension
        const name = path.parse(f).name;
        // Skip helpers like code-tunnel, cursor-tunnel,
        // and check if the names match to be extra sure
        if (!name.includes("-") && lowerAppName.includes(name)) {
          // It should be OK to return just the executable name - it's going
          // to look nice and concise in Lazygit's command log
          try {
            await findExecutableOnPath(f);
            return f;
          } catch (error) {
            vscode.window.showErrorMessage(`Executable ${f} found, but not on PATH`);
            return "";
          }
        }
      }
    }
  }
  return "";
}

function requiresConfigInjection(): boolean {
  return globalConfig.autoConfigLazygitEditor !== "off"
    || Object.values(globalConfig.lazygitKeybindings).some(Boolean);
}

// Finds the actual config path that Lazygit uses if --use-config-file is not provided.
// We'll need to specify it explicitly if we want to add an extra VS Code-specific config file.
async function resolveImplicitLazyGitConfigPath(): Promise<string> {
  // Check LG_CONFIG_FILE env var first, then fallback to lazygit -cd
  const envConfigPath = process.env.LG_CONFIG_FILE;
  if (envConfigPath && fs.existsSync(envConfigPath)) {
    return envConfigPath;
  } else {
    try {
      const dir = await getLazyGitConfigDir();
      const filepath = path.join(dir, "config.yml");
      if (fs.existsSync(filepath)) {
        return filepath;
      }
    } catch (error) {
      // Unable, will default to empty string
    }
  }
  return "";
}

function getLazyGitConfigDir(): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`"${globalConfig.lazyGitPath}" -cd`, (error, stdout) => {
      if (error)
        reject(new Error("Could not determine lazygit config directory"));
      else resolve(stdout.trim());
    });
  });
}

function updateFile(filePath: string, content: string, opts?: fs.WriteFileOptions) {
  // Check existing file content and avoid writing if unchanged
  if (fs.existsSync(filePath)) {
    const oldContent = fs.readFileSync(filePath, 'utf-8');
    if (oldContent === content) {
      return;
    }
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  fs.writeFileSync(filePath, content, opts);
}

function findExecutableOnPath(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const workspaceFolder = getWorkspaceFolder();
    const command =
      IS_WINDOWS
        ? `where ${executable}`
        : `cd "${workspaceFolder}" && which ${executable}`;
    exec(command, (error, stdout) => {
      if (error) reject(new Error(`${executable} not found on PATH`));
      else resolve(stdout.trim());
    });
  });
}

function expandPath(pth: string): string {
  pth = pth.replace(/^~(?=$|\/|\\)/, os.homedir());
  if (IS_WINDOWS) {
    pth = pth.replace(/%([^%]+)%/g, (_, n) => process.env[n] || "");
  } else {
    pth = pth.replace(/\$([A-Za-z0-9_]+)/g, (_, n) => process.env[n] || "");
  }
  return pth;
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
