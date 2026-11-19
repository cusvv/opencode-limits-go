# SPEC — opencode-limits-go

## Purpose

OpenCode v2.3+ plugin that shows OpenCode Go quota usage (5h / 1w / 1m) in the Desktop GUI and TUI, with pace, risk verdicts, alerts, and OpenCode Zen/today statistics.

## Layers

- `src/core/` — pure logic, no Node or UI imports. Tests live here.
- `src/server/` — credentials, HTTP, updates, logging.
- `src/index.ts` — plugin setup, RPC handlers, cache, timers.
- `src/gui/`, `src/tui/` — presentation only.
- `src/rpc.ts` — the only contract between server and UIs.

## Contracts and invariants

### Quota windows
- Window risk is ranked by **projected usage at reset** (`used / elapsedRatio`), not raw percent, so a 5h window that resets soon cannot hide a weekly window that will run out.
- `windowVerdict` returns `exhausted | tight | fits` per window. UI may show only actionable verdicts.
- Hot pace requires `projectedPct >= 105` and `timeToFull < remaining`; the old 110–120 gap that rendered as “steady ~100%” is treated as hot.

### Alerts
- Alert state is persisted in TUI storage and keyed by account + window; account changes clear it.
- Alerts never fire from `stale` disk cache.
- Threshold, reset, spike, and risk alerts go to in-app toast and `ctx.attention.notify` (OpenCode decides whether the OS notification is shown).
- Reset alert says the window reset and its current %, never that all Go quota is available.

### Shared preferences
- Shared via RPC: windows, `showRemaining`, `alerts`, `warnThreshold`, `burnSpikePct`, `langOverride`.
- GUI-only: palette, density, placement, time/reset format, dialog widgets, poll interval.
- A failed preference push shows an error and pulls the server value back; UI must not silently keep a value the server rejected.

### Cache and accounts
- `lastGood:v1` is validated row-by-row on load; invalid entries are dropped.
- History is tagged with `accountKey`; changing account clears history.
- Credential/config events drop the disk cache so an old account is never shown as the current one.

### Credentials
- Server-side only; never over RPC, never in UI, redacted in logs (bearer, JWT, prefixed keys, `token=`).
- Credential resolution is bounded (8s host hooks, 8s CLI) so `status` cannot hang past its 25s deadline.
- Windows CLI fallback runs with `NoDefaultCurrentDirectoryInExePath=1` and a home cwd to prevent repo-supplied `opencode.cmd` execution.
- 429/5xx are token-specific and do not stop trying other credentials.

### Updates
- Git/`local-plugins` installs are dev installs: never auto-overwritten, manual install returns “git pull”.
- Package-manager installs defer to `opencode plugin update`.
- Release installs require:
  - HTTPS GitHub host allowlist (incl. `codeload.github.com`, `.githubusercontent.com`);
  - `SHA256SUMS` asset and matching SHA-256;
  - archive version equal to the release tag;
  - lock file to prevent concurrent installs;
  - extracted-size cap (60 MB) and streamed download cap (10 MB);
  - `package.json` copied last and re-verified, so an interrupted copy is retried on next start.
- No auto-install for dev installs even if `autoUpdate=true`.

### Logging
- Private directory `%TEMP%/opencode-limits-go/` or `/tmp/opencode-limits-go/`, file `limits.log`, mode `0600` (POSIX), `O_NOFOLLOW` where supported.
- Rotation at 256 KB; write failures are ignored.

### UI behavior
- Every destructive reset requires confirmation.
- Desktop settings search indexes every visible setting.
- Strip is a native button with an `aria-label`; window toggles expose `aria-pressed`; sparkline has `role="img"`.
- TUI strip is compact below 76 columns, can be hidden, and supports plain ASCII.
- TUI settings reopen after each change; Esc/Done exits.
- Polling skips overlapping requests and uses a 30s client timeout.

## Testing

- `npm test` covers core formatting/risk/alerts, auth parsing, HTTP retry, updater checksum/lock/dev guards.
- `npm run build` must regenerate `dist/gui-experimental.cjs`; CI asserts it matches source.

## Known limits

- Multi-account is guarded (cache/history/alerts) but only the first working credential is shown; no account switcher.
- The updater does not verify a cryptographic signature, only a SHA-256 manifest from the same release.
- TUI runtime requires `solid-js`/`@opentui/solid`; local installs must run `npm install`.
- RPC exposure and auth are controlled by the OpenCode host, not by this plugin.
