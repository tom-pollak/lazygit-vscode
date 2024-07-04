import * as vscode from 'vscode';
import * as fs from 'fs';

let lazyGitTerminal: vscode.Terminal | undefined;
let isLazyGitVisible = false;

export function activate(context: vscode.ExtensionContext) {

    let disposable = vscode.commands.registerCommand('lazygit-vscode.toggleLazyGit', async () => {

        if (lazyGitTerminal) {
            if (isLazyGitVisible) {
                await hideWindow();
                isLazyGitVisible = false;
            } else {
                showAndFocusTerminal(lazyGitTerminal);
                isLazyGitVisible = true;
            }
        } else {
            await createWindow();
            isLazyGitVisible = true;
        }
    });

    context.subscriptions.push(disposable);
}

function showAndFocusTerminal(terminal: vscode.Terminal) {
    terminal.show(true);
    vscode.commands.executeCommand('workbench.action.terminal.focus');
}

async function hideWindow() {
    // Switch to the previous editor group
    await vscode.commands.executeCommand('workbench.action.previousEditor');
}

async function createWindow() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (workspaceFolder) {
        const config = vscode.workspace.getConfiguration('lazygit-vscode');
        let lazyGitPath = config.get<string>('lazyGitPath') || '/opt/homebrew/bin/lazygit';

        if (!fs.existsSync(lazyGitPath)) {
            vscode.window.showErrorMessage(`LazyGit not found at ${lazyGitPath}. Please check your settings.`);
            return;
        }

        lazyGitTerminal = vscode.window.createTerminal({
            name: "LazyGit",
            cwd: workspaceFolder,
            shellPath: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
            shellArgs: process.platform === 'win32' ? ['/c', lazyGitPath] : ['-c', lazyGitPath],
            location: vscode.TerminalLocation.Editor
        });

        showAndFocusTerminal(lazyGitTerminal);

        // Monitor the terminal for closure
        vscode.window.onDidCloseTerminal(terminal => {
            if (terminal === lazyGitTerminal) {
                lazyGitTerminal = undefined;
                isLazyGitVisible = false;
            }
        });
    } else {
        vscode.window.showErrorMessage('No workspace folder found. Please open a folder and try again.');
    }
}

export function deactivate() {
}
