import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import { exec } from "child_process";

let lazyGitTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand(
    "lazygit-vscode.toggle",
    async () => {
      if (lazyGitTerminal) {
          showAndFocusTerminal(lazyGitTerminal);
      } else {
        await createWindow();
      }
    }
  );

  context.subscriptions.push(disposable);
}

function showAndFocusTerminal(terminal: vscode.Terminal) {
  terminal.show(true);
  vscode.commands.executeCommand("workbench.action.terminal.focus");
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

async function createWindow() {
  let workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!workspaceFolder) workspaceFolder = os.homedir();

  const config = vscode.workspace.getConfiguration("lazygit-vscode");
  let lazyGitPath = config.get<string>("lazygitPath");
  if (!lazyGitPath) {
    try {
      lazyGitPath = await findLazyGitOnPath();
    } catch (error) {
      vscode.window.showErrorMessage(
        "LazyGit not found in config or on PATH. Please check your settings."
      );
      return;
    }
  }

  if (!fs.existsSync(lazyGitPath)) {
    vscode.window.showErrorMessage(
      `LazyGit not found at ${lazyGitPath}. Please check your settings.`
    );
    return;
  }

  lazyGitTerminal = vscode.window.createTerminal({
    name: "LazyGit",
    cwd: workspaceFolder,
    shellPath: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
    shellArgs:
      process.platform === "win32" ? ["/c", lazyGitPath] : ["-c", lazyGitPath],
    location: vscode.TerminalLocation.Editor,
  });

  showAndFocusTerminal(lazyGitTerminal);

  // Monitor the terminal for closure
  vscode.window.onDidCloseTerminal((terminal) => {
    if (terminal === lazyGitTerminal) {
      lazyGitTerminal = undefined;
      vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    }
  });
}

export function deactivate() {}
