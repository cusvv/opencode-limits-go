export type Locale = "en" | "ru"
export type WindowKey = "rolling" | "weekly" | "monthly"

export type UsageSnapshot = {
  at: number
  rolling?: number
  weekly?: number
  monthly?: number
}

export type LimitRow = {
  key?: WindowKey
  label: string
  used: number
  status: string
  resetsAt: string
  resetsAtMs?: number
  resetsIn: string
  delta1h?: number
  deltaSpanMs?: number
}

export type LimitCard = {
  ok: boolean
  org: string
  email: string
  checkedAt: string
  checkedAtMs?: number
  source: string
  rows: LimitRow[]
  tight: string
  error: string
  stale?: boolean
  snapshots?: UsageSnapshot[]
}

export type ErrorCode = "NO_TOKEN" | "INVALID_JSON" | "EMPTY_USAGE" | "INVALID_PERCENT" | "FETCH_FAILED"

export class CodedError extends Error {
  readonly code: ErrorCode
  readonly detail?: string

  constructor(code: ErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
    this.detail = detail
  }
}

export function normalizeLocale(input?: string | null): Locale {
  return typeof input === "string" && input.toLowerCase().startsWith("ru") ? "ru" : "en"
}

export const WINDOWS = [
  { key: "rolling", label: "5h", labels: { ru: "5ч", en: "5h" } },
  { key: "weekly", label: "1w", labels: { ru: "1нед", en: "1w" } },
  { key: "monthly", label: "1m", labels: { ru: "1мес", en: "1m" } },
] as const

export const WINDOW_DURATION_MS: Record<WindowKey, number> = {
  rolling: 5 * 3_600_000,
  weekly: 7 * 86_400_000,
  monthly: 30 * 86_400_000,
}

export function windowElapsedRatio(row: Pick<LimitRow, "key" | "label" | "resetsAtMs">, now = Date.now()): number | null {
  const key = rowWindowKey(row)
  if (!key) return null
  const resetsAtMs = row.resetsAtMs ?? 0
  if (resetsAtMs <= 0) return null
  const durationMs = WINDOW_DURATION_MS[key]
  const remainingMs = resetsAtMs - now
  if (remainingMs < 0) return 1
  if (remainingMs > durationMs) return 0
  return Math.min(1, Math.max(0, (durationMs - remainingMs) / durationMs))
}

export const WINDOW_BY_KEY = new Map<string, (typeof WINDOWS)[number]>(WINDOWS.map((w) => [w.key, w]))
export const WINDOW_BY_LABEL = new Map<string, (typeof WINDOWS)[number]>(
  WINDOWS.flatMap((w) => [
    [w.labels.ru, w],
    [w.labels.en, w],
  ]),
)

export function rowWindowKey(row: Pick<LimitRow, "key" | "label">): WindowKey | undefined {
  return row.key ?? WINDOW_BY_LABEL.get(row.label)?.key
}

export function windowLabel(row: Pick<LimitRow, "key" | "label">, lang: Locale = "en"): string {
  const entry = (row.key ? WINDOW_BY_KEY.get(row.key) : undefined) ?? WINDOW_BY_LABEL.get(row.label)
  return entry ? entry.labels[lang] : row.label
}

export type VisibleWindows = Record<WindowKey, boolean>
export type StripMode = "selected" | "tightest"
export type TimeFormat = "24h" | "12h"

export function filterStripRows(rows: readonly LimitRow[], visible: VisibleWindows): LimitRow[] {
  if (!rows.length) return []
  const filtered = rows.filter((row) => {
    const key = rowWindowKey(row)
    return key ? visible[key] : true
  })
  return filtered.length ? filtered : [...rows]
}

// Risk ranks by projected usage at reset, so a 5h window about to reset does not hide
// a weekly window that will actually run out first.
function riskRank(row: LimitRow, now: number): number {
  const ratio = windowElapsedRatio(row, now)
  return ratio !== null && ratio >= 0.08 ? row.used / ratio : row.used
}

export function tightestRow(rows: readonly LimitRow[], now = Date.now()): LimitRow | undefined {
  if (!rows.length) return undefined
  return [...rows].sort((a, b) => {
    const risk = riskRank(b, now) - riskRank(a, now)
    if (risk !== 0) return risk
    if (b.used !== a.used) return b.used - a.used
    const ra = a.resetsAtMs && a.resetsAtMs > 0 ? a.resetsAtMs : Number.MAX_SAFE_INTEGER
    const rb = b.resetsAtMs && b.resetsAtMs > 0 ? b.resetsAtMs : Number.MAX_SAFE_INTEGER
    return ra - rb
  })[0]
}

export function selectStripRows(
  rows: readonly LimitRow[],
  visible: VisibleWindows,
  mode: StripMode = "selected",
  now = Date.now(),
): LimitRow[] {
  if (!rows.length) return []
  if (mode === "tightest") {
    const tight = tightestRow(rows, now)
    return tight ? [tight] : []
  }
  return filterStripRows(rows, visible)
}

export function shouldHideStrip(rows: readonly LimitRow[], autoHideBelow = 0): boolean {
  if (autoHideBelow <= 0 || !rows.length) return false
  return rows.every((r) => r.used < autoHideBelow && r.status !== "limited")
}

export function isAuthError(text: string | undefined): boolean {
  const raw = (text ?? "").toLowerCase()
  return raw.includes("401") || raw.includes("403") || raw.includes("unauthorized") || raw.includes("forbidden")
}

export function formatError(code: ErrorCode | undefined, detail: string | undefined, lang: Locale = "en"): string {
  switch (code) {
    case "NO_TOKEN":
      return lang === "ru"
        ? "Нет токена OpenCode Go. Выполни: opencode auth login или задай OPENCODE_API_KEY"
        : "No OpenCode Go token found. Run: opencode auth login or set OPENCODE_API_KEY"
    case "INVALID_JSON":
      return lang === "ru" ? "Некорректный JSON в ответе API" : "Invalid JSON in API response"
    case "EMPTY_USAGE":
      return lang === "ru" ? "Ответ API без данных об использовании" : "API response contains no usage data"
    case "INVALID_PERCENT": {
      const label = detail ? (WINDOW_BY_KEY.get(detail)?.labels[lang] ?? detail) : "?"
      return lang === "ru" ? `Окно ${label}: некорректный процент` : `Window ${label}: invalid percent`
    }
    case "FETCH_FAILED": {
      if (isAuthError(detail)) {
        return lang === "ru"
          ? "Токен OpenCode Go истёк или неверен. Выполни: opencode auth login (или обнови OPENCODE_API_KEY)"
          : "OpenCode Go token is expired or invalid. Run: opencode auth login (or refresh OPENCODE_API_KEY)"
      }
      const cause = detail || (lang === "ru" ? "нет доступных учётных данных" : "no credentials available")
      return lang === "ru" ? `Не удалось получить лимиты: ${cause}` : `Failed to load limits: ${cause}`
    }
    default:
      return detail || (lang === "ru" ? "Неизвестная ошибка" : "Unknown error")
  }
}

export function emptyCard(error: string): LimitCard {
  return { ok: false, org: "", email: "", checkedAt: "", checkedAtMs: 0, source: "", rows: [], tight: "", error }
}

export function accountKey(org: string, email: string, source: string): string {
  const norm = (s: string) => s.trim().toLowerCase()
  return `${norm(org)}|${norm(email)}|${norm(source)}`
}
