import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';

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
    const openTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).length;
    if (openTabs == 1 && lazyGitTerminal) {
        lazyGitTerminal.dispose();
        lazyGitTerminal = undefined;
        isLazyGitVisible = false;
    } else {
        await vscode.commands.executeCommand('workbench.action.previousEditor');
    }
}

function findLazyGitOnPath(): Promise<string> {
    return new Promise((resolve, reject) => {
        const command = process.platform === 'win32' ? 'where lazygit' : 'which lazygit';
        exec(command, (error, stdout) => {
            if (error) reject(new Error('LazyGit not found on PATH'));
            else resolve(stdout.trim());
        });
    });
}

async function createWindow() {
    let workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (!workspaceFolder) workspaceFolder = os.homedir();

    const config = vscode.workspace.getConfiguration('lazygit-vscode');
    let lazyGitPath = config.get<string>('lazyGitPath');
    if (!lazyGitPath) {
        try {
            lazyGitPath = await findLazyGitOnPath();
        } catch (error) {
            vscode.window.showErrorMessage('LazyGit not found in config or on PATH. Please check your settings.');
            return;
        }
    }

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
}

export function deactivate() {
}
