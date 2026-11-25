import { test } from "node:test"
import assert from "node:assert/strict"
import {
  type LimitCard,
  detectBurnSpike,
  emptyCard,
  paceSummary,
  parseUsage,
  windowVerdict,
} from "../core/index.ts"
import { MESSAGE_KEYS, en, message, ru } from "../i18n/index.ts"
import {
  alertMessage,
  bar,
  asciiBar,
  burnSpikeMessage,
  cardDetail,
  cardErrorText,
  cardText,
  displayPercent,
  formatError,
  formatTokensCompact,
  formatTuiSidebar,
  formatUsd,
  localizeRows,
  paceSummaryText,
  relativeAge,
  resetAlertMessage,
  resetText,
  shortErrorLabel,
  sourceLabel,
  span,
  tightLine,
  windowLabel,
  windowVerdictText,
} from "./index.ts"

const NOW = Date.parse("2026-11-17T10:00:00Z")

function cardFixture(rows = parseUsage({ usage: { rolling: { percent: 5 }, monthly: { percent: 44, resetsAt: NOW - 10_000 } } }, NOW)): LimitCard {
  return { ...emptyCard(""), ok: true, checkedAt: "10:00:00", source: "integration:key", rows }
}

test("i18n dictionaries have the same non-empty key set in EN and RU", () => {
  const enKeys = Object.keys(en).sort()
  const ruKeys = Object.keys(ru).sort()
  assert.deepEqual(ruKeys, enKeys)
  assert.deepEqual([...MESSAGE_KEYS].sort(), enKeys)
  for (const key of MESSAGE_KEYS) {
    assert.ok(en[key].trim().length > 0, `empty EN value for ${key}`)
    assert.ok(ru[key].trim().length > 0, `empty RU value for ${key}`)
  }
})

test("window labels come from the shared dictionaries", () => {
  assert.equal(windowLabel({ key: "rolling", label: "" }, "en"), "5h")
  assert.equal(windowLabel({ key: "rolling", label: "" }, "ru"), "5ч")
  assert.equal(windowLabel({ key: "weekly", label: "" }, "en"), "1w")
  assert.equal(windowLabel({ key: "weekly", label: "" }, "ru"), "1нед")
  assert.equal(windowLabel({ key: "monthly", label: "" }, "ru"), "1мес")
  assert.equal(windowLabel({ label: "1w" }, "ru"), "1нед")
  assert.equal(windowLabel({ label: "1нед" }, "en"), "1w")
  assert.equal(message("ru", "window.weekly"), "1нед")
  assert.equal(message("ru", "window.monthly"), "1мес")
})

test("span: past reset is reported as passed, not as 'less than a minute'", () => {
  assert.equal(span(-5 * 60_000, "ru"), "сброс прошёл, обнови")
  assert.equal(span(0, "ru"), "сброс прошёл, обнови")
  assert.equal(span(0, "en"), "reset passed, refresh")
})

test("span: formats minutes, hours and days in EN and RU", () => {
  assert.equal(span(10_000, "ru"), "< 1 мин")
  assert.equal(span(10_000, "en"), "< 1m")
  assert.equal(span(30_000, "ru"), "1м")
  assert.equal(span(12 * 60_000, "en"), "12m")
  assert.equal(span(3 * 3_600_000 + 5 * 60_000, "ru"), "3ч 05м")
  assert.equal(span(3 * 3_600_000 + 5 * 60_000, "en"), "3h 05m")
  assert.equal(span(2 * 86_400_000 + 4 * 3_600_000, "ru"), "2д 4ч")
  assert.equal(span(2 * 86_400_000 + 4 * 3_600_000, "en"), "2d 4h")
})

test("resetText detects a passed reset from legacy fallback text", () => {
  assert.deepEqual(resetText(undefined, "сброс прошёл, обнови", NOW, "en"), {
    passed: true,
    text: "reset passed, refresh",
  })
  assert.deepEqual(resetText(undefined, "", NOW, "en"), { passed: false, text: "?" })
})

test("bar and asciiBar clamp out-of-range percents", () => {
  assert.equal(bar(-5, 4), "░░░░")
  assert.equal(bar(150, 4), "████")
  assert.equal(bar(50, 4), "██░░")
  assert.equal(asciiBar(-5, 4), "----")
  assert.equal(asciiBar(150, 4), "####")
  assert.equal(asciiBar(50, 4), "##--")
})

