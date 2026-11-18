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
} from "./model.ts"

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
  const { estimateWindowPace, paceSummary } = await import("./model.ts")
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
  const { cardDetail } = await import("./model.ts")
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
  const { filterStripRows, rowWindowKey } = await import("./model.ts")
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
