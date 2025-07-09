# LazyGit for VSCode

Native integration of LazyGit directly in a VSCode window (not an integrated terminal)

https://github.com/tom-pollak/lazygit-vscode/assets/26611948/5924db82-7937-4ed9-96ad-07963af4b56e

## Features

- Toggle LazyGit in the full-screen editor within VSCode
- Use a keyboard shortcut to quickly open or close LazyGit
- Use `e` or `o` to open a file in a new tab from the lazygit window

## VSCode integration

Set the following in your [LazyGit config](https://github.com/jesseduffield/lazygit/blob/master/docs/Config.md) for VSCode support:

```yaml
os:
  editPreset: "vscode"
promptToReturnFromSubprocess: false # removes "press enter to return to lazygit" popup
```

This allows a [pretty slick](https://github.com/jesseduffield/lazygit/blob/master/docs/Config.md#configuring-file-editing) experience opening windows with `e`

> If you prefer to use a different tool on the cli, you can configure a custom LazyGit config for VSCode with `lazygit-vscode.configPath`

### Notes on Windows

Default cmd is ctrl+shift+l which may be captured by the shell. Ensure the following config

```javascript
  "terminal.integrated.sendKeybindingsToShell": false, // ensure this is false
  "terminal.integrated.commandsToSkipShell": ["lazygit-vscode.toggle", "workbench.action.closeWindow"], // add this
```

## Requirements

- LazyGit must be installed on your system and accessible in your PATH (or set with `lazygit-vscode.lazygitPath`). You can find installation instructions for LazyGit [here](https://github.com/jesseduffield/lazygit#installation).

## Usage

Use the keyboard shortcut `Ctrl+Shift+L` (or `Cmd+Shift+L` on macOS) to toggle LazyGit

- `lazygit-vscode.toggle`: Toggle LazyGit
- `lazygitFocus`: When clause for your keybindings.

## Extension Settings

### Basic Configuration

- `lazygit-vscode.lazygitPath`: Manually set LazyGit path. Otherwise use default system PATH.
- `lazygit-vscode.configPath`: Set custom LazyGit config. Useful if you like different behaviour between VSCode and CLI.
- `lazygit-vscode.autoMaximizeWindow`: Maximize the lazygit window in the editor (keeps sidebar visible). Useful when working with split editors.

### Panel Behavior

You can control how LazyGit interacts with VS Code UI panels using the `panels` setting. Each panel can be set to:

- `"keep"`: Leave panel as is (default)
- `"hide"`: Hide the panel when showing LazyGit
- `"hideRestore"`: Hide the panel when showing LazyGit and restore it when closing

Example configuration:

```json
"lazygit-vscode.panels": {
  "sidebar": "hideRestore",
  "panel": "hide",
  "secondarySidebar": "keep"
}
```

#### Available Panels

- `lazygit-vscode.panels.sidebar`: Primary sidebar (Explorer, Source Control, etc.)
- `lazygit-vscode.panels.panel`: Bottom panel (Terminal, Output, etc.)
- `lazygit-vscode.panels.secondarySidebar`: Secondary sidebar (usually on the right side)

> Note: Legacy settings `autoHideSideBar` and `autoHidePanel` are still supported but deprecated.

For settings to be applied, LazyGit window must be restarted (`q`).

## More info

> [LazyGit](https://github.com/jesseduffield/lazygit)
