export type Locale = "en" | "ru"
export type WindowKey = "rolling" | "weekly" | "monthly"

export type UsageSnapshot = {
  at: number
  rolling?: number
  weekly?: number
  monthly?: number
  resets?: Partial<Record<WindowKey, number>>
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
  /** Stable HMAC fingerprint of the credential; safe to show, never the credential itself. */
  accountId?: string
  /** Credential epoch the card belongs to. */
  revision?: number
  errorCode?: CardErrorCode
  errorDetail?: string
}

export type CardErrorCode =
  | "NO_TOKEN"
  | "AUTH"
  | "RATE_LIMIT"
  | "OFFLINE"
  | "BAD_RESPONSE"
  | "CREDENTIALS_CHANGED"
  | "INTERNAL"

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

/** Canonical labels are presentation-free identifiers; localized labels live in src/i18n. */
export const WINDOWS = [
  { key: "rolling", label: "5h" },
  { key: "weekly", label: "1w" },
  { key: "monthly", label: "1m" },
] as const

export const WINDOW_DURATION_MS: Record<WindowKey, number> = {
  rolling: 5 * 3_600_000,
  weekly: 7 * 86_400_000,
  monthly: 30 * 86_400_000,
}

export const WINDOW_BY_KEY = new Map<string, (typeof WINDOWS)[number]>(WINDOWS.map((w) => [w.key, w]))
export const WINDOW_BY_LABEL = new Map<string, (typeof WINDOWS)[number]>(WINDOWS.map((w) => [w.label, w]))

export function rowWindowKey(row: Pick<LimitRow, "key" | "label">): WindowKey | undefined {
  return row.key ?? WINDOW_BY_LABEL.get(row.label)?.key
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

/** Technical matching of auth failures in raw provider text; carries no user-facing copy. */
export function isAuthError(text: string | undefined): boolean {
  const raw = (text ?? "").toLowerCase()
  return /\b(?:401|403)\b/.test(raw) || raw.includes("unauthorized") || raw.includes("forbidden")
}

export function emptyCard(error: string): LimitCard {
  return { ok: false, org: "", email: "", checkedAt: "", checkedAtMs: 0, source: "", rows: [], tight: "", error }
}

export function accountKey(org: string, email: string, source: string): string {
  const norm = (s: string) => s.trim().toLowerCase()
  return `${norm(org)}|${norm(email)}|${norm(source)}`
}
