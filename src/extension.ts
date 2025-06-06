import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as process from "process";
import { exec } from "child_process";
import assert = require("assert");

let lazyGitTerminal: vscode.Terminal | undefined;
let globalConfig: LazyGitConfig;
let globalConfigJSON: string;

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
  let disposable = vscode.commands.registerCommand(
    "lazygit-vscode.toggle",
    async () => {
      if (lazyGitTerminal) {
        if (windowFocused()) {
          closeWindow();
          onHide();
        } else {
          focusWindow();
          onShown();
        }
      } else {
        await createWindow();
        onShown();
      }
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}

/* ---  Window --- */

async function createWindow() {
  await reloadIfConfigChange();

  const workspaceFolder = getWorkspaceFolder();

  assert(globalConfig.lazyGitPath, "Uncaught error: lazygitpath is undefined!");
  let lazyGitCommand = globalConfig.lazyGitPath;
  if (globalConfig.configPath) {
    lazyGitCommand += ` --use-config-file="${globalConfig.configPath}"`;
  }

  const env: { [key: string]: string } = {};
  try {
    let codePath = await findExecutableOnPath("code");
    env.PATH = `"${codePath}"${path.delimiter}${process.env.PATH}`;
  } catch (error) {
    vscode.window.showWarningMessage(
      "Could not find 'code' on PATH. Opening vscode windows with `e` may not work properly."
    );
  }

  lazyGitTerminal = vscode.window.createTerminal({
    name: "LazyGit",
    cwd: workspaceFolder,
    shellPath:
      process.platform === "win32"
        ? "powershell.exe"
        : await findExecutableOnPath("bash"),
    shellArgs:
      process.platform === "win32"
        ? ["/c", lazyGitCommand]
        : ["-c", lazyGitCommand],
    location: vscode.TerminalLocation.Editor,
    env: env,
  });

  focusWindow();

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

/* --- Utils --- */

function findExecutableOnPath(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const workspaceFolder = getWorkspaceFolder();
    const command =
      process.platform === "win32"
        ? `where ${executable}`
        : `cd ${workspaceFolder} && which ${executable}`;
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
  let workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!workspaceFolder) workspaceFolder = os.homedir();
  return workspaceFolder;
}
