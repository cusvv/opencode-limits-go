import { test } from "node:test"
import assert from "node:assert/strict"
import {
  CodedError,
  accountKey,
  attachHistoryDeltas,
  buildSparklinePoints,
  compareSemver,
  detectBurnSpike,
  emptyCard,
  errorText,
  estimateWindowPace,
  filterStripRows,
  isAuthError,
  isNewerVersion,
  newAlerts,
  nextResetDelayMs,
  normalizeLocale,
  paceSummary,
  parseUsage,
  recordUsageSnapshot,
  recoveredAlerts,
  redactSecrets,
  retry,
  rowWindowKey,
  selectSnapshotsForClient,
  selectStripRows,
  shouldHideStrip,
  summarizeStatsByProvider,
  tightestRow,
  windowElapsedRatio,
  windowVerdict,
} from "./index.ts"

const NOW = Date.parse("2026-11-17T10:00:00Z")

test("normalizeLocale picks ru only for Russian locales", () => {
  assert.equal(normalizeLocale("ru"), "ru")
  assert.equal(normalizeLocale("ru-RU"), "ru")
  assert.equal(normalizeLocale("en-US"), "en")
  assert.equal(normalizeLocale(undefined), "en")
})

test("parseUsage: maps the three windows, numeric resetsAt, and limited flag", () => {
  const rows = parseUsage(
    {
      usage: {
        rolling: { percent: 12.4, status: "ok", resetsAt: "2026-11-17T12:00:00Z" },
        weekly: { percent: 3, limited: true, resetsAt: NOW + 3_600_000 },
        monthly: { percent: 40, resetInSec: 7200 },
      },
    },
    NOW,
  )
  assert.deepEqual(rows.map((r) => r.label), ["5h", "1w", "1m"])
  assert.deepEqual(rows.map((r) => r.key), ["rolling", "weekly", "monthly"])
  assert.equal(rows[0].used, 12)
  assert.equal(rows[0].resetsIn, "")
  assert.equal(rows[1].status, "limited")
  assert.equal(rows[2].resetsAtMs, NOW + 7_200_000)
})

test("parseUsage: rejects empty strings, booleans, arrays, and null percents", () => {
  for (const bad of ["abc", "", "   ", null, undefined, false, [], {}, Number.NaN]) {
    assert.throws(
      () => parseUsage({ usage: { rolling: { percent: bad } } }, NOW),
      (err: unknown) => err instanceof CodedError && err.code === "INVALID_PERCENT",
    )
  }
})

test("parseUsage: empty or foreign payload throws EMPTY_USAGE", () => {
  assert.throws(
    () => parseUsage({}, NOW),
    (err: unknown) => err instanceof CodedError && err.code === "EMPTY_USAGE",
  )
  assert.throws(
    () => parseUsage(null, NOW),
    (err: unknown) => err instanceof CodedError && err.code === "EMPTY_USAGE",
  )
})

test("errorText redacts Bearer, prefixed secrets, and JWTs", () => {
  const msg = errorText(new Error("failed with Bearer sk-ant-secret123 and st_abcdef12345 and gho_secret999"))
  assert.doesNotMatch(msg, /secret123|abcdef12345|secret999/)
  assert.match(msg, /\[REDACTED\]/)
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123"
  assert.doesNotMatch(redactSecrets(`token ${jwt}`), /eyJhbGci/)
})

test("errorText keeps coded errors technical, without UI templates", () => {
  assert.equal(errorText(new CodedError("INVALID_PERCENT", "rolling")), "INVALID_PERCENT: rolling")
  assert.equal(errorText(new CodedError("EMPTY_USAGE")), "EMPTY_USAGE")
})

