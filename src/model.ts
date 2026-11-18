export type Locale = "en" | "ru"
export type WindowKey = "rolling" | "weekly" | "monthly"

export type LimitRow = {
  key?: WindowKey
  label: string
  used: number
  status: string
  resetsAt: string
  resetsAtMs?: number
  resetsIn: string
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

export function windowLabel(row: Pick<LimitRow, "key" | "label">, lang: Locale = "en"): string {
  const entry = (row.key ? WINDOW_BY_KEY.get(row.key) : undefined) ?? WINDOW_BY_LABEL.get(row.label)
  return entry ? entry.labels[lang] : row.label
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

const THRESHOLDS = [80, 100]

// Track the highest threshold seen per window so notifications fire once per crossing and reset after drop.
export function newAlerts(rows: LimitRow[], notified: Map<string, number>): LimitRow[] {
  const alerts: LimitRow[] = []
  for (const row of rows) {
    const id = row.key ?? row.label
    const level = THRESHOLDS.filter((t) => row.used >= t).pop() ?? 0
    if (level > (notified.get(id) ?? 0)) alerts.push(row)
    notified.set(id, level)
  }
  return alerts
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

export function cardDetail(card: LimitCard, now = Date.now(), lang: Locale = "en"): string {
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
    return `${label.padStart(2)}: ${String(row.used).padStart(3)}%  ${bar(row.used)}  ${resetPart}${row.status !== "ok" ? `  [${row.status}]` : ""}`
  })
  const tightLineStr = tightLine(card.rows, now, lang)
  const pace = paceSummary(card.rows, now, lang)
  const lines = [header, "", ...rows, "", tightLineStr]
  if (pace) lines.push(pace.text)
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
}

const WINDOW_DURATION_MS: Record<WindowKey, number> = {
  rolling: 5 * 3_600_000,
  weekly: 7 * 86_400_000,
  monthly: 30 * 86_400_000,
}

// Estimate consumption pace while suppressing early-window noise (<1% elapsed or small bursts).
export function estimateWindowPace(row: LimitRow, now = Date.now(), lang: Locale = "en"): WindowPace | null {
  const key = row.key ?? WINDOW_BY_LABEL.get(row.label)?.key
  if (!key) return null
  const resetsAtMs = row.resetsAtMs ?? 0
  if (resetsAtMs <= 0) return null
  const remainingMs = resetsAtMs - now
  if (remainingMs <= 0) return null

  const label = windowLabel(row, lang)
  if (row.used >= 100) {
    return {
      kind: "exhausted",
      key,
      label,
      rate: 0,
      projectedPct: row.used,
      timeToFullMs: 0,
      remainingMs,
    }
  }

  const durationMs = WINDOW_DURATION_MS[key]
  const elapsedMs = durationMs - remainingMs
  const elapsedRatio = elapsedMs / durationMs
  if (elapsedRatio < 0.01) return null

  const rate = row.used / 100 / elapsedRatio
  const projectedPct = Math.round(rate * 100)
  const timeToFullMs = row.used > 0 ? ((100 - row.used) * elapsedMs) / row.used : Number.POSITIVE_INFINITY

  if ((elapsedRatio >= 0.08 || row.used >= 35) && row.used >= 10 && rate >= 1.2 && projectedPct >= 110 && timeToFullMs < remainingMs) {
    return { kind: "hot", key, label, rate, projectedPct, timeToFullMs, remainingMs }
  }

  if (elapsedRatio >= 0.08 && row.used >= 10) {
    return { kind: "steady", key, label, rate, projectedPct, timeToFullMs, remainingMs }
  }

  return null
}

export function paceSummary(
  rows: LimitRow[],
  now = Date.now(),
  lang: Locale = "en",
): { kind: Exclude<PaceKind, "none">; text: string } | null {
  const paces = rows
    .map((row) => estimateWindowPace(row, now, lang))
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
