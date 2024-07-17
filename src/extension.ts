import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { exec } from "child_process";
import assert = require("assert");

let lazyGitTerminal: vscode.Terminal | undefined;
let globalConfig: LazyGitConfig;
let globalConfigJSON: string;

/* --- Config --- */

interface LazyGitConfig {
  autoHideSideBar: boolean;
  autoHidePanel: boolean;
  lazyGitPath: string;
  configPath: string;
}

function loadConfig(): LazyGitConfig {
  const config = vscode.workspace.getConfiguration("lazygit-vscode");
  return {
    autoHideSideBar: config.get<boolean>("autoHideSideBar", false),
    autoHidePanel: config.get<boolean>("autoHidePanel", false),
    lazyGitPath: config.get<string>("lazygitPath", ""),
    configPath: config.get<string>("configPath", ""),
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

  // Validate lazyGitPath
  if (!globalConfig.lazyGitPath) {
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

  // Validate configPath
  if (globalConfig.configPath && !fs.existsSync(globalConfig.configPath)) {
    vscode.window.showWarningMessage(
      `Custom config file not found at ${globalConfig.configPath}. The default config will be used.`
    );
    globalConfig.configPath = "";
  }
}

/* --- Events --- */

export async function activate(context: vscode.ExtensionContext) {
  loadExtension();

  let disposable = vscode.commands.registerCommand(
    "lazygit-vscode.toggle",
    async () => {
      if (lazyGitTerminal) {
        if (windowFocused()) {
          closeWindow();
        } else {
          focusWindow();
          await onShown();
        }
      } else {
        await createWindow();
        await onShown();
      }
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}

/* ---  Window --- */

async function createWindow() {
  await reloadIfConfigChange();

  let workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!workspaceFolder) workspaceFolder = os.homedir();

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
    shellPath: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
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
      vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
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
    // toggle recently used tab
    vscode.commands.executeCommand(
      "workbench.action.openPreviousRecentlyUsedEditor"
    );
  }
}

function onShown() {
  if (globalConfig.autoHideSideBar) {
    vscode.commands.executeCommand("workbench.action.closeSidebar");
  }
  if (globalConfig.autoHidePanel) {
    vscode.commands.executeCommand("workbench.action.closePanel");
  }
}

/* --- Utils --- */

function findExecutableOnPath(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const command =
      process.platform === "win32"
        ? `where ${executable}`
        : `which ${executable}`;
    exec(command, (error, stdout) => {
      if (error) reject(new Error(`${executable} not found on PATH`));
      else resolve(stdout.trim());
    });
  });
}
