import * as vscode from 'vscode';
import * as fs from 'fs';

let lazyGitTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('LazyGit extension is now active!');

    let disposable = vscode.commands.registerCommand('lazygit-vscode.toggleLazyGit', async () => {
        console.log('Toggle LazyGit command triggered');

        if (lazyGitTerminal) {
            if (isTerminalVisible(lazyGitTerminal)) {
                console.log('LazyGit terminal is visible, hiding it');
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                lazyGitTerminal = undefined;
            } else {
                console.log('LazyGit terminal exists but is not visible, showing it');
                showAndFocusTerminal(lazyGitTerminal);
            }
        } else {
            console.log('Creating new LazyGit terminal');
            await createLazyGitTerminal();
        }
    });

    context.subscriptions.push(disposable);
}

function isTerminalVisible(terminal: vscode.Terminal): boolean {
    return vscode.window.activeTerminal === terminal;
}

function showAndFocusTerminal(terminal: vscode.Terminal) {
    terminal.show(true);
    vscode.commands.executeCommand('workbench.action.terminal.focus');
}

async function createLazyGitTerminal() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (workspaceFolder) {
        const config = vscode.workspace.getConfiguration('lazygit-vscode');
        let lazyGitPath = config.get<string>('lazyGitPath') || '/opt/homebrew/bin/lazygit';

        if (!fs.existsSync(lazyGitPath)) {
            console.log(`LazyGit not found at ${lazyGitPath}`);
            vscode.window.showErrorMessage(`LazyGit not found at ${lazyGitPath}. Please check your settings.`);
            return;
        }

        console.log(`Creating LazyGit terminal with path: ${lazyGitPath}`);
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
                console.log('LazyGit terminal closed');
                lazyGitTerminal = undefined;
            }
        });
    } else {
        console.log('No workspace folder found');
        vscode.window.showErrorMessage('No workspace folder found. Please open a folder and try again.');
    }
}

export function deactivate() {
    console.log('LazyGit extension is now deactivated');
}