test("newAlerts: alerts once per threshold crossing and again after a reset", () => {
  const notified = new Map<string, number>()
  const at = (used: number) => [{ key: "rolling" as const, label: "5h", used, status: "ok", resetsAt: "?", resetsIn: "?" }]
  assert.equal(newAlerts(at(50), notified).length, 0)
  assert.equal(newAlerts(at(85), notified).length, 1)
  assert.equal(newAlerts(at(90), notified).length, 0)
  assert.equal(newAlerts(at(100), notified).length, 1)
  assert.equal(newAlerts(at(100), notified).length, 0)
  assert.equal(newAlerts(at(10), notified).length, 0)
  assert.equal(newAlerts(at(82), notified).length, 1)
})

test("compareSemver and isNewerVersion compare semantic versions", () => {
  assert.equal(compareSemver("v1.4.1", "1.4.0") > 0, true)
  assert.equal(compareSemver("1.10.0", "1.9.9") > 0, true)
  assert.equal(isNewerVersion("v1.4.1", "1.4.0"), true)
  assert.equal(isNewerVersion("1.4.0", "1.4.0"), false)
  assert.equal(isNewerVersion("1.3.9", "1.4.0"), false)
  assert.equal(isNewerVersion("invalid", "1.4.0"), false)
})

test("retry stops on the first success, does not pause after final attempt, and respects AbortSignal", async () => {
  let calls = 0
  let pauses = 0
  const pause = async () => {
    pauses++
  }
  const value = await retry(
    async () => (++calls === 3 ? "ok" : null),
    (v) => v === "ok",
    5,
    pause,
  )
  assert.equal(value, "ok")
  assert.equal(calls, 3)
  assert.equal(pauses, 2)

  calls = 0
  pauses = 0
  const never = await retry(async () => { calls++; return null }, () => false, 4, pause)
  assert.equal(never, null)
  assert.equal(calls, 4)
  assert.equal(pauses, 3)

  const controller = new AbortController()
  calls = 0
  const aborted = await retry(
    async () => {
      calls++
      controller.abort()
      return null
    },
    () => false,
    5,
    pause,
    controller.signal,
  )
  assert.equal(aborted, null)
  assert.equal(calls, 1)
})

test("estimateWindowPace suppresses tiny/early-window noise and flags heavy bursts", () => {
  const now = 1_700_000_000_000
  const weekMs = 7 * 24 * 60 * 60 * 1000

  // Very early in window (3% elapsed) with modest usage (15%) -> suppressed (null)
  const earlyNoise = {
    key: "weekly" as const,
    label: "Weekly",
    used: 15,
    resetsIn: "6d 19h",
    resetsAt: "Sun",
    resetsAtMs: now + Math.round(weekMs * 0.97),
    status: "ok",
  }
  assert.equal(estimateWindowPace(earlyNoise, now), null)

  // Low usage (<10%) later in window -> suppressed (null)
  const tinyUsage = {
    key: "weekly" as const,
    label: "Weekly",
    used: 5,
    resetsIn: "3d",
    resetsAt: "Thu",
    resetsAtMs: now + Math.round(weekMs * 0.45),
    status: "ok",
  }
  assert.equal(estimateWindowPace(tinyUsage, now), null)

  // Heavy burst early in window (>=35% used at 5% elapsed) -> flagged as hot
  const burst = {
    key: "weekly" as const,
    label: "Weekly",
    used: 40,
    resetsIn: "6d 15h",
    resetsAt: "Sun",
    resetsAtMs: now + Math.round(weekMs * 0.95),
    status: "ok",
  }
  const burstPace = estimateWindowPace(burst, now)
  assert.equal(burstPace?.kind, "hot")
  assert.equal(paceSummary([burst], now)?.kind, "hot")

  // Steady comfortable pace (26% used at 34% elapsed -> projected ~76%)
  const steady = {
    key: "weekly" as const,
    label: "Weekly",
    used: 26,
    resetsIn: "4d 14h",
    resetsAt: "Fri",
    resetsAtMs: now + Math.round(weekMs * 0.66),
    status: "ok",
  }
  const steadyPace = estimateWindowPace(steady, now)
  assert.equal(steadyPace?.kind, "steady")
  assert.equal(paceSummary([steady], now)?.kind, "steady")

  // Exhausted window (100%)
  const exhausted = {
    key: "rolling" as const,
    label: "5h",
    used: 100,
    resetsIn: "2h",
    resetsAt: "14:00",
    resetsAtMs: now + 2 * 3600_000,
    status: "limited",
  }
  const summary = paceSummary([exhausted, steady], now)
  assert.equal(summary?.kind, "exhausted")
  assert.equal(summary?.windowKey, "rolling")
})

