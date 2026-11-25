import { CodedError, type LimitRow, WINDOWS } from "./types.ts"

const pad = (n: number) => String(n).padStart(2, "0")

/** Language-neutral timestamp used by the server contract until the UI formats it. */
function formatResetAt(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return "?"
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Parses a percent-like value; a non-numeric value must fail rather than render as 0%. */
export function parsePercent(raw: unknown): number {
  if (typeof raw === "number") return raw
  if (typeof raw === "string" && raw.trim() !== "") return Number(raw)
  return Number.NaN
}

const MIN_RESET_MS = Date.parse("2000-01-01T00:00:00Z")
const MAX_RESET_AHEAD_MS = 10 * 366 * 86_400_000

export function sanitizeResetMs(ms: number, now: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  if (ms < MIN_RESET_MS || ms > now + MAX_RESET_AHEAD_MS) return 0
  return ms
}

function parseEpochMs(raw: string): number {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    return n < 1e12 ? n * 1000 : n
  }
  return Date.parse(raw)
}

export function parseResetMs(item: { resetsAt?: unknown; resetInSec?: unknown }, now: number): number {
  if (typeof item.resetsAt === "string" && item.resetsAt.trim()) {
    return sanitizeResetMs(parseEpochMs(item.resetsAt.trim()), now)
  }
  if (typeof item.resetsAt === "number" && Number.isFinite(item.resetsAt) && item.resetsAt > 0) {
    return sanitizeResetMs(item.resetsAt < 1e12 ? item.resetsAt * 1000 : item.resetsAt, now)
  }
  if (typeof item.resetInSec === "number" && Number.isFinite(item.resetInSec)) {
    return now + item.resetInSec * 1000
  }
  if (typeof item.resetInSec === "string" && /^\d+$/.test(item.resetInSec.trim())) {
    return now + Number(item.resetInSec.trim()) * 1000
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

export function parseUsage(data: unknown, now: number): LimitRow[] {
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
      label: w.label,
      used: Math.max(0, Math.round(percent)),
      status,
      resetsAt: resetsAtMs > 0 ? formatResetAt(resetsAtMs) : "?",
      resetsAtMs,
      resetsIn: resetsAtMs > 0 ? "" : "?",
    })
  }
  if (!rows.length) throw new CodedError("EMPTY_USAGE")
  return rows
}
