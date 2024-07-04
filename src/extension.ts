import * as vscode from 'vscode';
import * as fs from 'fs';

let lazyGitTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('LazyGit extension is now active!');

    let disposable = vscode.commands.registerCommand('lazygit-vscode.toggleLazyGit', () => {
        if (lazyGitTerminal) {
            lazyGitTerminal.dispose();
            lazyGitTerminal = undefined;
        } else {
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
                    shellArgs: process.platform === 'win32' ? ['/c', lazyGitPath] : ['-c', `${lazyGitPath}`],
                    location: vscode.TerminalLocation.Editor
                });
                lazyGitTerminal.show(true);

                // Monitor the terminal for closure
                vscode.window.onDidCloseTerminal(terminal => {
                    if (terminal === lazyGitTerminal) {
                        lazyGitTerminal = undefined;
                    }
                });
            } else {
                vscode.window.showErrorMessage('No workspace folder found. Please open a folder and try again.');
            }
        }
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}
