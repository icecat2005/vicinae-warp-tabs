# Vicinae Warp Tabs

Vicinae extension for listing the currently open Warp tabs and switching back to a selected tab.

## What It Does

- Reads open Warp tab metadata from `~/.local/state/warp-terminal/warp.sqlite`.
- Shows tab title, git repo and branch when available, abbreviated working directory, window id, tab index, active marker, agent marker, and details.
- Highlights Claude Code sessions with a Claude-colored tab icon, compact status marker, and session duration when Warp recorded timing.
- Switches to tabs 1-8 or the last tab using Warp's `Ctrl+1` through `Ctrl+8` / `Ctrl+9` shortcuts.
- Closes tabs through an explicit confirmed action, available from the action panel or the Delete key.
- Keeps duplicate-tab creation as a separate explicit action.
- Never opens a duplicate tab when the switch action cannot run.
- Never launches Warp from the primary switch action; it only tries to focus an existing GNOME Warp window, then sends the shortcut.

## Requirements

- Vicinae
- Warp
- Node.js 22+
- `python3`
- One key sender for switching existing tabs:
  - GNOME Wayland: `ydotool` recommended
  - Other Wayland compositors: `wtype` may work
  - X11: `xdotool` may work

Node dependencies are installed from `package.json` with `npm install` / `npm ci`. System dependencies are intentionally not installed silently; run the explicit setup script below if you want the repo to install `ydotool` through your package manager.

## Install From GitHub

```bash
git clone https://github.com/icecat2005/vicinae-warp-tabs.git
cd vicinae-warp-tabs
npm install
npm run setup:system
npm run build
vicinae server --replace --open
```

`npm install` also runs a non-failing dependency check and prints the system install command when a key sender is missing.

## Fedora / GNOME Wayland

For the current Fedora GNOME Wayland setup:

```bash
npm run setup:system
```

If `npm run doctor` reports that `ydotool socket` is missing, rerun only the service setup and verification:

```bash
npm run doctor:fix -- --skip-install
```

Use `npm run doctor:fix` for the full install-and-enable path. The script installs `python3` and `ydotool`, enables either `ydotool.service` or `ydotoold.service`, verifies socket access, then runs `npm run doctor`.

Equivalent manual commands:

```bash
sudo dnf -y install ydotool
sudo systemctl enable --now ydotool.service || sudo systemctl enable --now ydotoold.service
```

If `ydotool` is installed but switching still fails, check the daemon socket:

```bash
systemctl status ydotool.service
ls -l /run/ydotool/socket /run/user/$UID/.ydotool_socket
```

The extension detects both socket locations automatically.

## Development

```bash
npm install
npm run doctor
npm run lint
npx vici lint
npm run dev
```

Build:

```bash
npm run build
```

If `vici build` fails inside a sandbox with `spawnSync npx EPERM`, run it from a normal terminal.

## GitHub Repo Setup

The intended repository is:

```text
https://github.com/icecat2005/vicinae-warp-tabs
```

Create and push it with:

```bash
gh auth login -h github.com
gh repo create icecat2005/vicinae-warp-tabs --public --source=. --remote=origin --push
```

If the repo already exists:

```bash
git remote add origin https://github.com/icecat2005/vicinae-warp-tabs.git
git push -u origin main
```

## Notes

Warp does not expose a public activate-tab-by-id CLI/API, so this extension combines local Warp state inspection with keyboard shortcut dispatch. On GNOME Wayland, existing-app focus may be denied by GNOME Shell; in that case the shortcut is sent after Vicinae closes, so the best path is launching Vicinae while Warp is the previous focused app.