test("filterStripRows selects enabled windows and falls back if none are selected", () => {
  const rows = [
    { key: "rolling" as const, label: "5h", used: 12, status: "ok", resetsAt: "", resetsIn: "" },
    { key: "weekly" as const, label: "1w", used: 40, status: "ok", resetsAt: "", resetsIn: "" },
    { key: "monthly" as const, label: "1m", used: 65, status: "ok", resetsAt: "", resetsIn: "" },
  ]

  assert.equal(rowWindowKey(rows[1]), "weekly")

  const only5h = filterStripRows(rows, { rolling: true, weekly: false, monthly: false })
  assert.deepEqual(only5h.map((r) => r.label), ["5h"])

  const fallbackAll = filterStripRows(rows, { rolling: false, weekly: false, monthly: false })
  assert.equal(fallbackAll.length, 3)
})

test("history ring buffer computes recent deltas, detects late-window bursts, and calculates elapsed ratio", () => {
  const now = 1_700_000_000_000
  const weekMs = 7 * 86_400_000

  // 70% of week elapsed, overall avg = 50% (looks fine), but jumped +12% in last hour -> hot!
  const row = {
    key: "weekly" as const,
    label: "1w",
    used: 50,
    status: "ok",
    resetsAt: "Sun",
    resetsAtMs: now + Math.round(weekMs * 0.3),
    resetsIn: "2d",
  }

  let history = recordUsageSnapshot([], [{ ...row, used: 38 }], now - 3_600_000)
  // Duplicate within 5 minutes is ignored
  history = recordUsageSnapshot(history, [{ ...row, used: 38 }], now - 3_500_000)
  assert.equal(history.length, 1)

  history = recordUsageSnapshot(history, [row], now)
  assert.equal(history.length, 2)

  const [withDelta] = attachHistoryDeltas([row], history, now)
  assert.equal(withDelta.delta1h, 12)

  const pace = estimateWindowPace(row, now, history)
  assert.equal(pace?.kind, "hot")

  const ratio = windowElapsedRatio(row, now)
  assert.ok(ratio !== null && Math.abs(ratio - 0.7) < 0.01)
})

test("newAlerts supports custom warning thresholds and summarizeStatsByProvider splits Go vs Zen", () => {
  const notified = new Map<string, number>()
  const rows = [{ key: "rolling" as const, label: "5h", used: 72, status: "ok", resetsAt: "", resetsIn: "" }]
  assert.equal(newAlerts(rows, notified, 80).length, 0)
  assert.equal(newAlerts(rows, notified, 70).length, 1)
  assert.equal(newAlerts(rows, new Map(), 0).length, 0)

  const summary = summarizeStatsByProvider([
    { model: { providerID: "opencode-go" }, steps: 10, cost: 0, tokens: { input: 1000, output: 500, reasoning: 200 } },
    { model: { providerID: "opencode" }, steps: 3, cost: 0.045, tokens: { input: 600, output: 200, reasoning: 0 } },
    { model: { providerID: "google" }, steps: 1, cost: 0.02, tokens: { input: 100, output: 10, reasoning: 0 } },
  ])
  assert.equal(summary.goTokens, 1700)
  assert.equal(summary.goSteps, 10)
  assert.equal(summary.zenTokens, 800)
  assert.equal(summary.zenSteps, 3)
  assert.ok(Math.abs(summary.zenCostUsd - 0.045) < 1e-6)
  assert.ok(Math.abs(summary.totalCostUsd - 0.065) < 1e-6)
})

