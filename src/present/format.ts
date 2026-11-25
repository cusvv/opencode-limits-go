import {
  type CardErrorCode,
  type ErrorCode,
  type LimitCard,
  type LimitRow,
  type Locale,
  type TimeFormat,
  type WindowKey,
  WINDOW_BY_KEY,
  isAuthError,
  rowWindowKey,
  tightestRow,
} from "../core/index.ts"
import { message, type MessageKey } from "../i18n/index.ts"

const pad = (n: number) => String(n).padStart(2, "0")

export function shortDate(isoOrMs: string | number, timeFormat: TimeFormat = "24h"): string {
  const d = new Date(isoOrMs)
  if (Number.isNaN(d.getTime())) return "?"
  const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`
  if (timeFormat === "12h") {
    const h24 = d.getHours()
    const suffix = h24 >= 12 ? "PM" : "AM"
    const h12 = h24 % 12 || 12
    return `${date} ${h12}:${pad(d.getMinutes())} ${suffix}`
  }
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function span(ms: number, lang: Locale = "en"): string {
  if (ms <= 0) return message(lang, "span.passed")
  const m = Math.round(ms / 60_000)
  if (m < 1) return message(lang, "span.lessThanMinute")
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d) return message(lang, "span.daysHours", { d, h })
  if (h) return message(lang, "span.hoursMinutes", { h, m: pad(m % 60) })
  return message(lang, "span.minutes", { m })
}

export function resetText(
  resetsAtMs: number | undefined,
  fallbackResetsIn: string,
  now: number,
  lang: Locale = "en",
): { passed: boolean; text: string } {
  if (typeof resetsAtMs === "number" && resetsAtMs > 0) {
    const diff = resetsAtMs - now
    return { passed: diff <= 0, text: span(diff, lang) }
  }
  if (
    fallbackResetsIn === message("en", "span.passed") ||
    fallbackResetsIn === message("ru", "span.passed")
  ) {
    return { passed: true, text: span(0, lang) }
  }
  return { passed: false, text: fallbackResetsIn || "?" }
}

export function bar(percent: number, width = 20): string {
  const filled = Math.round((width * Math.min(Math.max(percent, 0), 100)) / 100)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

export function asciiBar(percent: number, width = 10): string {
  const filled = Math.round((width * Math.min(Math.max(percent, 0), 100)) / 100)
  return `${"#".repeat(filled)}${"-".repeat(width - filled)}`
}

const WINDOW_LABEL_KEYS: Record<WindowKey, MessageKey> = {
  rolling: "window.rolling",
  weekly: "window.weekly",
  monthly: "window.monthly",
}

const WINDOW_KEYS_BY_LABEL = new Map<string, WindowKey>(
  (["en", "ru"] as const).flatMap((lang) =>
    (["rolling", "weekly", "monthly"] as const).map(
      (key) => [message(lang, WINDOW_LABEL_KEYS[key]), key] as const,
    ),
  ),
)

/** Resolves a localized legacy label (e.g. "1нед") to its window key. */
export function windowKeyForLabel(label: string): WindowKey | undefined {
  return WINDOW_KEYS_BY_LABEL.get(label)
}

export function windowLabelForKey(key: WindowKey, lang: Locale = "en"): string {
  return message(lang, WINDOW_LABEL_KEYS[key])
}

export function windowLabel(row: Pick<LimitRow, "key" | "label">, lang: Locale = "en"): string {
  const key = rowWindowKey(row) ?? windowKeyForLabel(row.label)
  if (key) return windowLabelForKey(key, lang)
  return row.label
}

export function localizeRows(rows: LimitRow[], now: number, lang: Locale): LimitRow[] {
  return rows.map((row) => {
    const { text } = resetText(row.resetsAtMs, row.resetsIn, now, lang)
    return {
      ...row,
      key: row.key ?? windowKeyForLabel(row.label),
      label: windowLabel(row, lang),
      resetsAt: row.resetsAtMs && row.resetsAtMs > 0 ? shortDate(row.resetsAtMs) : row.resetsAt,
      resetsIn: row.resetsAtMs ? text : row.resetsIn,
    }
  })
}

const ERROR_MESSAGES = {
  NO_TOKEN: "error.NO_TOKEN",
  INVALID_JSON: "error.INVALID_JSON",
  EMPTY_USAGE: "error.EMPTY_USAGE",
  FETCH_FAILED: "error.FETCH_FAILED",
  AUTH: "cardError.AUTH",
  RATE_LIMIT: "cardError.RATE_LIMIT",
  OFFLINE: "cardError.OFFLINE",
  BAD_RESPONSE: "cardError.BAD_RESPONSE",
  CREDENTIALS_CHANGED: "cardError.CREDENTIALS_CHANGED",
  INTERNAL: "cardError.INTERNAL",
} as const satisfies Partial<Record<ErrorCode | CardErrorCode, MessageKey>>

/** errorText() stores "CODE: detail"; strip the code before using the detail as a message argument. */
function detailArgument(code: string, detail: string | undefined): string | undefined {
  if (!detail) return detail
  const prefix = `${code}:`
  return detail.startsWith(prefix) ? detail.slice(prefix.length).trim() : detail
}

export function formatError(
  code: ErrorCode | CardErrorCode | undefined,
  detail: string | undefined,
  lang: Locale = "en",
): string {
  switch (code) {
    case "INVALID_PERCENT": {
      const raw = detailArgument("INVALID_PERCENT", detail)
      const key = raw && WINDOW_BY_KEY.has(raw) ? (raw as WindowKey) : undefined
      const label = key ? windowLabelForKey(key, lang) : raw || "?"
      return message(lang, "error.INVALID_PERCENT", { label })
    }
    case "FETCH_FAILED": {
      const cause = detailArgument("FETCH_FAILED", detail)
      if (isAuthError(cause)) return message(lang, "error.FETCH_FAILED_AUTH")
      return message(lang, "error.FETCH_FAILED", { cause: cause || message(lang, "error.noCredentials") })
    }
    case "NO_TOKEN":
    case "INVALID_JSON":
    case "EMPTY_USAGE":
    case "AUTH":
    case "RATE_LIMIT":
    case "OFFLINE":
    case "BAD_RESPONSE":
    case "CREDENTIALS_CHANGED":
    case "INTERNAL":
      return message(lang, ERROR_MESSAGES[code])
    default:
      return detail || message(lang, "error.unknown")
  }
}

const SOURCE_LABEL_KEYS: Record<string, MessageKey> = {
  integration: "source.integration",
  "integration:oauth": "source.integrationOauth",
  "integration:key": "source.integrationKey",
  "integration:env": "source.integrationEnv",
  env: "source.env",
  config: "source.config",
  "auth.json": "source.authJson",
  cli: "source.cli",
}

/**
 * User-facing error text for a card. `errorCode`/`errorDetail` are authoritative;
 * `error` is the legacy machine code kept for older hosts.
 */
export function cardErrorText(card: LimitCard | null | undefined, lang: Locale = "en"): string {
  if (!card) return ""
  if (card.errorCode) return formatError(card.errorCode, card.errorDetail, lang)
  return card.error
}

export function sourceLabel(source: string, lang: Locale = "en"): string {
  const key = SOURCE_LABEL_KEYS[source]
  return key ? message(lang, key) : ""
}

export function cardText(card: LimitCard, lang: Locale = "en"): string {
  if (!card.ok) return message(lang, "card.error", { prefix: message(lang, "card.limits"), error: cardErrorText(card, lang) })
  return card.rows.map((row) => `${windowLabel(row, lang)} ${row.used}%`).join(" · ")
}

export function displayPercent(used: number, showRemaining = false): number {
  const clamped = Math.min(100, Math.max(0, Math.round(used)))
  return showRemaining ? 100 - clamped : clamped
}

export function shortErrorLabel(error: string | undefined, lang: Locale = "en"): string {
  const raw = (error ?? "").toLowerCase()
  if (!raw) return message(lang, "shortError.noData")
  if (raw.includes("no_token") || raw.includes("no opencode go token") || raw.includes("нет токена") || raw.includes("не найден")) {
    return message(lang, "shortError.noToken")
  }
  if (
    raw.includes("401") ||
    raw.includes("403") ||
    raw.includes("unauthorized") ||
    raw.includes("forbidden") ||
    raw.includes("invalid or expired") ||
    raw.includes("неверен или истёк")
  ) {
    return message(lang, "shortError.auth")
  }
  if (raw.includes("429") || raw.includes("rate limit") || raw.includes("слишком много")) {
    return message(lang, "shortError.rateLimited")
  }
  if (
    raw.includes("cannot reach") ||
    raw.includes("нет связи") ||
    raw.includes("fetch failed") ||
    raw.includes("enotfound") ||
    raw.includes("econnrefused") ||
    raw.includes("timeout") ||
    raw.includes("aborted")
  ) {
    return message(lang, "shortError.offline")
  }
  return message(lang, "shortError.error")
}

export function relativeAge(checkedAtMs: number | undefined, now = Date.now(), lang: Locale = "en"): string {
  if (!checkedAtMs || checkedAtMs <= 0) return ""
  const diff = Math.max(0, now - checkedAtMs)
  if (diff < 45_000) return message(lang, "age.justNow")
  const mins = Math.round(diff / 60_000)
  if (mins < 60) return message(lang, "age.minutes", { m: mins })
  const hours = Math.floor(mins / 60)
  return message(lang, "age.hours", { h: hours })
}

export function tightLine(rows: LimitRow[], now = Date.now(), lang: Locale = "en"): string {
  const tight = tightestRow(rows, now)
  if (!tight) return ""
  const label = windowLabel(tight, lang)
  const left = Math.max(0, 100 - tight.used)
  const { passed, text } = resetText(tight.resetsAtMs, tight.resetsIn, now, lang)
  const suffix = passed
    ? message(lang, "tight.passedSuffix", { text })
    : message(lang, "tight.pendingSuffix", { text })
  return message(lang, "tight.atRisk", { label, used: tight.used, left, suffix })
}

export function formatTokensCompact(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0"
  if (count >= 999_950) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(Math.round(count))
}

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}