test("formatError translates server error codes into EN and RU", () => {
  assert.match(formatError("NO_TOKEN", undefined, "en"), /No OpenCode Go token found/)
  assert.match(formatError("NO_TOKEN", undefined, "ru"), /Нет токена OpenCode Go/)
  assert.equal(formatError("INVALID_PERCENT", "rolling", "en"), "Window 5h: invalid percent")
  assert.equal(formatError("INVALID_PERCENT", "rolling", "ru"), "Окно 5ч: некорректный процент")
  assert.equal(formatError("INVALID_PERCENT", "INVALID_PERCENT: rolling", "en"), "Window 5h: invalid percent")
  assert.equal(formatError("FETCH_FAILED", "FETCH_FAILED: boom", "en"), "Failed to load limits: boom")
  assert.equal(formatError("AUTH", undefined, "en"), "OpenCode Go token is invalid or expired.")
  assert.equal(formatError("RATE_LIMIT", undefined, "ru"), "Слишком много запросов к OpenCode Go. Повтори позже.")
  assert.match(formatError("FETCH_FAILED", "HTTP 401 no", "en"), /token is expired or invalid/)
})

test("cardText, tightLine, alertMessage, and cardDetail format cleanly in EN and RU", () => {
  const rows = parseUsage(
    { usage: { rolling: { percent: 5 }, monthly: { percent: 44, resetsAt: NOW - 10_000 } } },
    NOW,
  )
  const card = cardFixture(rows)
  assert.equal(cardText(card, "ru"), "5ч 5% · 1мес 44%")
  assert.equal(cardText(card, "en"), "5h 5% · 1m 44%")
  assert.equal(tightLine(rows, NOW, "ru"), "Риск: 1мес — 44%, запас 56% (сброс прошёл, обнови)")
  assert.equal(tightLine(rows, NOW, "en"), "At risk: 1m — 44%, 56% left (reset passed, refresh)")
  assert.equal(alertMessage(rows[1], NOW, "ru"), "Лимит 1мес: 44% (сброс прошёл, обнови)")
  assert.equal(alertMessage(rows[1], NOW, "en"), "Limit 1m: 44% (reset passed, refresh)")
  assert.equal(sourceLabel("integration:key", "en"), "OpenCode integration (API key)")
  assert.equal(sourceLabel("integration:key", "ru"), "интеграция OpenCode (API-ключ)")
  assert.equal(sourceLabel("unknown", "en"), "")
  const detailRu = cardDetail(card, NOW, "ru")
  assert.match(detailRu, /^Проверено: 10:00:00 · интеграция OpenCode \(API-ключ\)/)
  assert.doesNotMatch(detailRu, /сброс через сброс прошёл/)
})

test("alertMessage does not claim a limited window is only at its reported percent", () => {
  const row = {
    key: "rolling" as const,
    label: "5h",
    used: 42,
    status: "limited",
    resetsAt: "18:00",
    resetsAtMs: NOW + 3_600_000,
    resetsIn: "1h",
  }
  assert.equal(alertMessage(row, NOW, "en"), "5h limit reached (42% reported), resets: 1h 00m")
  assert.equal(alertMessage(row, NOW, "ru"), "Лимит 5ч исчерпан (в API 42%), сброс: 1ч 00м")
})

test("resetAlertMessage and burnSpikeMessage localize cleanly", () => {
  const row = { key: "rolling" as const, label: "5h", used: 0, status: "ok", resetsAt: "", resetsIn: "" }
  assert.match(resetAlertMessage(row, "en"), /5h limit reset/)
  assert.match(resetAlertMessage(row, "ru"), /Лимит 5ч сброшен/)

  const now = Date.parse("2026-11-19T15:30:00Z")
  const rows = [
    { key: "rolling" as const, label: "5h", used: 35, status: "ok", resetsAt: "", resetsAtMs: now + 2 * 3_600_000, resetsIn: "2h" },
  ]
  const snaps = [
    { at: now - 20 * 60_000, rolling: 10 },
    { at: now - 10 * 60_000, rolling: 22 },
    { at: now - 1 * 60_000, rolling: 35 },
  ]
  const spike = detectBurnSpike(rows, snaps, 20, now)
  assert.ok(spike !== null)
  assert.match(burnSpikeMessage(spike, "en"), /Fast burn on 5h: \+25%/)
  assert.match(burnSpikeMessage(spike, "ru"), /Быстрый расход 5ч: \+25%/)
})

