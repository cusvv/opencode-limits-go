import { type LimitRow, type Locale, type UsageSnapshot, type WindowKey, rowWindowKey, windowLabel } from "./types.ts"
import { span } from "./format.ts"

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

export function nextResetDelayMs(rows: readonly LimitRow[], now = Date.now(), maxLookaheadMs = 6 * 3_600_000): number | null {
  let earliest = Number.POSITIVE_INFINITY
  for (const row of rows) {
    const at = row.resetsAtMs ?? 0
    if (at > now) {
      const delay = at - now + 3_000
      if (delay <= maxLookaheadMs && delay < earliest) {
        earliest = delay
      }
    }
  }
  return Number.isFinite(earliest) ? Math.max(3_000, Math.round(earliest)) : null
}

export type SparklineData = {
  polyline: string
  area: string
  min: number
  max: number
  count: number
}

export function buildSparklinePoints(
  snapshots: readonly UsageSnapshot[] | undefined,
  key: WindowKey = "rolling",
  width = 240,
  height = 28,
): SparklineData | null {
  if (!snapshots?.length) return null
  const pts = snapshots
    .map((s) => ({ at: s.at, v: s[key] }))
    .filter((p): p is { at: number; v: number } => typeof p.v === "number" && Number.isFinite(p.v))
    .sort((a, b) => a.at - b.at)
  if (pts.length < 3) return null

  const minAt = pts[0].at
  const maxAt = pts[pts.length - 1].at
  const timeSpan = Math.max(1, maxAt - minAt)
  let minV = 100
  let maxV = 0
  for (const p of pts) {
    if (p.v < minV) minV = p.v
    if (p.v > maxV) maxV = p.v
  }
  const padY = 3
  const usableH = Math.max(4, height - padY * 2)
  const rangeV = Math.max(10, maxV - minV)
  const baseV = Math.max(0, Math.min(minV, maxV - rangeV))

  const coords = pts.map((p) => {
    const x = Math.round(((p.at - minAt) / timeSpan) * width * 10) / 10
    const y = Math.round((height - padY - ((p.v - baseV) / rangeV) * usableH) * 10) / 10
    return `${x},${y}`
  })
  const polyline = coords.join(" ")
  const area = `0,${height} ${polyline} ${width},${height}`
  return { polyline, area, min: minV, max: maxV, count: pts.length }
}
