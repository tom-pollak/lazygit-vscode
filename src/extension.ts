import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import { exec } from "child_process";

let lazyGitTerminal: vscode.Terminal | undefined;
let globalConfigJSON: string;
let globalConfig: LazyGitConfig;

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

function findLazyGitOnPath(): Promise<string> {
  return new Promise((resolve, reject) => {
    const command =
      process.platform === "win32" ? "where lazygit" : "which lazygit";
    exec(command, (error, stdout) => {
      if (error) reject(new Error("LazyGit not found on PATH"));
      else resolve(stdout.trim());
    });
  });
}

export async function activate(context: vscode.ExtensionContext) {
  globalConfig = loadConfig();
  globalConfigJSON = JSON.stringify(globalConfig);

  // Validate lazyGitPath
  if (!globalConfig.lazyGitPath) {
    try {
      globalConfig.lazyGitPath = await findLazyGitOnPath();
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

  let disposable = vscode.commands.registerCommand(
    "lazygit-vscode.toggle",
    async () => {
      if (lazyGitTerminal) {
        if (terminalFocused(lazyGitTerminal)) {
          hideTerminal(lazyGitTerminal);
        } else {
          await onShown();
          showAndFocusTerminal(lazyGitTerminal);
        }
      } else {
        await onShown();
        await createWindow();
      }
    }
  );

  context.subscriptions.push(disposable);
}

function terminalFocused(terminal: vscode.Terminal): boolean {
  return (
    vscode.window.activeTextEditor === undefined &&
    vscode.window.activeTerminal === terminal
  );
}

function showAndFocusTerminal(terminal: vscode.Terminal) {
  terminal.show(false); // take focus
}

function hideTerminal(terminal: vscode.Terminal) {
  const openTabs = vscode.window.tabGroups.all.flatMap(
    (group) => group.tabs
  ).length;
  if (openTabs === 1 && lazyGitTerminal) {
    // only lazygit tab, close
    lazyGitTerminal.dispose();
    lazyGitTerminal = undefined;
  } else {
    // toggle recently used tab
    vscode.commands.executeCommand(
      "workbench.action.openPreviousRecentlyUsedEditor"
    );
  }
}

async function onShown() {
  await reloadIfConfigChange();

  if (globalConfig.autoHideSideBar) {
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
  }
  if (globalConfig.autoHidePanel) {
    await vscode.commands.executeCommand("workbench.action.closePanel");
  }
}

async function reloadExtension() {
  await vscode.commands.executeCommand("workbench.action.restartExtensionHost");
}

async function reloadIfConfigChange() {
  const currentConfig = loadConfig();
  if (JSON.stringify(currentConfig) !== globalConfigJSON) {
    const reload = await vscode.window.showInformationMessage(
      "LazyGit configuration has changed. Reload now?",
      "Yes",
      "No"
    );
    if (reload === "Yes") {
      await reloadExtension();
    }
  }
}

async function createWindow() {
  let workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!workspaceFolder) workspaceFolder = os.homedir();

  if (!globalConfig.lazyGitPath) {
    vscode.window.showErrorMessage("Uncaught error: lazygitpath is undefined!");
    return;
  }

  let lazyGitCommand = globalConfig.lazyGitPath;

  if (globalConfig.configPath) {
    lazyGitCommand += ` --use-config-file="${globalConfig.configPath}"`;
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
  });

  showAndFocusTerminal(lazyGitTerminal);

  vscode.window.onDidCloseTerminal((terminal) => {
    if (terminal === lazyGitTerminal) {
      lazyGitTerminal = undefined;
      vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    }
  });
}

export function deactivate() {}
