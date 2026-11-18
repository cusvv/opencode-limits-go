# zen-limits

**OpenCode Go** quota monitor plugin for **OpenCode v2.3+** (TUI & Desktop GUI).

Displays live usage across all three OpenCode Go windows — **5-hour rolling**, **weekly**, and **monthly** — with threshold alerts, flexible placement in Desktop GUI, automatic English/Russian localization matching your OpenCode UI language, and built-in GitHub auto-updates.

---

## Features

- **All OpenCode Go windows**: `5h` / `1w` / `1m` percentages, reset timestamps, countdowns, and tightest-window summary.
- **Smart pace estimation**: Noise-filtered burn-rate projection for `5h`, `1w`, and `1m` windows — suppresses tiny early-window fluctuations, flags fast bursts, and estimates time to exhaustion vs. reset.
- **Works with any OpenCode auth setup**:
  - OpenCode Console **OAuth** account (`opencode`)
  - Saved **API key** (`opencode-go` or `opencode` integration)
  - Environment variables (`OPENCODE_GO_API_KEY`, `OPENCODE_API_KEY`, `OPENCODE_ZEN_API_KEY`)
  - Plugin options or provider settings in `opencode.json`
  - Lazy fallback to `opencode auth export` and legacy `~/.local/share/opencode/auth.json`
- **Desktop GUI**:
  - Clickable status strip with color-coded progress bars (green `< 80%`, amber `80–99%`, red `100%`)
  - **Quick OpenCode Console access**: Direct button in the limits dialog and Settings page to open `https://opencode.ai/console`
  - **Settings window** (`/limits-settings`, gear button in the limits dialog, and native `Settings → OpenCode Go limits`)
  - **Placement options**: Bottom bar (default), Top bar (`session.header`), Both, Titlebar / sidebar button, or Hidden
  - Toggleable mini progress bars and 80% / 100% threshold toasts
  - Light & dark theme support
- **TUI**:
  - Live sidebar indicator (`sidebar.content`) with semantic theme colors
  - `/limits` slash command, command palette entry, and `Ctrl+Shift+L` shortcut
  - Auto-refreshes on `session.usage.updated`, every 90 seconds, and on credential changes
- **Bilingual (English / Russian)**: Automatically follows the OpenCode UI language (Desktop `ctx.locale`, or `OPENCODE_LANG` / `LC_ALL` / `LANG` in TUI).
- **Auto-Update**: Checks [GitHub Releases](https://github.com/cusvv/zen-limits/releases) for new versions and automatically installs updates in the background (can be toggled or triggered manually in Settings).
- **Security-first**: Tokens never leave the server process — never sent over RPC, never shown in the UI, and automatically redacted from logs (`%TEMP%/zen-limits.log` or `/tmp/zen-limits.log`).

---

## Installation

Requires **OpenCode v2.3.0+** and an active OpenCode Go credential (via `opencode auth login` or `OPENCODE_API_KEY`).

### Option 1: Clone with Git (recommended)

```sh
# macOS / Linux
git clone https://github.com/cusvv/zen-limits.git ~/.config/opencode/local-plugins/zen-limits
```

```powershell
# Windows (PowerShell)
git clone https://github.com/cusvv/zen-limits.git "$env:USERPROFILE\.config\opencode\local-plugins\zen-limits"
```

### Option 2: Download Release Archive

Download `zen-limits.zip` or `zen-limits.tar.gz` from the [Releases](https://github.com/cusvv/zen-limits/releases) page and extract it so the folder is:

- Windows: `%USERPROFILE%\.config\opencode\local-plugins\zen-limits`
- macOS / Linux: `~/.config/opencode/local-plugins/zen-limits`

### Enable in `opencode.json`

Add `./local-plugins/zen-limits` to `plugins` in your global `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "./local-plugins/zen-limits"
  ]
}
```

> **Optional:** You can also pass an API token directly via plugin options:
> ```jsonc
> {
>   "plugins": [
>     {
>       "package": "./local-plugins/zen-limits",
>       "options": { "token": "{env:OPENCODE_GO_API_KEY}" }
>     }
>   ]
> }
> ```

Restart **OpenCode Desktop** (and run `/reload` in open TUI sessions). No `npm install` is required — `dist/gui-experimental.cjs` is prebuilt.

---

## Usage & Shortcuts

| Action | Shortcut / Command |
|---|---|
| Show limits dialog | `/limits` or `Ctrl+Shift+L` (or click the indicator in Desktop) |
| Open plugin settings (Desktop) | `/limits-settings`, gear button in dialog, or `Settings → OpenCode Go limits` |

### Verify via CLI

```sh
opencode plugin list
opencode api post /api/rpc/zen-limits/status --data '{"input":{"force":true}}'
```

---

## Development

```sh
npm install
npm test          # Run unit tests (model, auth, updater)
npm run build     # Typecheck server/TUI/GUI and rebuild dist/gui-experimental.cjs
```

### Project Structure

```
src/
  index.ts        Server plugin: RPC endpoints, caching, event invalidation, auto-updater loop
  auth.ts         Multi-source credential discovery & deduplication
  api.ts          OpenCode Go usage HTTP client
  model.ts        Pure formatting, validation, EN/RU localization, semver, secret redaction
  updater.ts      GitHub Releases updater with HTTPS allowlist & staged verification
  rpc.ts          Portable RPC contract
  log.ts          Rotating JSON logger (256 KB max)
  tui.tsx         OpenTUI adapter
  gui.tsx         Desktop GUI adapter (SolidJS + OpenCode GUI SDK)
dist/
  gui-experimental.cjs   Prebuilt CommonJS Desktop GUI bundle
```

---

## License

[MIT](LICENSE)
