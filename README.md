# LazyGit for VSCode

Native integration of LazyGit in a maximized VSCode terminal panel.

https://github.com/tom-pollak/lazygit-vscode/assets/26611948/5924db82-7937-4ed9-96ad-07963af4b56e

## Features

- Open LazyGit from the VSCode status bar
- Toggle LazyGit in a maximized terminal panel within VSCode
- Use a keyboard shortcut to quickly open or close LazyGit
- Use `e` or `o` to open a file in a new tab from the lazygit window

## VSCode integration

File opening works out of the box -- pressing `e` in lazygit opens files directly in VSCode. No manual lazygit config is needed.

Under the hood, the extension automatically configures lazygit's edit commands via an overlay config, using IPC to open files through the VSCode API instead of the `code` CLI.

To disable this and fall back to the `code` CLI approach, set `lazygit-vscode.nativeFileOpening` to `false` and configure your [lazygit config](https://github.com/jesseduffield/lazygit/blob/master/docs/Config.md) manually:

```yaml
os:
  editPreset: "vscode"
promptToReturnFromSubprocess: false
```

> You can use `lazygit-vscode.configPath` to set a separate lazygit config for VSCode if you prefer different behaviour between VSCode and CLI.

### Known Issues

#### Sidebar show/hide inconsistencies

VSCode doesn't offer an API for checking sidebar visibility ([issue](https://github.com/microsoft/vscode/issues/186581)), so `lazygit-vscode.panels` sidebar settings may cause inconsistencies:

- `hideRestore` will always restore the sidebar on close, even if it was already hidden
- The primary and secondary sidebars are always hidden while LazyGit is shown

Use `hideRestore` only if you want a sidebar restored when LazyGit closes.

Created VSCode issue to track: https://github.com/microsoft/vscode/issues/283331

#### Python virtualenv

**Python virtualenv interference**: If `python.terminal.activateEnvironment` is true in the settings, this extension will delay the launch of LazyGit by a fixed time, allowing vscode to start the python virtualenv. The delay is configurable via `lazygit-vscode.venvActivationDelay` (default: 200ms). If you still experience issues, you can:

1. Increase the delay setting if your environment takes longer to activate
2. Disable automatic Python activation in terminals:

```json
"python.terminal.activateEnvironment": false
```

#### Integrated shell keybindings

The extension contributes its LazyGit commands to `terminal.integrated.commandsToSkipShell`, so the default shortcuts should be handled by VSCode instead of being sent to LazyGit. If you override terminal keyboard behavior globally, keep this setting compatible:

```javascript
  "terminal.integrated.sendKeybindingsToShell": false
```

Terminals do not reliably preserve `Shift` on control-letter shortcuts. Depending on the OS, input method, and VSCode terminal layer, `Ctrl+Shift+E`/`Ctrl+Shift+F`/`Ctrl+Shift+D`/`Ctrl+Shift+X` may either be consumed before LazyGit sees them or arrive as plain control-letter keys. The extension enables `lazygit-vscode.terminalKeybindingFallback` by default to inject temporary LazyGit custom commands for `Ctrl+E`, `Ctrl+F`, `Ctrl+D`, and `Ctrl+X` while LazyGit is launched from VSCode. Disable that setting if you need LazyGit's original control-letter behavior.

The extension also binds `Ctrl+E`, `Ctrl+F`, `Ctrl+D`, and `Ctrl+X` directly while the VSCode terminal is focused on LazyGit. This is scoped to LazyGit only and is intended to catch terminals that normalize shifted control-letter shortcuts before VSCode can resolve the original keybinding.

## Requirements

- LazyGit must be installed on your system and accessible in your PATH (or set with `lazygit-vscode.lazygitPath`). You can find installation instructions for LazyGit [here](https://github.com/jesseduffield/lazygit#installation).

## Usage

Use the `LazyGit` status bar item to open LazyGit, or use the keyboard shortcut `Ctrl+Shift+L` (or `Cmd+Shift+L` on macOS) to toggle LazyGit. LazyGit opens in the terminal panel; the extension moves the panel to the bottom, center-aligns it, and maximizes it to push the editor area out of the way.

- `lazygit-vscode.open`: Open LazyGit
- `lazygit-vscode.toggle`: Toggle LazyGit
- `lazygit-vscode.showExplorer`: Hide LazyGit and show Explorer
- `lazygit-vscode.showSearch`: Hide LazyGit and show Search
- `lazygit-vscode.showDebug`: Hide LazyGit and show Run and Debug
- `lazygit-vscode.showExtensions`: Hide LazyGit and show Extensions
- `lazygitFocus`: When clause for your keybindings.

When LazyGit has terminal focus, use `Ctrl+E` to show Explorer, `Ctrl+F` to show Search, `Ctrl+D` to show Run and Debug, and `Ctrl+X` to show Extensions. Outside the LazyGit terminal, the normal VSCode shortcuts keep their default behavior.

Because LazyGit runs in VSCode's terminal panel, VSCode still shows terminal panel chrome such as the panel tabs and terminal list. Extensions cannot make the terminal panel a fully standalone surface.

Clicking VSCode's built-in Activity Bar icons uses internal workbench commands that extensions cannot intercept. Use the LazyGit keyboard commands above when you want LazyGit to close before opening Explorer, Search, Run and Debug, or Extensions.

## Local development

To test the extension locally before publishing or opening a PR:

1. Run `npm ci`
2. Run `npm run compile`
3. Launch an Extension Development Host from this repository:

```bash
code --extensionDevelopmentPath="$(pwd)" --new-window .
```

This opens a separate VSCode window with this workspace loaded as the extension under test. Use that new window to verify the LazyGit status bar item and `Ctrl+Shift+L` behavior.

Do not use `Developer: Debug Extension Host` for this flow; that command debugs the current VSCode extension host and does not launch this repository as a development extension.

## Extension Settings

### Basic Configuration

- `lazygit-vscode.nativeFileOpening`: Automatically handle file opening from lazygit via IPC (default: `true`). When enabled, pressing `e` opens files directly in VSCode without needing `code` on PATH or `editPreset: "vscode"` in your lazygit config. Set to `false` to fall back to the `code` CLI approach.
- `lazygit-vscode.terminalKeybindingFallback`: Inject temporary LazyGit custom commands for `Ctrl+E`, `Ctrl+F`, `Ctrl+D`, and `Ctrl+X` so VSCode view shortcuts still work when VSCode's terminal sends control-letter shortcuts into LazyGit (default: `true`).
- `lazygit-vscode.lazygitPath`: Manually set LazyGit path. Otherwise use default system PATH.
- `lazygit-vscode.configPath`: Set custom LazyGit config. Useful if you like different behaviour between VSCode and CLI.
- `lazygit-vscode.autoMaximizeWindow`: Deprecated. LazyGit now opens in a maximized terminal panel.
- `lazygit-vscode.venvActivationDelay`: Delay in milliseconds to wait for Python virtual environment activation before launching lazygit (default: 200). Increase this value if your Python environment takes longer to activate.

### Panel Behavior

LazyGit always hides the primary and secondary sidebars while shown. You can control whether each sidebar is restored when LazyGit closes:

- `"keep"`: Do not restore the sidebar when LazyGit closes
- `"hide"`: Do not restore the sidebar when LazyGit closes
- `"hideRestore"`: Restore the sidebar when LazyGit closes

The `panel` option is deprecated because LazyGit now runs in the terminal panel.

Example configuration:

```json
"lazygit-vscode.panels": {
  "sidebar": "hideRestore",
  "secondarySidebar": "keep"
}
```

#### Available Panels

- `lazygit-vscode.panels.sidebar`: Primary sidebar (Explorer, Source Control, etc.)
- `lazygit-vscode.panels.panel`: Deprecated. LazyGit now runs in the terminal panel, so this setting is ignored.
- `lazygit-vscode.panels.secondarySidebar`: Secondary sidebar (usually on the right side)

> Note: Legacy settings `autoHideSideBar` and `autoHidePanel` are still supported but deprecated.

For settings to be applied, LazyGit window must be restarted (`q`).

## More info

> [LazyGit](https://github.com/jesseduffield/lazygit)
