# LazyGit for VSCode

Native integration of LazyGit directly in a VSCode window (not an integrated terminal)

https://github.com/tom-pollak/lazygit-vscode/assets/26611948/10574237-e127-4a32-956f-31bd994191eb

## Features

- Toggle LazyGit in the full-screen editor within VSCode
- Use a keyboard shortcut to quickly open or close LazyGit
- Use `e` or `o` to open a file in a new tab from the lazygit window

## VSCode integration

I use `o` to open files in VSCode from the LazyGit window. Simply edit your lazygit config (`~/Library/Application Support/lazygit/config.yml` on mac)

```
os:
  open: '/opt/homebrew/bin/code {{filename}}' # replace with code path
```

(you can use `e` aswell, but I prefer to use that for cli with nvim)

## Requirements

- LazyGit must be installed on your system and accessible in your PATH (or set with `lazygit-vscode.lazygitPath`). You can find installation instructions for LazyGit [here](https://github.com/jesseduffield/lazygit#installation).

## Usage

Use the keyboard shortcut `Ctrl+Shift+L` (or `Cmd+Shift+L` on macOS) to toggle LazyGit

- `lazygit-vscode.toggle`: Toggle LazyGit

## Extension Settings

- `lazygit-vscode.lazygitPath`: Manually set LazyGit path. Otherwise use default system PATH.

---

## For more info

> [LazyGit](https://github.com/jesseduffield/lazygit)
