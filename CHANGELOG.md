# Changelog

## v0.4.0

The largest release so far: the wallpaper becomes truly multi-media (video and
live web pages), the library turns into a browsable catalog, and the whole
appearance can be snapshotted and restored. The panel is reorganized into four
tabs to keep everything reachable.

### Added

- **Video wallpapers.** Paste a path to any MP4/WebM/MOV — it plays muted and
  looping behind the UI, loaded straight from disk (file://) with an automatic
  fallback to the loopback stream. Optional live color sampling re-tints the UI
  accents from the playing frames every 5 seconds (WebCodecs-free canvas
  sampling over the CORS-enabled stream).
- **Web page wallpapers.** Any https:// URL can be the wallpaper, running in a
  sandboxed iframe (unique opaque origin, no same-origin access, no top-level
  navigation) behind the UI.
- **Wallpaper library.** A thumbnail grid over the Steam Workshop items and the
  local wallpapers folder: type filters, title search, resolution badges (read
  from file headers, no full decode), hover previews (enlarged stills, videos
  play on hover), favorites that sort first and persist, and a 2/4-column grid
  toggle. Scene-type items get their still background extracted from scene.pkg
  on first use.
- **Pseudo-dynamic effects.** Ken Burns drift, mouse parallax and canvas
  particles (snow / petals / light) layered onto still wallpapers — CSS and
  canvas only, no re-encoding.
- **Smart rotation.** A playlist with a configurable interval plus an optional
  night wallpaper (19:00–7:00) that restores the previous look in the morning.
- **Appearance presets.** Snapshot the whole look (wallpaper, video, effects,
  tuning) under a name and switch styles with one click.
- **Performance guard.** Video decoding pauses while the window is hidden, and
  low battery (discharging, <20%) automatically falls back to the still image
  until AC power returns.

### Changed

- **Panel redesign.** Four tabs (Wallpaper / Effects / Rotation / Settings),
  a current-wallpaper card, drag-and-drop import (active while the panel is
  open so chat attachments are unaffected), and the plugin is now branded
  壁纸工坊 (Wallpaper Workshop).
- **Self-healing daemon.** A dead held session is detected and re-held instead
  of leaving the daemon alive but blind; hold-session failures are logged, and
  the poll loop can no longer die from an escaped exception.

## v0.3.3

The plugin now keeps the debug port alive across ZCode updates by itself, and
covers one more class of launch entry.

### Added

- **Startup launcher check.** When ZCode starts without the debug port — the
  failure mode after every app update, because the updater rebuilds the Start
  Menu shortcut without the flag — the MCP host repairs the launch entries as
  soon as it has confirmed the port is unreachable, so the *next* start is
  clean. Same repair as `repair-launchers`, no resident cost, and nothing runs
  while the port is reachable. This matters most for third-party launchers
  (Flow Launcher, PowerToys Run, …): they index the Start Menu shortcut and
  start it through ShellExecute, so the flag on that shortcut is what makes
  them work.
- Pinned taskbar shortcuts (`…\Quick Launch\User Pinned\TaskBar`) are scanned
  and repaired like the other per-user shortcuts.

### Changed

- `status` explains the likely cause — and the fix — when the CDP port is
  unreachable, instead of only reporting the error.
- README and INSTALL-FOR-AI document which entries ZCode itself resets: the
  updater rebuilds the Start Menu shortcut without the flag, and the app
  re-registers its protocol and context-menu registry handlers on every start.
  Shortcuts are the durable entries.

## v0.3.2

Stops the resident service from flashing a black console window on Windows.

### Fixed

- The process probe in `isZcodeProcessRunning()` ran `tasklist` without hiding
  the child console. The probe runs inside the detached `serve` daemon, which has
  no console of its own, so Windows allocated a fresh one on every call — and
  Windows 11 hands a new console to Windows Terminal. The result was a window
  titled `C:\WINDOWS\system32\tasklist.exe` appearing and vanishing every ~15
  seconds whenever the probe fired, i.e. whenever ZCode was not running, for as
  long as the daemon stayed alive. `tasklist`, `taskkill` and the PowerShell
  launcher-repair call are now spawned with `windowsHide: true`, which is what
  the launcher spawn and the daemon's own `spawn` already did.

## v0.3.1

Fixes the autostart entry behind recovery mode `always` on Windows. The script
it wrote was not valid VBScript, so Windows Script Host never ran it: the entry
was present and enabled, yet the resident service never started and the theme
was gone after every reboot.

### Fixed

- `autostart install` (and selecting `always`) assembled the command line out of
  separately quoted fragments, leaving everything after the first path outside a
  string literal — a parse error, not a concatenation. The whole command is now
  one VBScript string literal, with the paths quoted for Windows inside it.
  Re-run `zcode-beautify autostart install` (or re-select `always` in the
  settings panel) to rewrite an existing entry; it only matters from the next
  sign-in, since a running service keeps working either way.

## v0.3.0

The theme now restores itself. This release fixes the "the plugin stopped
working" report that followed every ZCode restart, and closes a security gap in
the local control API.

### Added

- **Recovery modes** (`recovery_status`, `set_recovery_mode`). The injected
  theme dies with the renderer on every restart, so something has to put it
  back. Three modes, chosen by the user:
  - `on-start` (default) — the MCP host ZCode spawns at startup restores it
    once. No resident process, no settings panel.
  - `always` — registers an autostart entry for the resident `serve` daemon, so
    both the theme and the settings panel survive a reboot. Costs a background
    node process (~60 MB, ~0.3% of one core).
  - `off` — nothing automatic.
  The settings panel carries a picker with the same three options and a
  plain-language note about what each costs.
- **`repair-launchers`** — scans desktop and Start Menu shortcuts, the
  `zcode://` protocol handler and the Explorer context-menu verbs, and appends
  the missing `--remote-debugging-port`. ZCode cannot open the port on its own:
  the flag has to come from whatever launches it, and a machine typically has
  several launch entries with only some of them carrying it.
- The settings panel now reports when ZCode is running with its debug port
  closed — the one case no background process can fix — and offers a button
  that restarts the app properly.

### Fixed

- The CLI and the plugin host wrote **two different `config.json` files**: the
  CLI fell back to `plugins/data/zcode-beautify/` while the host points
  `ZCODE_BEAUTIFY_DATA_DIR` at the `…@zcode-beautify` form it derives from
  `${ZCODE_PLUGIN_DATA}`. Settings changed through one path were invisible to
  the other. They now resolve to the same directory.
- The control API answered any request that could reach localhost, including
  from any web page open in a local browser, and could replace the wallpaper or
  reset the appearance. It now requires a token that only the injected panel
  carries; `/api/health` stays open since it exposes nothing but the service
  identity.
- `holdSession` leaked its WebSocket when a step after the connect failed, and
  held sessions were never dropped while CDP was unreachable. Both accumulated
  connections over long runs.
- The MCP server reported a hard-coded version that had drifted from the
  manifest. It is now injected at bundle time from `package.json`.

## v0.2.1

- The settings panel is honest when `serve` is not running: an explicit offline
  banner, zeroed and non-interactive controls, and a retry button, instead of
  rendering plausible-looking defaults it never read.
- `serve --detach` backgrounds the service so the panel outlives the shell that
  started it; a second `serve` refuses to start and names the pid that already
  owns the port.
- `/api/health` identifies the service and its pid.

## v0.2.0

- Settings panel with live tuning (blur, dim, Monet colors, wallpaper
  visibility, framing), wallpaper import, and reset/restore.
- `/beautify` slash command and MCP tools.
- Platform-agnostic skill pack for beautifying any Electron app over CDP.