test("selectStripRows tightest mode ranks by projected risk, not raw percent", () => {
  const now = Date.now()
  const rows = [
    {
      key: "rolling" as const,
      label: "5h",
      used: 92,
      status: "ok",
      resetsAt: "",
      resetsAtMs: now + 20 * 60_000,
      resetsIn: "",
    },
    {
      key: "weekly" as const,
      label: "1w",
      used: 60,
      status: "ok",
      resetsAt: "",
      resetsAtMs: now + 4 * 86_400_000,
      resetsIn: "",
    },
  ]
  const pick = selectStripRows(rows, { rolling: true, weekly: true, monthly: true }, "tightest", now)
  assert.equal(pick[0].key, "weekly")
  const verdict = windowVerdict(rows[1], now)
  assert.equal(verdict?.kind, "tight")
  assert.equal(verdict?.labelKey, "weekly")
  assert.equal("text" in (verdict ?? {}), false)
  assert.equal(tightestRow(rows, now)?.key, "weekly")
})

test("recoveredAlerts detects drop from 100%", () => {
  const exhausted = new Set<string>()
  const rowFull = { key: "rolling" as const, label: "5h", used: 100, status: "limited", resetsAt: "", resetsIn: "" }
  const rowReset = { key: "rolling" as const, label: "5h", used: 0, status: "ok", resetsAt: "", resetsIn: "" }

  assert.equal(recoveredAlerts([rowFull], exhausted).length, 0)
  assert.ok(exhausted.has("rolling"))

  const rec = recoveredAlerts([rowReset], exhausted)
  assert.equal(rec.length, 1)
  assert.equal(exhausted.has("rolling"), false)

  // Second poll at 0% must not re-fire.
  assert.equal(recoveredAlerts([rowReset], exhausted).length, 0)
})

test("accountKey normalizes org, email, and source", () => {
  assert.equal(accountKey(" Personal ", "Dev@Example.com", "integration:oauth"), "personal|dev@example.com|integration:oauth")
})

test("selectSnapshotsForClient preserves 15m-4h anchor snapshots during rapid bursts", () => {
  const now = 1_700_000_000_000
  const history = [
    { at: now - 90 * 60_000, rolling: 10 },
    { at: now - 60 * 60_000, rolling: 15 },
    { at: now - 30 * 60_000, rolling: 25 },
    // 30 rapid updates in the last 10 minutes
    ...Array.from({ length: 30 }, (_, i) => ({
      at: now - (30 - i) * 20_000,
      rolling: 30 + i,
    })),
  ]
  const selected = selectSnapshotsForClient(history, now, 24)
  assert.ok(selected.length <= 24)
  // Must retain the ~60m anchor snapshot even though there are 30 newer entries!
  assert.ok(selected.some((s) => s.at === now - 60 * 60_000))
  assert.equal(selected[selected.length - 1].at, history[history.length - 1].at)
})

test("summarizeStatsByProvider extracts topModels", () => {
  const summary = summarizeStatsByProvider([
    { model: { providerID: "opencode-go", modelID: "claude-sonnet" }, steps: 12, cost: 0, tokens: { input: 80_000, output: 18_000, reasoning: 0 } },
    { model: { providerID: "opencode-go", modelID: "gemini-pro" }, steps: 5, cost: 0, tokens: { input: 40_000, output: 4_000, reasoning: 0 } },
    { model: { providerID: "opencode", modelID: "gpt-5" }, steps: 2, cost: 0.12, tokens: { input: 10_000, output: 2_000, reasoning: 0 } },
    { model: { providerID: "opencode-go", modelID: "haiku" }, steps: 1, cost: 0, tokens: { input: 1_000, output: 500, reasoning: 0 } },
  ])
  assert.equal(summary.topModels.length, 3)
  assert.equal(summary.topModels[0].modelID, "claude-sonnet")
  assert.equal(summary.topModels[0].tokens, 98_000)
  assert.equal(summary.topModels[1].modelID, "gemini-pro")
})