test("shortErrorLabel, relativeAge, and displayPercent work as expected", () => {
  assert.equal(shortErrorLabel("No OpenCode Go token found. Run: opencode auth login", "en"), "no token")
  assert.equal(shortErrorLabel("Нет токена OpenCode Go. Выполни...", "ru"), "нет токена")
  assert.equal(shortErrorLabel("HTTP 401: Unauthorized", "en"), "auth error")
  assert.equal(shortErrorLabel("HTTP 429: Too Many Requests", "ru"), "слишком часто")
  assert.equal(shortErrorLabel("fetch failed: ECONNREFUSED", "en"), "offline")
  assert.equal(shortErrorLabel("some random failure", "ru"), "ошибка")
  assert.equal(shortErrorLabel(undefined, "en"), "no data")

  assert.equal(displayPercent(82, false), 82)
  assert.equal(displayPercent(82, true), 18)
  assert.equal(displayPercent(120, true), 0)

  assert.equal(relativeAge(NOW - 10_000, NOW, "en"), "just now")
  assert.equal(relativeAge(NOW - 10_000, NOW, "ru"), "только что")
  assert.equal(relativeAge(NOW - 5 * 60_000, NOW, "en"), "5m ago")
  assert.equal(relativeAge(NOW - 2 * 3_600_000, NOW, "ru"), "2ч назад")
})

test("formatTokensCompact and formatUsd format compact stats", () => {
  assert.equal(formatTokensCompact(1700), "2k")
  assert.equal(formatTokensCompact(1_500_000), "1.5M")
  assert.equal(formatTokensCompact(999_999), "1.0M")
  assert.equal(formatUsd(0.046), "$0.05")
  assert.equal(formatUsd(0.004), "$0.0040")
  assert.equal(formatUsd(0), "$0.00")
})

