# SPEC — opencode-limits-go

## Purpose

OpenCode v2.3+ plugin (Node >= 20.3) showing OpenCode Go quota (5h / 1w / 1m) in Desktop GUI and TUI, with pace, risk verdicts, alerts, and OpenCode Zen/today stats. Cards are language-neutral; UIs localize on render.

## Layers

- `src/core/` — domain: types, parsing, window risk math, pace, alert detectors, stats. No Node, IO, or user copy.
- `src/present/` — copy and formatting: labels, durations, errors, alert/verdict/pace strings, TUI sidebar/detail.
- `src/i18n/` — EN/RU dictionaries, typed keys, `message()`; EN/RU parity.
- `src/ui-state/` — framework-agnostic single-flight poller, alert reducer, shared-pref application.
- `src/settings/` — one shared prefs schema, defaults, sanitize, merge.
- `src/rpc/` — RPC contract (`src/rpc.ts` re-exports it); only server↔UI boundary.
- `src/server/service/` — cache, history, identity, prefs, status, events, storage.
- `src/server/credentials/` — `auth.ts` facade + identity/resolver/sources.
- `src/server/updater/` — release check, archive validation, install/rollback.
- `src/server/api.ts`, `log.ts`, `platform.ts` — HTTP, logging, platform helpers.
- `src/gui/`, `src/tui/` — presentation only; `src/index.ts` — wiring, timers, RPC handlers.

## Contract

- `status` returns a language-neutral `LimitCard`:
  - rows: `label` = `5h|1w|1m`, `resetsAt` = numeric date or `"?"`, `resetsIn` = `""`/`"?"`, with `key`/`resetsAtMs` additive;
  - `tight` = `""` (deprecated, UI computes risk);
  - `error` = deprecated machine code, equal to `errorCode`; `errorCode`/`errorDetail` are authoritative (detail is technical, never UI copy);
  - `lang` input is deprecated and ignored;
  - `accountId` = stable HMAC credential fingerprint; `revision` = credential epoch.
- Events: `changed {reason: credentials|reset|usage, accountId?, revision?}`, `updated {version}`, `prefsChanged {prefs, autoUpdate}`.
- `getPrefs`/`setPrefs` exchange shared prefs; `diagnostics` exposes cache/history/prefs/updater summary, never secrets.

## Quota windows

- Risk ranks by projected usage at reset (`used / elapsedRatio`), not raw percent.
- `windowVerdict` returns `exhausted | tight | fits`; UI shows actionable verdicts only.
- Hot pace needs `projectedPct >= 105` and `timeToFull < remaining`; `limited` is exhausted regardless of reported percent.
- Early-window pace is suppressed until 1% elapsed and `used >= 35`; recent snapshot bursts can override the average.

## Cache and accounts

- `lastGood:v1` is row-validated on load; invalid entries are dropped.
- Credential/config events clear disk cache via storage `remove` or a sentinel fallback, so an old account is never shown as current.
- `history:v2` stores snapshots with per-window `resets`; snapshots from another reset are ignored for delta/spike.
- History is tagged with `accountId`; changing account clears it. Alerts are keyed by account + window + reset.
- The server retries when the credential epoch changes and never returns the old account's success.

## Settings

- `src/settings/prefs.ts` is the single schema/defaults/sanitize/merge source.
- Shared prefs priority: storage > plugin options > defaults.
- `autoUpdate` is server-owned with options > storage — an intentional exception to the shared-prefs order.
- A failed pref push shows an error and pulls the server value back; UI never silently keeps a rejected value.
- GUI-only prefs: palette, density, placement, time/reset format, dialog toggles, poll interval.

## Alerts

- One reducer (`ui-state/alerts.ts`) for GUI and TUI; texts come from `present`.
- Persistence is per surface: TUI storage, GUI store; account change clears state.
- Stale cards and disabled alerts do not mutate dedupe state.
- Threshold/reset/spike/risk alerts are in-app toasts. OS notifications are opt-in, 100%-only, and throttled to one per 10 minutes.

## Polling

- Single-flight requests; forced refreshes are queued and coalesced.
- `seq` guards drop stale results; `invalidate()` aborts and resolves waiters; 30s client timeout.
- Credential change invalidates, clears card/zen state, resets the poller, and forces a reload.

## Credentials, updates, logging

- Credentials are server-side only, never over RPC/UI, and redacted in logs (Bearer/Basic/JWT/prefixed keys/headers/JSON secrets).
- Resolution is bounded (8s host hooks, 8s CLI) under a 25s `status` deadline. CLI export is cached 10 minutes single-flight; `dropCli` clears cache and in-flight probe.
- Windows CLI fallback uses `NoDefaultCurrentDirectoryInExePath=1` and a home cwd. 429/5xx are token-specific.
- Dev/`local-plugins` installs are never overwritten; package-manager installs defer to `opencode plugin update`.
- Release installs require HTTPS GitHub allowlist, `SHA256SUMS`, matching archive version, owner-token lock, fail-closed listing preflight, size caps, `package.json` copied last, and rollback. Check cache is honored for dev/PM installs.
- Logs: private `0700` dir, `0600` file, `O_NOFOLLOW` where available, 256 KB rotation, write failures ignored.

## UI behavior

- GUI and TUI share thresholds 50/70/80/90/100; `0` disables the warning level and keeps 100.
- All user copy comes from `i18n`/`present`; UI never renders a machine error code as a sentence (`cardErrorText`).
- Strip is a native button with `aria-label`; toggles use `aria-pressed`; sparkline uses `role="img"`.
- TUI strip is compact below 76 columns, hideable, plain-ASCII capable, and resize-reactive.
- Destructive resets require confirmation; Desktop settings search indexes every visible setting.

## Testing

- `npm test` runs core/server/ui-state/present (129 tests): parsing, risk/pace, alerts/history, auth sources + CLI cache, redaction, HTTP retry, updater checksums/listing/lock/rollback/dev guards, RPC contract, EN/RU parity.
- `npm run build` typechecks both tsconfigs and regenerates `dist/gui-experimental.cjs`; CI runs on Linux/Windows/macOS and asserts the bundle is current on Linux.

## Known limits

- No account switcher: only the first working credential is shown; multi-account is guarded in cache/history/alerts.
- The updater verifies a SHA-256 manifest, not a cryptographic signature.
- Runtime requirements differ: server + Desktop GUI need Node >= 20; the optional TUI entrypoint inherits `@opentui/core` engines (Node >= 26.4 or Bun >= 1.3.14) and needs `npm install` (`solid-js`/`@opentui/solid`). CI builds/tests on Node 24 without running TUI.
- RPC exposure and auth are controlled by the OpenCode host.