test("selectStripRows tightest mode, shouldHideStrip, nextResetDelayMs, detectBurnSpike, and buildSparklinePoints", () => {
  const now = Date.parse("2026-11-19T15:30:00Z")
  const rows = [
    { key: "rolling" as const, label: "5h", used: 35, status: "ok", resetsAt: "", resetsAtMs: now + 2 * 3_600_000, resetsIn: "2h" },
    { key: "weekly" as const, label: "1w", used: 62, status: "ok", resetsAt: "", resetsAtMs: now + 3 * 86_400_000, resetsIn: "3d" },
    { key: "monthly" as const, label: "1m", used: 62, status: "ok", resetsAt: "", resetsAtMs: now + 10 * 86_400_000, resetsIn: "10d" },
  ]
  const tightest = selectStripRows(rows, { rolling: true, weekly: true, monthly: true }, "tightest", now)
  assert.equal(tightest.length, 1)
  assert.equal(tightest[0].key, "weekly")

  assert.equal(shouldHideStrip(rows, 0), false)
  assert.equal(shouldHideStrip(rows, 70), true)
  assert.equal(shouldHideStrip(rows, 50), false)

  assert.equal(nextResetDelayMs(rows, now), 2 * 3_600_000 + 3_000)

  const snaps = [
    { at: now - 20 * 60_000, rolling: 10 },
    { at: now - 10 * 60_000, rolling: 22 },
    { at: now - 1 * 60_000, rolling: 35 },
  ]
  const spike = detectBurnSpike(rows, snaps, 20, now)
  assert.ok(spike !== null)
  assert.equal(spike.delta, 25)

  const spark = buildSparklinePoints(snaps, "rolling", 200, 24)
  assert.ok(spark !== null)
  assert.equal(spark.min, 10)
  assert.equal(spark.max, 35)
  assert.equal(spark.count, 3)
  assert.ok(spark.polyline.includes(","))
})

test("limited status counts as exhausted for pace, verdict and alerts", () => {
  const now = 1_700_000_000_000
  const row = {
    key: "weekly" as const,
    label: "1w",
    used: 42,
    status: "limited",
    resetsAt: "Sun",
    resetsAtMs: now + 2 * 86_400_000,
    resetsIn: "2d",
  }
  const pace = estimateWindowPace(row, now)
  assert.equal(pace?.kind, "exhausted")
  assert.ok((pace?.projectedPct ?? 0) >= 100)
  assert.equal(windowVerdict(row, now)?.kind, "exhausted")

  const notified = new Map<string, number>()
  assert.equal(newAlerts([row], notified).length, 1)
  assert.equal(newAlerts([row], notified).length, 0)
})

test("heavy usage just after reset is still flagged hot", () => {
  const now = 1_700_000_000_000
  const weekMs = 7 * 86_400_000
  const row = {
    key: "weekly" as const,
    label: "1w",
    used: 40,
    status: "ok",
    resetsAt: "Sun",
    resetsAtMs: now + Math.round(weekMs * 0.995),
    resetsIn: "6d 23h",
  }
  assert.equal(estimateWindowPace(row, now)?.kind, "hot")
})

test("history snapshots from a previous window are ignored", () => {
  const now = 1_700_000_000_000
  const newReset = now + 2.5 * 3_600_000
  const oldReset = newReset - 5 * 3_600_000
  const row = {
    key: "rolling" as const,
    label: "5h",
    used: 40,
    status: "ok",
    resetsAt: "20:00",
    resetsAtMs: newReset,
    resetsIn: "2h 30m",
  }

  assert.deepEqual(recordUsageSnapshot([], [row], now)[0].resets, { rolling: newReset })

  const stale = [{ at: now - 3_600_000, rolling: 2, resets: { rolling: oldReset } }]
  assert.equal(attachHistoryDeltas([row], stale, now)[0].delta1h, undefined)
  assert.notEqual(estimateWindowPace(row, now, stale)?.kind, "hot")

  const current = [{ at: now - 3_600_000, rolling: 2, resets: { rolling: newReset } }]
  assert.equal(attachHistoryDeltas([row], current, now)[0].delta1h, 38)
  assert.equal(estimateWindowPace(row, now, current)?.kind, "hot")
})