test("formatTuiSidebar supports window filter, inline mini-bars, and hot pace indicator", () => {
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

test("formatTuiSidebar uses remaining % for the bar and shows reset countdown above warning", () => {
  const now = Date.now()
  const card = {
    ok: true as const,
    org: "",
    email: "",
    checkedAt: "",
    source: "",
    tight: "",
    error: "",
    rows: [
      {
        key: "rolling" as const,
        label: "5h",
        used: 92,
        status: "ok",
        resetsAt: "",
        resetsAtMs: now + 20 * 60_000,
        resetsIn: "",
      },
    ],
  }
  const text = formatTuiSidebar(card, { rolling: true, weekly: false, monthly: false }, true, "en", now, true, 80)
  assert.match(text, /5h ░░░░ 8% \(20m\)/)
})

test("formatTuiSidebar shows remaining % and exhausted reset countdown", () => {
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

test("cardDetail appends smart pace line when significant", () => {
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
  assert.ok(detailRu.includes("Темп (1нед):"))
})

test("windowVerdictText localizes exhausted, tight, and fits verdicts", () => {
  const now = Date.parse("2026-11-17T10:00:00Z")
  const tightRow = {
    key: "weekly" as const,
    label: "1w",
    used: 60,
    status: "ok",
    resetsAt: "Sun",
    resetsAtMs: now + 4 * 86_400_000,
    resetsIn: "4d",
  }
  const tight = windowVerdict(tightRow, now)
  assert.ok(tight)
  assert.equal(windowVerdictText(tight, "en"), "1w: ~2d 0h to 100%, resets in 4d 0h")
  assert.equal(windowVerdictText(tight, "ru"), "1нед: ~2д 0ч до 100%, сброс через 4д 0ч")

  const exhaustedRow = {
    key: "rolling" as const,
    label: "5h",
    used: 100,
    status: "limited",
    resetsAtMs: now + 2 * 3_600_000,
    resetsAt: "12:00",
    resetsIn: "2h",
  }
  const exhausted = windowVerdict(exhaustedRow, now)
  assert.ok(exhausted)
  assert.equal(windowVerdictText(exhausted, "en"), "5h: limit reached, resets in 2h 00m")

  const fitsRow = {
    key: "weekly" as const,
    label: "1w",
    used: 20,
    status: "ok",
    resetsAtMs: now + 3.5 * 86_400_000,
    resetsAt: "Sun",
    resetsIn: "3d 12h",
  }
  const fits = windowVerdict(fitsRow, now)
  assert.ok(fits)
  assert.equal(fits.kind, "fits")
  assert.equal(windowVerdictText(fits, "en"), "1w: holds until reset (~40% by reset)")
})

test("paceSummaryText covers hot, comfortable, steady, may-run-out, and exhausted", () => {
  const now = 1_700_000_000_000
  const weekMs = 7 * 86_400_000
  const hotSummary = paceSummary(
    [{ key: "weekly", label: "1w", used: 70, status: "ok", resetsAtMs: now + Math.round(weekMs * 0.64), resetsAt: "", resetsIn: "" }],
    now,
  )
  assert.ok(hotSummary)
  assert.match(paceSummaryText(hotSummary, "en"), /^Pace \(1w\): ~.* until 100% \(.* before reset\)$/)
  assert.match(paceSummaryText(hotSummary, "ru"), /^Темп \(1нед\): хватит на ~/)

  const comfortable = paceSummary(
    [{ key: "weekly", label: "1w", used: 26, status: "ok", resetsAtMs: now + Math.round(weekMs * 0.66), resetsAt: "", resetsIn: "" }],
    now,
  )
  assert.ok(comfortable)
  assert.equal(paceSummaryText(comfortable, "en"), "Pace (1w): comfortable (~76% by reset)")

  const mayRunOut = paceSummary(
    [{ key: "weekly", label: "1w", used: 52, status: "ok", resetsAtMs: now + Math.round(weekMs * 0.5), resetsAt: "", resetsIn: "" }],
    now,
  )
  assert.equal(mayRunOut?.kind, "hot")
  assert.equal(mayRunOut?.timeToFullMs, undefined)
  assert.equal(paceSummaryText(mayRunOut!, "en"), "Pace (1w): projected ~104% by reset — the limit may run out")

  const steady = paceSummary(
    [{ key: "weekly", label: "1w", used: 80, status: "ok", resetsAtMs: now + Math.round(weekMs * 0.1), resetsAt: "", resetsIn: "" }],
    now,
  )
  assert.equal(steady?.kind, "steady")
  assert.equal(paceSummaryText(steady!, "en"), "Pace (1w): steady (~89% by reset)")

  const exhausted = paceSummary(
    [{ key: "weekly", label: "1w", used: 100, status: "limited", resetsAtMs: now + 2 * 86_400_000, resetsAt: "", resetsIn: "" }],
    now,
  )
  assert.equal(paceSummaryText(exhausted!, "en"), "1w limit reached — resets in 2d 0h")
})

test("cardErrorText localizes authoritative codes and falls back to legacy error text", () => {
  const card = { ...emptyCard("AUTH"), errorCode: "AUTH" as const, errorDetail: "HTTP 401: bad token" }
  assert.equal(cardErrorText(card, "en"), "OpenCode Go token is invalid or expired.")
  assert.equal(cardErrorText(card, "ru"), "Токен OpenCode Go неверен или истёк.")
  assert.equal(cardErrorText(null, "ru"), "")
  assert.equal(cardErrorText(undefined, "en"), "")

  const legacy = { ...emptyCard("legacy text") }
  assert.equal(cardErrorText(legacy, "en"), "legacy text")
})

test("formatError covers every ErrorCode and CardErrorCode", () => {
  const errorCodes = ["NO_TOKEN", "INVALID_JSON", "EMPTY_USAGE", "INVALID_PERCENT", "FETCH_FAILED"] as const
  for (const code of errorCodes) {
    const detail = code === "INVALID_PERCENT" ? "rolling" : code === "FETCH_FAILED" ? "boom" : undefined
    const english = formatError(code, detail, "en")
    const russian = formatError(code, detail, "ru")
    assert.ok(english.trim().length > 0, `empty EN message for ${code}`)
    assert.ok(russian.trim().length > 0, `empty RU message for ${code}`)
    assert.notEqual(english, russian, `untranslated message for ${code}`)
  }

  const cardCodes = ["NO_TOKEN", "AUTH", "RATE_LIMIT", "OFFLINE", "BAD_RESPONSE", "CREDENTIALS_CHANGED", "INTERNAL"] as const
  for (const code of cardCodes) {
    const english = formatError(code, undefined, "en")
    const russian = formatError(code, undefined, "ru")
    assert.ok(english.trim().length > 0, `empty EN card message for ${code}`)
    assert.ok(russian.trim().length > 0, `empty RU card message for ${code}`)
    assert.notEqual(english, russian, `untranslated card message for ${code}`)
  }
})

test("localizeRows localizes canonical rows without mutating the input", () => {
  const rows = parseUsage(
    {
      usage: {
        rolling: { percent: 12, resetInSec: 3_600 },
        monthly: { percent: 44, resetsAt: NOW - 10_000 },
      },
    },
    NOW,
  )
  assert.deepEqual(rows.map((row) => row.label), ["5h", "1m"])
  assert.equal(rows[0].resetsIn, "")
  assert.equal(rows[1].resetsIn, "")
  assert.match(rows[0].resetsAt, /^\d{2}\.\d{2} \d{2}:\d{2}$/)

  const localized = localizeRows(rows, NOW, "ru")
  assert.deepEqual(localized.map((row) => row.label), ["5ч", "1мес"])
  assert.equal(localized[0].resetsIn, "1ч 00м")
  assert.equal(localized[1].resetsIn, "сброс прошёл, обнови")
  assert.equal(localized[0].resetsAt, rows[0].resetsAt)
  assert.deepEqual(rows.map((row) => row.label), ["5h", "1m"])

  const legacy = localizeRows(
    [{ label: "1нед", used: 10, status: "ok", resetsAt: "", resetsIn: "" }],
    NOW,
    "en",
  )
  assert.equal(legacy[0].key, "weekly")
  assert.equal(legacy[0].label, "1w")
})
