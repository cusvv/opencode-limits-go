import { test } from "node:test"
import assert from "node:assert/strict"
import {
  CodedError,
  alertMessage,
  bar,
  cardDetail,
  cardText,
  compareSemver,
  emptyCard,
  errorText,
  formatError,
  isNewerVersion,
  newAlerts,
  normalizeLocale,
  parseUsage,
  retry,
  sourceLabel,
  span,
  tightLine,
} from "./index.ts"

const NOW = Date.parse("2026-11-17T10:00:00Z")

test("normalizeLocale picks ru only for Russian locales", () => {
  assert.equal(normalizeLocale("ru"), "ru")
  assert.equal(normalizeLocale("ru-RU"), "ru")
  assert.equal(normalizeLocale("en-US"), "en")
  assert.equal(normalizeLocale(undefined), "en")
})

test("span: past reset is reported as passed, not as 'less than a minute'", () => {
  assert.equal(span(-5 * 60_000, "ru"), "сброс прошёл, обнови")
  assert.equal(span(0, "ru"), "сброс прошёл, обнови")
  assert.equal(span(0, "en"), "reset passed, refresh")
})

test("span: formats minutes, hours and days in EN and RU", () => {
  assert.equal(span(10_000, "ru"), "меньше минуты")
  assert.equal(span(10_000, "en"), "< 1m")
  assert.equal(span(30_000, "ru"), "1м")
  assert.equal(span(12 * 60_000, "en"), "12m")
  assert.equal(span(3 * 3_600_000 + 5 * 60_000, "ru"), "3ч 05м")
  assert.equal(span(3 * 3_600_000 + 5 * 60_000, "en"), "3h 05m")
  assert.equal(span(2 * 86_400_000 + 4 * 3_600_000, "ru"), "2д 4ч")
  assert.equal(span(2 * 86_400_000 + 4 * 3_600_000, "en"), "2d 4h")
})

