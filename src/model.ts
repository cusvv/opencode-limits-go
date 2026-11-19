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
  { key: "weekly", label: "1w", labels: { ru: "1н", en: "1w" } },
  { key: "monthly", label: "1m", labels: { ru: "1м", en: "1m" } },
] as const

const WINDOW_BY_KEY = new Map<string, (typeof WINDOWS)[number]>(WINDOWS.map((w) => [w.key, w]))
const WINDOW_BY_LABEL = new Map<string, (typeof WINDOWS)[number]>(
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

export function filterStripRows(rows: readonly LimitRow[], visible: VisibleWindows): LimitRow[] {
  if (!rows.length) return []
  const filtered = rows.filter((row) => {
    const key = rowWindowKey(row)
    return key ? visible[key] : true
  })
  return filtered.length ? filtered : [...rows]
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
      const cause = detail || (lang === "ru" ? "нет доступных учётных данных" : "no credentials available")
      return lang === "ru" ? `Не удалось получить лимиты: ${cause}` : `Failed to load limits: ${cause}`
    }
    default:
      return detail || (lang === "ru" ? "Неизвестная ошибка" : "Unknown error")
  }
}

const pad = (n: number) => String(n).padStart(2, "0")

export function shortDate(isoOrMs: string | number): string {
  const d = new Date(isoOrMs)
  if (Number.isNaN(d.getTime())) return "?"
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
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

export function alertMessage(row: LimitRow, now = Date.now(), lang: Locale = "en"): string {
  const label = windowLabel(row, lang)
  const { passed, text } = resetText(row.resetsAtMs, row.resetsIn, now, lang)
  if (lang === "ru") {
    return `Лимит ${label}: ${row.used}%${passed ? ` (${text})` : `, сброс через ${text}`}`
  }
  return `Limit ${label}: ${row.used}%${passed ? ` (${text})` : `, resets in ${text}`}`
}

// Track the highest threshold seen per window so notifications fire once per crossing and reset after drop.
export function newAlerts(rows: LimitRow[], notified: Map<string, number>, warnThreshold = 80): LimitRow[] {
  const thresholds = warnThreshold > 0 && warnThreshold < 100 ? [warnThreshold, 100] : [100]
  const alerts: LimitRow[] = []
  for (const row of rows) {
    const id = row.key ?? row.label
    const level = thresholds.filter((t) => row.used >= t).pop() ?? 0
    if (level > (notified.get(id) ?? 0)) alerts.push(row)
    notified.set(id, level)
  }
  return alerts
}

// Track windows that were exhausted (>= 100%) and return those that recovered (< 100%).
export function recoveredAlerts(rows: LimitRow[], wasExhausted: Set<string>): LimitRow[] {
  const recovered: LimitRow[] = []
  for (const row of rows) {
    const id = row.key ?? row.label
    const exhausted = row.used >= 100 || row.status === "limited"
    if (exhausted) {
      wasExhausted.add(id)
    } else if (wasExhausted.has(id)) {
      wasExhausted.delete(id)
      recovered.push(row)
    }
  }
  return recovered
}

export function resetAlertMessage(row: LimitRow, lang: Locale = "en"): string {
  const label = windowLabel(row, lang)
  return lang === "ru"
    ? `Лимит ${label} сброшен — OpenCode Go снова доступен`
    : `${label} limit reset — OpenCode Go is available again`
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

export function accountKey(org: string, email: string, source: string): string {
  const norm = (s: string) => s.trim().toLowerCase()
  return `${norm(org)}|${norm(email)}|${norm(source)}`
}

export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[^\s"'`]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:st|rt|sk|oc|pat|gho|ghp)_[A-Za-z0-9._-]{6,}/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/gi, "[REDACTED]")
}

export function errorText(error: unknown, lang: Locale = "en"): string {
  if (error instanceof CodedError) {
    return redactSecrets(formatError(error.code, error.detail, lang))
  }
  const raw = error instanceof Error ? error.message : String(error)
  return redactSecrets(raw)
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

export function emptyCard(error: string): LimitCard {
  return { ok: false, org: "", email: "", checkedAt: "", checkedAtMs: 0, source: "", rows: [], tight: "", error }
}

export function cardText(card: LimitCard, lang: Locale = "en"): string {
  if (!card.ok) return `${lang === "ru" ? "лимиты" : "limits"}: ${card.error}`
  return card.rows.map((row) => `${windowLabel(row, lang)} ${row.used}%`).join(" · ")
}

export function formatTuiSidebar(
  card: LimitCard,
  visible: VisibleWindows,
  showBars = false,
  lang: Locale = "en",
  now = Date.now(),
  showRemaining = false,
): string {
  if (!card.ok) return `${lang === "ru" ? "лимиты" : "limits"}: ${shortErrorLabel(card.error, lang)}`
  return filterStripRows(card.rows, visible)
    .map((row) => {
      const lbl = windowLabel(row, lang)
      const pct = displayPercent(row.used, showRemaining)
      const hot = estimateWindowPace(row, now, lang, card.snapshots)?.kind === "hot" ? "⚡" : ""
      let resetHint = ""
      if ((row.used >= 100 || row.status === "limited") && row.resetsAtMs && row.resetsAtMs > now) {
        resetHint = ` (${span(row.resetsAtMs - now, lang)})`
      }
      return showBars
        ? `${lbl} ${bar(row.used, 4)} ${pct}%${hot}${resetHint}`
        : `${lbl} ${pct}%${hot}${resetHint}`
    })
    .join(" · ")
}

export function cardDetail(
  card: LimitCard,
  now = Date.now(),
  lang: Locale = "en",
  extraLines: readonly string[] = [],
): string {
  const source = sourceLabel(card.source, lang)
  const checkedPrefix = lang === "ru" ? "Проверено" : "Checked"
  const header = `${checkedPrefix}: ${card.checkedAt}${source ? ` · ${source}` : ""}`
  const rows = card.rows.map((row) => {
    const label = windowLabel(row, lang)
    const { passed, text } = resetText(row.resetsAtMs, row.resetsIn, now, lang)
    const resetPart = passed
      ? `${row.resetsAt} (${text})`
      : lang === "ru"
        ? `${row.resetsAt} (через ${text})`
        : `${row.resetsAt} (in ${text})`
    const deltaPart = row.delta1h && row.delta1h > 0 ? `  +${row.delta1h}%` : ""
    return `${label.padStart(2)}: ${String(row.used).padStart(3)}%  ${bar(row.used)}  ${resetPart}${deltaPart}${row.status !== "ok" ? `  [${row.status}]` : ""}`
  })
  const tightLineStr = tightLine(card.rows, now, lang)
  const pace = paceSummary(card.rows, now, lang, card.snapshots)
  const lines = [header, "", ...rows, "", tightLineStr]
  if (pace) lines.push(pace.text)
  for (const extra of extraLines) {
    if (extra) lines.push(extra)
  }
  return lines.join("\n")
}

export type PaceKind = "none" | "steady" | "hot" | "exhausted"

export type WindowPace = {
  kind: PaceKind
  key: WindowKey
  label: string
  rate: number
  projectedPct: number
  timeToFullMs: number
  remainingMs: number
  elapsedRatio: number
  pctPerHour?: number
}

const WINDOW_DURATION_MS: Record<WindowKey, number> = {
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

const MAX_HISTORY = 72
const MIN_HISTORY_INTERVAL_MS = 5 * 60_000

export function recordUsageSnapshot(
  history: readonly UsageSnapshot[],
  rows: readonly LimitRow[],
  now = Date.now(),
): UsageSnapshot[] {
  const entry: UsageSnapshot = { at: now }
  for (const row of rows) {
    const key = rowWindowKey(row)
    if (key) entry[key] = row.used
  }
  const prev = history[history.length - 1]
  if (
    prev &&
    now - prev.at < MIN_HISTORY_INTERVAL_MS &&
    prev.rolling === entry.rolling &&
    prev.weekly === entry.weekly &&
    prev.monthly === entry.monthly
  ) {
    return [...history]
  }
  const next = [...history.filter((s) => typeof s?.at === "number" && s.at <= now && now - s.at <= 3 * 86_400_000), entry]
  return next.slice(-MAX_HISTORY)
}

export function recentWindowDelta(
  history: readonly UsageSnapshot[] | undefined,
  key: WindowKey,
  currentUsed: number,
  now = Date.now(),
  targetSpanMs = 3_600_000,
): { delta: number; spanMs: number; pctPerHour: number } | null {
  if (!history?.length) return null
  const minAgeMs = 15 * 60_000
  const maxAgeMs = 4 * 3_600_000
  let best: { snap: UsageSnapshot; diffFromTarget: number; ageMs: number } | null = null
  for (const snap of history) {
    const val = snap[key]
    if (typeof val !== "number") continue
    const ageMs = now - snap.at
    if (ageMs < minAgeMs || ageMs > maxAgeMs) continue
    if (val > currentUsed) continue
    const diffFromTarget = Math.abs(ageMs - targetSpanMs)
    if (!best || diffFromTarget < best.diffFromTarget) {
      best = { snap, diffFromTarget, ageMs }
    }
  }
  if (!best) return null
  const delta = currentUsed - (best.snap[key] ?? currentUsed)
  if (delta <= 0) return null
  const pctPerHour = (delta * 3_600_000) / best.ageMs
  return { delta, spanMs: best.ageMs, pctPerHour }
}

export function selectSnapshotsForClient(
  history: readonly UsageSnapshot[],
  now = Date.now(),
  limit = 24,
): UsageSnapshot[] {
  if (history.length <= limit) return [...history]
  const picked = new Map<number, UsageSnapshot>()
  // Always keep a few anchor snapshots in the 15m..4h window so recentWindowDelta stays accurate during bursts.
  for (const targetMs of [15 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 3_600_000, 4 * 3_600_000]) {
    let best: UsageSnapshot | null = null
    let bestDiff = Number.POSITIVE_INFINITY
    for (const snap of history) {
      const age = now - snap.at
      if (age < 15 * 60_000 || age > 4 * 3_600_000) continue
      const diff = Math.abs(age - targetMs)
      if (diff < bestDiff) {
        bestDiff = diff
        best = snap
      }
    }
    if (best) picked.set(best.at, best)
  }
  const tailCount = Math.max(1, limit - picked.size)
  for (const snap of history.slice(-tailCount)) {
    picked.set(snap.at, snap)
  }
  return [...picked.values()].sort((a, b) => a.at - b.at)
}

export function attachHistoryDeltas(
  rows: readonly LimitRow[],
  history: readonly UsageSnapshot[] | undefined,
  now = Date.now(),
): LimitRow[] {
  if (!history?.length) return [...rows]
  return rows.map((row) => {
    const key = rowWindowKey(row)
    if (!key) return row
    const recent = recentWindowDelta(history, key, row.used, now)
    if (!recent || recent.delta < 1) return row
    return { ...row, delta1h: Math.round(recent.delta), deltaSpanMs: Math.round(recent.spanMs) }
  })
}

// Estimate consumption pace while suppressing early-window noise and incorporating recent snapshot bursts.
export function estimateWindowPace(
  row: LimitRow,
  now = Date.now(),
  lang: Locale = "en",
  history?: readonly UsageSnapshot[],
): WindowPace | null {
  const key = rowWindowKey(row)
  if (!key) return null
  const resetsAtMs = row.resetsAtMs ?? 0
  if (resetsAtMs <= 0) return null
  const remainingMs = resetsAtMs - now
  if (remainingMs <= 0) return null

  const label = windowLabel(row, lang)
  const durationMs = WINDOW_DURATION_MS[key]
  const elapsedMs = Math.max(0, durationMs - remainingMs)
  const elapsedRatio = Math.min(1, Math.max(0, elapsedMs / durationMs))

  if (row.used >= 100) {
    return {
      kind: "exhausted",
      key,
      label,
      rate: 0,
      projectedPct: row.used,
      timeToFullMs: 0,
      remainingMs,
      elapsedRatio,
    }
  }

  if (elapsedRatio < 0.01) return null

  const avgRate = row.used / 100 / elapsedRatio
  const avgTimeToFullMs = row.used > 0 ? ((100 - row.used) * elapsedMs) / row.used : Number.POSITIVE_INFINITY

  const recent = recentWindowDelta(history, key, row.used, now)
  const recentRate =
    recent && recent.delta >= 3
      ? (recent.pctPerHour * (durationMs / 3_600_000)) / 100
      : 0
  const recentTimeToFullMs =
    recent && recent.pctPerHour > 0 ? ((100 - row.used) / recent.pctPerHour) * 3_600_000 : Number.POSITIVE_INFINITY

  const useRecent = recentRate > avgRate * 1.15 && recentRate >= 1.25 && recentTimeToFullMs < remainingMs
  const rate = useRecent ? recentRate : avgRate
  const timeToFullMs = useRecent ? recentTimeToFullMs : avgTimeToFullMs
  const projectedPct = Math.round(
    useRecent ? row.used + (recent!.pctPerHour * remainingMs) / 3_600_000 : avgRate * 100,
  )

  if ((elapsedRatio >= 0.08 || row.used >= 35 || useRecent) && row.used >= 10 && rate >= 1.2 && projectedPct >= 110 && timeToFullMs < remainingMs) {
    return {
      kind: "hot",
      key,
      label,
      rate,
      projectedPct,
      timeToFullMs,
      remainingMs,
      elapsedRatio,
      pctPerHour: recent ? Math.round(recent.pctPerHour * 10) / 10 : undefined,
    }
  }

  if (elapsedRatio >= 0.08 && row.used >= 10) {
    return {
      kind: "steady",
      key,
      label,
      rate,
      projectedPct,
      timeToFullMs,
      remainingMs,
      elapsedRatio,
      pctPerHour: recent ? Math.round(recent.pctPerHour * 10) / 10 : undefined,
    }
  }

  return null
}

export function paceSummary(
  rows: LimitRow[],
  now = Date.now(),
  lang: Locale = "en",
  history?: readonly UsageSnapshot[],
): { kind: Exclude<PaceKind, "none">; text: string } | null {
  const paces = rows
    .map((row) => estimateWindowPace(row, now, lang, history))
    .filter((p): p is WindowPace => p !== null)
  if (!paces.length) return null

  const exhausted = paces.find((p) => p.kind === "exhausted")
  if (exhausted) {
    return {
      kind: "exhausted",
      text:
        lang === "ru"
          ? `Лимит ${exhausted.label} исчерпан — сброс через ${span(exhausted.remainingMs, lang)}`
          : `${exhausted.label} limit reached — resets in ${span(exhausted.remainingMs, lang)}`,
    }
  }

  const hot = paces
    .filter((p) => p.kind === "hot")
    .sort((a, b) => a.timeToFullMs - b.timeToFullMs)[0]
  if (hot) {
    const marginMs = Math.max(60_000, hot.remainingMs - hot.timeToFullMs)
    return {
      kind: "hot",
      text:
        lang === "ru"
          ? `Темп (${hot.label}): хватит на ~${span(hot.timeToFullMs, lang)} (за ${span(marginMs, lang)} до сброса)`
          : `Pace (${hot.label}): ~${span(hot.timeToFullMs, lang)} until 100% (${span(marginMs, lang)} before reset)`,
    }
  }

  const steady = [...paces].sort((a, b) => b.projectedPct - a.projectedPct)[0]
  if (steady.rate <= 0.85) {
    return {
      kind: "steady",
      text:
        lang === "ru"
          ? `Темп (${steady.label}): спокойный (~${steady.projectedPct}% к сбросу)`
          : `Pace (${steady.label}): comfortable (~${steady.projectedPct}% by reset)`,
    }
  }

  return {
    kind: "steady",
    text:
      lang === "ru"
        ? `Темп (${steady.label}): ровный (~${Math.min(steady.projectedPct, 100)}% к сбросу)`
        : `Pace (${steady.label}): steady (~${Math.min(steady.projectedPct, 100)}% by reset)`,
  }
}

export type ModelUsageSummary = {
  modelID: string
  providerID: string
  tokens: number
  costUsd: number
  steps: number
}

export type ProviderActivitySummary = {
  goTokens: number
  goSteps: number
  zenTokens: number
  zenCostUsd: number
  zenSteps: number
  totalCostUsd: number
  topModels: ModelUsageSummary[]
}

type ModelUsageLike = {
  model?: { providerID?: unknown; modelID?: unknown }
  steps?: unknown
  cost?: unknown
  tokens?: {
    input?: unknown
    output?: unknown
    reasoning?: unknown
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

export function summarizeStatsByProvider(models: readonly ModelUsageLike[] | undefined): ProviderActivitySummary {
  const out: ProviderActivitySummary = {
    goTokens: 0,
    goSteps: 0,
    zenTokens: 0,
    zenCostUsd: 0,
    zenSteps: 0,
    totalCostUsd: 0,
    topModels: [],
  }
  if (!models?.length) return out
  const byModel = new Map<string, ModelUsageSummary>()
  for (const item of models) {
    const provider = typeof item.model?.providerID === "string" ? item.model.providerID : ""
    const modelID = typeof item.model?.modelID === "string" ? item.model.modelID.trim() : ""
    const steps = num(item.steps)
    const cost = num(item.cost)
    const tokens = num(item.tokens?.input) + num(item.tokens?.output) + num(item.tokens?.reasoning)
    out.totalCostUsd += cost
    if (provider === "opencode-go") {
      out.goSteps += steps
      out.goTokens += tokens
    } else if (provider === "opencode") {
      out.zenSteps += steps
      out.zenTokens += tokens
      out.zenCostUsd += cost
    }
    if ((provider === "opencode-go" || provider === "opencode") && modelID && (tokens > 0 || cost > 0)) {
      const key = `${provider}/${modelID}`
      const prev = byModel.get(key)
      if (prev) {
        prev.tokens += tokens
        prev.costUsd += cost
        prev.steps += steps
      } else {
        byModel.set(key, { modelID, providerID: provider, tokens, costUsd: cost, steps })
      }
    }
  }
  out.topModels = [...byModel.values()]
    .sort((a, b) => b.tokens - a.tokens || b.costUsd - a.costUsd)
    .slice(0, 3)
  return out
}

export function formatTokensCompact(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0"
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(Math.round(count))
}

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export function defaultPause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export async function retry<T>(
  attempt: () => Promise<T | null>,
  ok: (value: T | null) => boolean,
  attempts = 5,
  pause: (ms: number, signal?: AbortSignal) => Promise<void> = defaultPause,
  signal?: AbortSignal,
): Promise<T | null> {
  let last: T | null = null
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return last
    last = await attempt()
    if (ok(last) || signal?.aborted || i === attempts - 1) return last
    await pause(500 * (i + 1), signal)
  }
  return last
}

function parseSemverParts(raw: string): [number, number, number] | null {
  const match = raw.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemverParts(a)
  const pb = parseSemverParts(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

export function isNewerVersion(latest: string, current: string): boolean {
  if (!parseSemverParts(latest) || !parseSemverParts(current)) return false
  return compareSemver(latest, current) > 0
}
