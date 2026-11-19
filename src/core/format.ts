import {
  CodedError,
  type LimitCard,
  type LimitRow,
  type Locale,
  type TimeFormat,
  WINDOWS,
  windowLabel,
} from "./types.ts"

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
  if (ms <= 0) return lang === "ru" ? "сброс прошёл, обнови" : "reset passed, refresh"
  const m = Math.round(ms / 60_000)
  if (m < 1) return lang === "ru" ? "меньше минуты" : "< 1m"
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d) return lang === "ru" ? `${d}д ${h}ч` : `${d}d ${h}h`
  if (h) return lang === "ru" ? `${h}ч ${pad(m % 60)}м` : `${h}h ${pad(m % 60)}m`
  return lang === "ru" ? `${m}м` : `${m}m`
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
  if (fallbackResetsIn === "сброс прошёл, обнови" || fallbackResetsIn === "reset passed, refresh") {
    return { passed: true, text: span(0, lang) }
  }
  return { passed: false, text: fallbackResetsIn || "?" }
}

export function bar(percent: number, width = 20): string {
  const filled = Math.round((width * Math.min(Math.max(percent, 0), 100)) / 100)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

function parsePercent(raw: unknown): number {
  if (typeof raw === "number") return raw
  if (typeof raw === "string" && raw.trim() !== "") return Number(raw)
  return Number.NaN
}

function parseResetMs(item: { resetsAt?: unknown; resetInSec?: unknown }, now: number): number {
  if (typeof item.resetsAt === "string" && item.resetsAt.trim()) {
    const t = Date.parse(item.resetsAt)
    return Number.isFinite(t) ? t : 0
  }
  if (typeof item.resetsAt === "number" && Number.isFinite(item.resetsAt) && item.resetsAt > 0) {
    return item.resetsAt < 1e12 ? item.resetsAt * 1000 : item.resetsAt
  }
  if (typeof item.resetInSec === "number" && Number.isFinite(item.resetInSec)) {
    return now + item.resetInSec * 1000
  }
  return 0
}

type RawWindow = {
  status?: unknown
  limited?: unknown
  percent?: unknown
  resetsAt?: unknown
  resetInSec?: unknown
}

// A non-numeric percent must fail rather than silently render as 0%.
export function parseUsage(data: unknown, now: number, lang: Locale = "en"): LimitRow[] {
  const root = data && typeof data === "object" ? (data as Record<string, unknown>) : null
  const usage = (root?.usage && typeof root.usage === "object" ? root.usage : root) as
    | Record<string, RawWindow | undefined>
    | null

  const rows: LimitRow[] = []
  for (const w of WINDOWS) {
    const item = usage?.[w.key]
    if (!item || typeof item !== "object") continue
    const percent = parsePercent(item.percent)
    if (!Number.isFinite(percent)) {
      throw new CodedError("INVALID_PERCENT", w.key)
    }
    const resetsAtMs = parseResetMs(item, now)
    const status =
      typeof item.status === "string" && item.status
        ? item.status
        : item.limited === true
          ? "limited"
          : "ok"
    rows.push({
      key: w.key,
      label: w.labels[lang],
      used: Math.max(0, Math.round(percent)),
      status,
      resetsAt: resetsAtMs > 0 ? shortDate(resetsAtMs) : "?",
      resetsAtMs,
      resetsIn: resetsAtMs > 0 ? span(resetsAtMs - now, lang) : "?",
    })
  }
  if (!rows.length) throw new CodedError("EMPTY_USAGE")
  return rows
}

export function localizeRows(rows: LimitRow[], now: number, lang: Locale): LimitRow[] {
  return rows.map((row) => {
    const { text } = resetText(row.resetsAtMs, row.resetsIn, now, lang)
    return {
      ...row,
      label: windowLabel(row, lang),
      resetsIn: row.resetsAtMs ? text : row.resetsIn,
    }
  })
}

export function tightLine(rows: LimitRow[], now = Date.now(), lang: Locale = "en"): string {
  if (!rows.length) return ""
  const tight = [...rows].sort((a, b) => b.used - a.used)[0]
  const label = windowLabel(tight, lang)
  const left = Math.max(0, 100 - tight.used)
  const { passed, text } = resetText(tight.resetsAtMs, tight.resetsIn, now, lang)
  if (lang === "ru") {
    return `Ближе всех: ${label} — ${tight.used}%, запас ${left}%${passed ? ` (${text})` : `, сброс через ${text}`}`
  }
  return `Tightest: ${label} — ${tight.used}%, ${left}% left${passed ? ` (${text})` : `, resets in ${text}`}`
}

const SOURCE_LABELS: Record<string, { ru: string; en: string }> = {
  integration: { ru: "интеграция OpenCode", en: "OpenCode integration" },
  "integration:oauth": { ru: "интеграция OpenCode (OAuth)", en: "OpenCode integration (OAuth)" },
  "integration:key": { ru: "интеграция OpenCode (API-ключ)", en: "OpenCode integration (API key)" },
  "integration:env": { ru: "интеграция OpenCode (env)", en: "OpenCode integration (env)" },
  env: { ru: "переменная окружения", en: "environment variable" },
  config: { ru: "конфиг OpenCode", en: "OpenCode config" },
  "auth.json": { ru: "auth.json", en: "auth.json" },
  cli: { ru: "opencode auth export", en: "opencode auth export" },
}

export function sourceLabel(source: string, lang: Locale = "en"): string {
  return SOURCE_LABELS[source]?.[lang] ?? ""
}

export function cardText(card: LimitCard, lang: Locale = "en"): string {
  if (!card.ok) return `${lang === "ru" ? "лимиты" : "limits"}: ${card.error}`
  return card.rows.map((row) => `${windowLabel(row, lang)} ${row.used}%`).join(" · ")
}

export function displayPercent(used: number, showRemaining = false): number {
  const clamped = Math.min(100, Math.max(0, Math.round(used)))
  return showRemaining ? 100 - clamped : clamped
}

export function shortErrorLabel(error: string | undefined, lang: Locale = "en"): string {
  const raw = (error ?? "").toLowerCase()
  if (!raw) return lang === "ru" ? "нет данных" : "no data"
  if (raw.includes("no_token") || raw.includes("no opencode go token") || raw.includes("нет токена")) {
    return lang === "ru" ? "нет токена" : "no token"
  }
  if (raw.includes("401") || raw.includes("403") || raw.includes("unauthorized") || raw.includes("forbidden")) {
    return lang === "ru" ? "ошибка входа" : "auth error"
  }
  if (raw.includes("429") || raw.includes("rate limit")) {
    return lang === "ru" ? "слишком часто" : "rate limited"
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
    return lang === "ru" ? "офлайн" : "offline"
  }
  return lang === "ru" ? "ошибка" : "error"
}

export function relativeAge(checkedAtMs: number | undefined, now = Date.now(), lang: Locale = "en"): string {
  if (!checkedAtMs || checkedAtMs <= 0) return ""
  const diff = Math.max(0, now - checkedAtMs)
  if (diff < 45_000) return lang === "ru" ? "только что" : "just now"
  const mins = Math.round(diff / 60_000)
  if (mins < 60) return lang === "ru" ? `${mins}м назад` : `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return lang === "ru" ? `${hours}ч назад` : `${hours}h ago`
}
