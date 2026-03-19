import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as process from "process";
import { exec } from "child_process";
import assert = require("assert");

const LAZYGIT_TOGGLE_COMMAND = "lazygit-vscode.toggle";
const LAZYGIT_CONTEXT_KEY = "lazygitFocus";

let lazyGitTerminal: vscode.Terminal | undefined;
let globalConfig: LazyGitConfig;
let globalConfigJSON: string;
let ipcState: { ipcPath: string; overlayPath: string } | undefined;

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
    nativeFileOpening: config.get<boolean>("nativeFileOpening", true),
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
  );
}

export function deactivate() {
  cleanupIpc();
}

/* ---  Window --- */

async function createWindow() {
  await reloadIfConfigChange();

  const workspaceFolder = getWorkspaceFolder();

  assert(globalConfig.lazyGitPath, "Uncaught error: lazygitpath is undefined!");

  // Set up IPC for native file opening, or fall back to code CLI
  cleanupIpc();
  let configFileArg: string | undefined;
  const env: { [key: string]: string } = {};

  if (globalConfig.nativeFileOpening) {
    const ipc = setupIpc();
    ipcState = ipc;
    configFileArg = ipc.configFileArg;
    startIpcWatcher(ipc.ipcPath);
  } else {
    // Legacy: find 'code' CLI and add to PATH for lazygit's editPreset
    try {
      const codePath = await findExecutableOnPath("code");
      env.PATH = `${path.dirname(codePath)}${path.delimiter}${process.env.PATH}`;
    } catch {
      vscode.window.showWarningMessage(
        "Could not find 'code' on PATH. Set `editPreset: \"vscode\"` in your lazygit config and ensure 'code' is available, or enable `lazygit-vscode.nativeFileOpening`."
      );
    }
    if (globalConfig.configPath) {
      configFileArg = globalConfig.configPath;
    }
  }

  // Check if Python venv activation is enabled
  const pythonConfig = vscode.workspace.getConfiguration("python");
  const activateEnvironment = pythonConfig.get<boolean>("terminal.activateEnvironment", true);

  if (activateEnvironment) {
    // Use default shell so Python extension can inject venv activation
    let lazyGitCommand = `"${globalConfig.lazyGitPath}"`;
    if (configFileArg) {
      lazyGitCommand += ` --use-config-file="${configFileArg}"`;
    }

    lazyGitTerminal = vscode.window.createTerminal({
      name: "LazyGit",
      cwd: workspaceFolder,
      location: vscode.TerminalLocation.Editor,
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
      location: vscode.TerminalLocation.Editor,
      env: env,
    });

    focusWindow();
  }

  // lazygit window closes, unlink and focus on editor (where lazygit was)
  vscode.window.onDidCloseTerminal((terminal) => {
    if (terminal === lazyGitTerminal) {
      lazyGitTerminal = undefined;
      cleanupIpc();
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

/* --- Utils --- */

function findExecutableOnPath(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const workspaceFolder = getWorkspaceFolder();
    const command =
      process.platform === "win32"
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
  if (process.platform === "win32") {
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

/* --- IPC File Opening --- */

function getDefaultLazygitConfigPath(): string {
  switch (process.platform) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "lazygit", "config.yml");
    case "win32":
      return path.join(process.env.APPDATA || "", "lazygit", "config.yml");
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "lazygit", "config.yml"
      );
  }
}

function setupIpc(): { ipcPath: string; overlayPath: string; configFileArg: string } {
  const tmpDir = os.tmpdir();
  const suffix = `${Date.now()}-${process.pid}`;

  const ipcPath = path.join(tmpDir, `lazygit-vscode-ipc-${suffix}.tmp`);
  fs.writeFileSync(ipcPath, "");

  // Read the user's os config so we can preserve their settings.
  // Lazygit does a shallow merge on the os section, so our overlay would wipe out
  // editAtLineAndWait, editInTerminal, openDirInEditor, etc. if we don't include them.
  const userOsFields = getUserOsConfig();
  const osFields: Record<string, string> = { ...userOsFields };
  osFields.edit = `'printf "%s\\t0\\n" "{{filename}}" >> "${ipcPath}"'`;
  osFields.editAtLine = `'printf "%s\\t%s\\n" "{{filename}}" "{{line}}" >> "${ipcPath}"'`;

  const overlayLines = ["os:"];
  for (const [key, value] of Object.entries(osFields)) {
    overlayLines.push(`  ${key}: ${value}`);
  }
  overlayLines.push("promptToReturnFromSubprocess: false");
  const overlayYaml = overlayLines.join("\n") + "\n";

  const overlayPath = path.join(tmpDir, `lazygit-vscode-config-${suffix}.yml`);
  fs.writeFileSync(overlayPath, overlayYaml);

  // --use-config-file replaces the default config, so include user/default config first,
  // then overlay last (takes priority via lazygit's comma-separated merge)
  const configFiles: string[] = [];
  if (globalConfig.configPath) {
    configFiles.push(globalConfig.configPath);
  } else {
    const defaultPath = getDefaultLazygitConfigPath();
    if (fs.existsSync(defaultPath)) {
      configFiles.push(defaultPath);
    }
  }
  configFiles.push(overlayPath);

  return { ipcPath, overlayPath, configFileArg: configFiles.join(",") };
}

function getUserOsConfig(): Record<string, string> {
  const configPath = globalConfig.configPath || getDefaultLazygitConfigPath();
  if (!configPath || !fs.existsSync(configPath)) return {};

  try {
    const content = fs.readFileSync(configPath, "utf8");
    return parseOsSection(content);
  } catch {
    return {};
  }
}

function parseOsSection(content: string): Record<string, string> {
  const lines = content.split("\n");
  const fields: Record<string, string> = {};
  let inOs = false;

  for (const line of lines) {
    if (/^os:/.test(line)) {
      inOs = true;
      continue;
    }
    if (inOs) {
      // New top-level key — end of os section
      if (/^\S/.test(line) && line.trim() !== "") break;
      const match = line.match(/^\s+(\w+):\s*(.+)/);
      if (match) {
        fields[match[1]] = match[2];
      }
    }
  }

  return fields;
}

function startIpcWatcher(ipcPath: string) {
  let bytesRead = 0;

  fs.watchFile(ipcPath, { interval: 100 }, (curr) => {
    if (curr.size > bytesRead) {
      try {
        const fd = fs.openSync(ipcPath, "r");
        const buf = Buffer.alloc(curr.size - bytesRead);
        fs.readSync(fd, buf, 0, buf.length, bytesRead);
        fs.closeSync(fd);
        bytesRead = curr.size;

        const lines = buf.toString("utf8").trim().split("\n").filter((l) => l.trim());
        for (const line of lines) {
          handleIpcMessage(line);
        }
      } catch {
        // File might have been deleted during cleanup
      }
    }
  });
}

function handleIpcMessage(line: string) {
  const parts = line.split("\t");
  const filePath = parts[0]?.trim();
  const lineNum = parts.length > 1 ? parseInt(parts[1], 10) : 0;

  if (!filePath) return;

  const uri = vscode.Uri.file(filePath);
  vscode.workspace.openTextDocument(uri).then(
    (doc) => {
      const position = new vscode.Position(Math.max(0, lineNum > 0 ? lineNum - 1 : 0), 0);
      vscode.window.showTextDocument(doc, {
        preview: false,
        selection: new vscode.Range(position, position),
      });
    },
    () => {
      vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
    }
  );
}

function cleanupIpc() {
  if (!ipcState) return;
  fs.unwatchFile(ipcState.ipcPath);
  try { fs.unlinkSync(ipcState.ipcPath); } catch {}
  try { fs.unlinkSync(ipcState.overlayPath); } catch {}
  ipcState = undefined;
}