test("isAuthError ignores numeric substrings inside longer numbers", () => {
  assert.equal(isAuthError("account 1401 not found"), false)
  assert.equal(isAuthError("HTTP 401: Unauthorized"), true)
  assert.equal(isAuthError("HTTP 403 Forbidden"), true)
})

test("parseUsage accepts numeric reset strings and rejects implausible dates", () => {
  const now = Date.parse("2026-11-17T10:00:00Z")
  const rows = parseUsage(
    {
      usage: {
        rolling: { percent: 5, resetInSec: "3600" },
        weekly: { percent: 6, resetsAt: "0" },
        monthly: { percent: 7, resetsAt: "1700000000" },
      },
    },
    now,
  )
  assert.equal(rows[0].resetsAtMs, now + 3_600_000)
  assert.equal(rows[1].resetsAtMs, 0)
  assert.equal(rows[2].resetsAtMs, 1_700_000_000_000)

  const farFuture = parseUsage({ usage: { rolling: { percent: 5, resetsAt: "2999-01-01T00:00:00Z" } } }, now)
  assert.equal(farFuture[0].resetsAtMs, 0)
})

test("buildSparklinePoints computes min and max above 100", () => {
  const now = 1_700_000_000_000
  const spark = buildSparklinePoints(
    [
      { at: now - 2 * 60_000, rolling: 105 },
      { at: now - 60_000, rolling: 110 },
      { at: now, rolling: 108 },
    ],
    "rolling",
    200,
    24,
  )
  assert.ok(spark !== null)
  assert.equal(spark.min, 105)
  assert.equal(spark.max, 110)
})

test("selectSnapshotsForClient never exceeds a small limit", () => {
  const now = 1_700_000_000_000
  const history = [
    { at: now - 4 * 3_600_000, rolling: 5 },
    { at: now - 60 * 60_000, rolling: 15 },
    { at: now - 30 * 60_000, rolling: 25 },
    { at: now - 10 * 60_000, rolling: 32 },
  ]
  const picked = selectSnapshotsForClient(history, now, 2)
  assert.equal(picked.length, 2)
  assert.equal(picked[picked.length - 1].at, now - 10 * 60_000)
})

test("recordUsageSnapshot records a new snapshot when the reset changes", () => {
  const now = 1_700_000_000_000
  const row = {
    key: "rolling" as const,
    label: "5h",
    used: 10,
    status: "ok",
    resetsAt: "19:00",
    resetsAtMs: now + 3_600_000,
    resetsIn: "1h",
  }
  const first = recordUsageSnapshot([], [row], now - 60_000)
  assert.equal(first.length, 1)
  const next = recordUsageSnapshot(first, [{ ...row, resetsAtMs: now + 5 * 3_600_000 }], now)
  assert.equal(next.length, 2)
})

test("emptyCard remains plain data", () => {
  const card = emptyCard("boom")
  assert.equal(card.ok, false)
  assert.deepEqual(card.rows, [])
  assert.equal(card.error, "boom")
})

test("paceSummary exposes margin and time-to-full for hot windows", () => {
  const now = 1_700_000_000_000
  const weekMs = 7 * 86_400_000
  const row = {
    key: "weekly" as const,
    label: "1w",
    used: 70,
    status: "ok",
    resetsAt: "Fri",
    resetsAtMs: now + Math.round(weekMs * 0.64),
    resetsIn: "4d 12h",
  }
  const summary = paceSummary([row], now)
  assert.equal(summary?.kind, "hot")
  assert.equal(summary?.windowKey, "weekly")
  assert.ok((summary?.timeToFullMs ?? 0) > 0)
  assert.ok((summary?.marginMs ?? 0) >= 60_000)
})