test("bar: clamps out-of-range percents", () => {
  assert.equal(bar(-5, 4), "░░░░")
  assert.equal(bar(150, 4), "████")
  assert.equal(bar(50, 4), "██░░")
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
    "en",
  )
  assert.deepEqual(rows.map((r) => r.label), ["5h", "1w", "1m"])
  assert.deepEqual(rows.map((r) => r.key), ["rolling", "weekly", "monthly"])
  assert.equal(rows[0].used, 12)
  assert.equal(rows[0].resetsIn, "2h 00m")
  assert.equal(rows[1].status, "limited")
  assert.equal(rows[1].resetsIn, "1h 00m")
  assert.equal(rows[2].resetsIn, "2h 00m")
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

test("formatError translates server error codes into EN and RU", () => {
  assert.match(formatError("NO_TOKEN", undefined, "en"), /No OpenCode Go token found/)
  assert.match(formatError("NO_TOKEN", undefined, "ru"), /Нет токена OpenCode Go/)
  assert.equal(formatError("INVALID_PERCENT", "rolling", "en"), "Window 5h: invalid percent")
  assert.equal(formatError("INVALID_PERCENT", "rolling", "ru"), "Окно 5ч: некорректный процент")
})

test("cardText, tightLine, alertMessage, cardDetail format cleanly in EN and RU", () => {
  const rows = parseUsage(
    { usage: { rolling: { percent: 5 }, monthly: { percent: 44, resetsAt: NOW - 10_000 } } },
    NOW,
    "en",
  )
  const card = { ...emptyCard(""), ok: true, checkedAt: "10:00:00", source: "integration:key", rows }
  assert.equal(cardText(card, "ru"), "5ч 5% · 1м 44%")
  assert.equal(cardText(card, "en"), "5h 5% · 1m 44%")
  assert.equal(tightLine(rows, NOW, "ru"), "Ближе всех: 1м — 44%, запас 56% (сброс прошёл, обнови)")
  assert.equal(tightLine(rows, NOW, "en"), "Tightest: 1m — 44%, 56% left (reset passed, refresh)")
  assert.equal(alertMessage(rows[1], NOW, "ru"), "Лимит 1м: 44% (сброс прошёл, обнови)")
  assert.equal(alertMessage(rows[1], NOW, "en"), "Limit 1m: 44% (reset passed, refresh)")
  assert.equal(sourceLabel("integration:key", "en"), "OpenCode integration (API key)")
  const detailRu = cardDetail(card, NOW, "ru")
  assert.match(detailRu, /^Проверено: 10:00:00 · интеграция OpenCode \(API-ключ\)/)
  assert.doesNotMatch(detailRu, /сброс через сброс прошёл/)
})

test("errorText redacts Bearer and prefixed secrets", () => {
  const msg = errorText(new Error("failed with Bearer sk-ant-secret123 and st_abcdef12345 and gho_secret999"))
  assert.doesNotMatch(msg, /secret123|abcdef12345|secret999/)
  assert.match(msg, /\[REDACTED\]/)
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

test("estimateWindowPace suppresses tiny/early-window noise and flags heavy bursts", async () => {
  const { estimateWindowPace, paceSummary } = await import("./index.ts")
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
  assert.equal(estimateWindowPace(earlyNoise, now, "en"), null)

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
  assert.equal(estimateWindowPace(tinyUsage, now, "en"), null)

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
  const burstPace = estimateWindowPace(burst, now, "en")
  assert.equal(burstPace?.kind, "hot")
  assert.ok(paceSummary([burst], now, "en")?.text.includes("Pace"))

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
  const steadyPace = estimateWindowPace(steady, now, "en")
  assert.equal(steadyPace?.kind, "steady")
  assert.ok(paceSummary([steady], now, "en")?.text.includes("comfortable"))

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
  const summary = paceSummary([exhausted, steady], now, "ru")
  assert.equal(summary?.kind, "exhausted")
  assert.ok(summary?.text.includes("исчерпан"))
})

test("cardDetail appends smart pace line when significant", async () => {
  const { cardDetail } = await import("./index.ts")
  const now = 1_700_000_000_000
  const weekMs = 7 * 24 * 60 * 60 * 1000

  const card = {
    ok: true as const,
    org: "OpenCode",
    email: "user@example.com",
    source: "key" as const,
    checkedAt: "12:00",
    checkedAtMs: now,
    tight: "",
    error: "",
    rows: [
      {
        key: "weekly" as const,
        label: "Weekly",
        used: 70,
        resetsIn: "4d 12h",
        resetsAt: "Fri",
        resetsAtMs: now + Math.round(weekMs * 0.64),
        status: "ok",
      },
    ],
  }

  const detailEn = cardDetail(card, now, "en")
  const detailRu = cardDetail(card, now, "ru")
  assert.ok(detailEn.includes("Pace (1w):"))
  assert.ok(detailRu.includes("Темп (1н):"))
})

test("filterStripRows selects enabled windows and falls back if none are selected", async () => {
  const { filterStripRows, rowWindowKey } = await import("./index.ts")
  const rows = [
    { key: "rolling" as const, label: "5h", used: 12, status: "ok", resetsAt: "", resetsIn: "" },
    { label: "1н", used: 40, status: "ok", resetsAt: "", resetsIn: "" },
    { key: "monthly" as const, label: "1m", used: 65, status: "ok", resetsAt: "", resetsIn: "" },
  ]

  assert.equal(rowWindowKey(rows[1]), "weekly")

  const only5h = filterStripRows(rows, { rolling: true, weekly: false, monthly: false })
  assert.deepEqual(only5h.map((r) => r.label), ["5h"])

  const fallbackAll = filterStripRows(rows, { rolling: false, weekly: false, monthly: false })
  assert.equal(fallbackAll.length, 3)
})

test("history ring buffer computes recent deltas, detects late-window bursts, and calculates elapsed ratio", async () => {
  const { attachHistoryDeltas, estimateWindowPace, recordUsageSnapshot, windowElapsedRatio } = await import("./index.ts")
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

  const pace = estimateWindowPace(row, now, "en", history)
  assert.equal(pace?.kind, "hot")

  const ratio = windowElapsedRatio(row, now)
  assert.ok(ratio !== null && Math.abs(ratio - 0.7) < 0.01)
})

test("newAlerts supports custom warning thresholds and summarizeStatsByProvider splits Go vs Zen", async () => {
  const { formatTokensCompact, formatUsd, newAlerts, summarizeStatsByProvider } = await import("./index.ts")

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
  assert.equal(formatTokensCompact(1700), "2k")
  assert.equal(formatTokensCompact(1_500_000), "1.5M")
  assert.equal(formatUsd(0.046), "$0.05")
  assert.equal(formatUsd(0.004), "$0.0040")
})

test("formatTuiSidebar supports window filter, inline mini-bars, and hot pace indicator", async () => {
  const { cardDetail, formatTuiSidebar } = await import("./index.ts")
  const now = 1_700_000_000_000
  const hourMs = 3_600_000
  const card = {
    ok: true as const,
    org: "Personal",
    email: "dev@example.com",
    source: "integration:oauth",
    checkedAt: "14:20:05",
    tight: "",
    error: "",
    rows: [
      { key: "rolling" as const, label: "5h", used: 50, status: "ok", resetsAt: "18:00", resetsAtMs: now + 4 * hourMs, resetsIn: "4h", delta1h: 12 },
      { key: "weekly" as const, label: "1w", used: 26, status: "ok", resetsAt: "Sun", resetsAtMs: now + 5 * 86_400_000, resetsIn: "5d" },
    ],
  }

  const plain = formatTuiSidebar(card, { rolling: true, weekly: false, monthly: false }, false, "en", now)
  assert.equal(plain, "5h 50%⚡")

  const withBars = formatTuiSidebar(card, { rolling: true, weekly: true, monthly: false }, true, "en", now)
  assert.ok(withBars.includes("5h ██░░ 50%⚡"))
  assert.ok(withBars.includes("1w █░░░ 26%"))

  const detail = cardDetail(card, now, "en", ["Today: Go 142k tok · Zen $0.04"])
  assert.ok(detail.includes("+12%"))
  assert.ok(detail.includes("Today: Go 142k tok · Zen $0.04"))
})

test("recoveredAlerts detects drop from 100% and resetAlertMessage localizes cleanly", async () => {
  const { recoveredAlerts, resetAlertMessage } = await import("./index.ts")
  const exhausted = new Set<string>()
  const rowFull = { key: "rolling" as const, label: "5h", used: 100, status: "limited", resetsAt: "", resetsIn: "" }
  const rowReset = { key: "rolling" as const, label: "5h", used: 0, status: "ok", resetsAt: "", resetsIn: "" }

  assert.equal(recoveredAlerts([rowFull], exhausted).length, 0)
  assert.ok(exhausted.has("rolling"))

  const rec = recoveredAlerts([rowReset], exhausted)
  assert.equal(rec.length, 1)
  assert.equal(exhausted.has("rolling"), false)
  assert.match(resetAlertMessage(rec[0], "en"), /5h limit reset/)
  assert.match(resetAlertMessage(rec[0], "ru"), /Лимит 5ч сброшен/)

  // Second poll at 0% must not re-fire.
  assert.equal(recoveredAlerts([rowReset], exhausted).length, 0)
})

test("shortErrorLabel, relativeAge, displayPercent, and accountKey work as expected", async () => {
  const { accountKey, displayPercent, relativeAge, shortErrorLabel } = await import("./index.ts")
  assert.equal(shortErrorLabel("No OpenCode Go token found. Run: opencode auth login", "en"), "no token")
  assert.equal(shortErrorLabel("Нет токена OpenCode Go. Выполни...", "ru"), "нет токена")
  assert.equal(shortErrorLabel("HTTP 401: Unauthorized", "en"), "auth error")
  assert.equal(shortErrorLabel("HTTP 429: Too Many Requests", "ru"), "слишком часто")
  assert.equal(shortErrorLabel("fetch failed: ECONNREFUSED", "en"), "offline")
  assert.equal(shortErrorLabel("some random failure", "ru"), "ошибка")

  assert.equal(displayPercent(82, false), 82)
  assert.equal(displayPercent(82, true), 18)
  assert.equal(displayPercent(120, true), 0)

  assert.equal(relativeAge(NOW - 10_000, NOW, "en"), "just now")
  assert.equal(relativeAge(NOW - 10_000, NOW, "ru"), "только что")
  assert.equal(relativeAge(NOW - 5 * 60_000, NOW, "en"), "5m ago")
  assert.equal(relativeAge(NOW - 2 * 3_600_000, NOW, "ru"), "2ч назад")

  assert.equal(accountKey(" Personal ", "Dev@Example.com", "integration:oauth"), "personal|dev@example.com|integration:oauth")
})

test("selectSnapshotsForClient preserves 15m-4h anchor snapshots during rapid bursts", async () => {
  const { selectSnapshotsForClient } = await import("./index.ts")
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

test("summarizeStatsByProvider extracts topModels and formatTuiSidebar shows remaining % and exhausted reset countdown", async () => {
  const { formatTuiSidebar, summarizeStatsByProvider } = await import("./index.ts")
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

  const now = 1_700_000_000_000
  const card = {
    ok: true as const,
    org: "Personal",
    email: "",
    source: "",
    checkedAt: "",
    tight: "",
    error: "",
    rows: [
      { key: "rolling" as const, label: "5h", used: 100, status: "limited", resetsAt: "", resetsAtMs: now + 42 * 60_000, resetsIn: "42m" },
      { key: "weekly" as const, label: "1w", used: 30, status: "ok", resetsAt: "", resetsAtMs: now + 3 * 86_400_000, resetsIn: "3d" },
    ],
  }
  const exhaustedText = formatTuiSidebar(card, { rolling: true, weekly: true, monthly: false }, false, "en", now, false)
  assert.equal(exhaustedText, "5h 100% (42m) · 1w 30%")

  const remainingText = formatTuiSidebar(card, { rolling: true, weekly: true, monthly: false }, false, "en", now, true)
  assert.equal(remainingText, "5h 0% (42m) · 1w 70%")
})

test("selectStripRows tightest mode, shouldHideStrip, 12h shortDate, nextResetDelayMs, detectBurnSpike, and buildSparklinePoints", async () => {
  const {
    buildSparklinePoints,
    burnSpikeMessage,
    detectBurnSpike,
    nextResetDelayMs,
    selectStripRows,
    shortDate,
    shouldHideStrip,
  } = await import("./index.ts")

  const now = Date.parse("2026-11-19T15:30:00Z")
  const rows = [
    { key: "rolling" as const, label: "5h", used: 35, status: "ok", resetsAt: "", resetsAtMs: now + 2 * 3_600_000, resetsIn: "2h" },
    { key: "weekly" as const, label: "1w", used: 62, status: "ok", resetsAt: "", resetsAtMs: now + 3 * 86_400_000, resetsIn: "3d" },
    { key: "monthly" as const, label: "1m", used: 62, status: "ok", resetsAt: "", resetsAtMs: now + 10 * 86_400_000, resetsIn: "10d" },
  ]
  const tightest = selectStripRows(rows, { rolling: true, weekly: true, monthly: true }, "tightest")
  assert.equal(tightest.length, 1)
  assert.equal(tightest[0].key, "weekly")

  assert.equal(shouldHideStrip(rows, 0), false)
  assert.equal(shouldHideStrip(rows, 70), true)
  assert.equal(shouldHideStrip(rows, 50), false)

  assert.match(shortDate(now, "12h"), /\d{2}\.\d{2} \d{1,2}:\d{2} (?:AM|PM)/)
  assert.equal(nextResetDelayMs(rows, now), 2 * 3_600_000 + 3_000)

  const snaps = [
    { at: now - 20 * 60_000, rolling: 10 },
    { at: now - 10 * 60_000, rolling: 22 },
    { at: now - 1 * 60_000, rolling: 35 },
  ]
  const spike = detectBurnSpike(rows, snaps, 20, now)
  assert.ok(spike !== null)
  assert.equal(spike.delta, 25)
  assert.match(burnSpikeMessage(spike, "en"), /Fast burn on 5h: \+25%/)
  assert.match(burnSpikeMessage(spike, "ru"), /Быстрый расход 5ч: \+25%/)

  const spark = buildSparklinePoints(snaps, "rolling", 200, 24)
  assert.ok(spark !== null)
  assert.equal(spark.min, 10)
  assert.equal(spark.max, 35)
  assert.equal(spark.count, 3)
  assert.ok(spark.polyline.includes(","))
})
