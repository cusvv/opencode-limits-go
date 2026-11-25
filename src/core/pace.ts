import {
  type LimitRow,
  type UsageSnapshot,
  type WindowKey,
  WINDOW_BY_KEY,
  WINDOW_DURATION_MS,
  rowWindowKey,
} from "./types.ts"

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

const MAX_HISTORY = 240
const MIN_HISTORY_INTERVAL_MS = 5 * 60_000

export function recordUsageSnapshot(
  history: readonly UsageSnapshot[],
  rows: readonly LimitRow[],
  now = Date.now(),
): UsageSnapshot[] {
  const entry: UsageSnapshot = { at: now }
  for (const row of rows) {
    const key = rowWindowKey(row)
    if (!key) continue
    entry[key] = row.used
    if (typeof row.resetsAtMs === "number" && Number.isFinite(row.resetsAtMs) && row.resetsAtMs > 0) {
      const resets = entry.resets ?? {}
      resets[key] = row.resetsAtMs
      entry.resets = resets
    }
  }
  const prev = history[history.length - 1]
  if (
    prev &&
    now - prev.at < MIN_HISTORY_INTERVAL_MS &&
    prev.rolling === entry.rolling &&
    prev.weekly === entry.weekly &&
    prev.monthly === entry.monthly &&
    (["rolling", "weekly", "monthly"] as const).every((key) => prev.resets?.[key] === entry.resets?.[key])
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
  resetsAtMs?: number,
): { delta: number; spanMs: number; pctPerHour: number } | null {
  if (!history?.length) return null
  const minAgeMs = 15 * 60_000
  const maxAgeMs = 4 * 3_600_000
  let best: { snap: UsageSnapshot; diffFromTarget: number; ageMs: number } | null = null
  for (const snap of history) {
    const val = snap[key]
    if (typeof val !== "number") continue
    // A snapshot from a previous window cannot describe the current one.
    if (typeof resetsAtMs === "number" && resetsAtMs > 0) {
      const snapReset = snap.resets?.[key]
      if (typeof snapReset === "number" && snapReset !== resetsAtMs) continue
    }
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
  limit = 72,
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
  const sorted = [...picked.values()].sort((a, b) => a.at - b.at)
  // Anchors may exceed a small limit; keep the newest points within budget.
  return sorted.length > limit ? sorted.slice(-limit) : sorted
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
    const recent = recentWindowDelta(history, key, row.used, now, 3_600_000, row.resetsAtMs)
    if (!recent || recent.delta < 1) return row
    return { ...row, delta1h: Math.round(recent.delta), deltaSpanMs: Math.round(recent.spanMs) }
  })
}

// Estimate consumption pace while suppressing early-window noise and incorporating recent snapshot bursts.
export function estimateWindowPace(
  row: LimitRow,
  now = Date.now(),
  history?: readonly UsageSnapshot[],
): WindowPace | null {
  const key = rowWindowKey(row)
  if (!key) return null
  const resetsAtMs = row.resetsAtMs ?? 0
  if (resetsAtMs <= 0) return null
  const remainingMs = resetsAtMs - now
  if (remainingMs <= 0) return null

  const label = WINDOW_BY_KEY.get(key)?.label ?? row.label
  const durationMs = WINDOW_DURATION_MS[key]
  const elapsedMs = Math.max(0, durationMs - remainingMs)
  const elapsedRatio = Math.min(1, Math.max(0, elapsedMs / durationMs))

  if (row.used >= 100 || row.status === "limited") {
    return {
      kind: "exhausted",
      key,
      label,
      rate: 0,
      projectedPct: Math.max(100, row.used),
      timeToFullMs: 0,
      remainingMs,
      elapsedRatio,
    }
  }

  if (elapsedRatio < 0.01 && row.used < 35) return null

  const avgRate = row.used / 100 / elapsedRatio
  const avgTimeToFullMs = row.used > 0 ? ((100 - row.used) * elapsedMs) / row.used : Number.POSITIVE_INFINITY

  const recent = recentWindowDelta(history, key, row.used, now, 3_600_000, row.resetsAtMs)
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

  // projectedPct 100-120 is already a risk: it must not fall through to "steady ~100% by reset".
  if ((elapsedRatio >= 0.08 || row.used >= 35 || useRecent) && row.used >= 10 && rate >= 1 && projectedPct >= 105 && timeToFullMs < remainingMs) {
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

export type WindowVerdictKind = "exhausted" | "tight" | "fits"

export type WindowVerdict = {
  kind: WindowVerdictKind
  labelKey: WindowKey
  projectedPct: number
  timeToFullMs?: number
  remainingMs: number
}

// One decision per window: wait, slow down, or keep going. Text lives in present/alerts.
export function windowVerdict(
  row: LimitRow,
  now = Date.now(),
  history?: readonly UsageSnapshot[],
): WindowVerdict | null {
  const pace = estimateWindowPace(row, now, history)
  if (!pace) return null
  if (pace.kind === "exhausted") {
    return {
      kind: "exhausted",
      labelKey: pace.key,
      projectedPct: pace.projectedPct,
      remainingMs: pace.remainingMs,
    }
  }
  if (pace.timeToFullMs < pace.remainingMs) {
    return {
      kind: "tight",
      labelKey: pace.key,
      projectedPct: pace.projectedPct,
      timeToFullMs: pace.timeToFullMs,
      remainingMs: pace.remainingMs,
    }
  }
  return {
    kind: "fits",
    labelKey: pace.key,
    projectedPct: pace.projectedPct,
    timeToFullMs: pace.timeToFullMs,
    remainingMs: pace.remainingMs,
  }
}

export type PaceSummary = {
  kind: Exclude<PaceKind, "none">
  windowKey?: WindowKey
  timeToFullMs?: number
  remainingMs?: number
  marginMs?: number
  projectedPct: number
  rate: number
}

export function paceSummary(
  rows: LimitRow[],
  now = Date.now(),
  history?: readonly UsageSnapshot[],
): PaceSummary | null {
  const paces = rows
    .map((row) => estimateWindowPace(row, now, history))
    .filter((p): p is WindowPace => p !== null)
  if (!paces.length) return null

  const exhausted = paces.find((p) => p.kind === "exhausted")
  if (exhausted) {
    return {
      kind: "exhausted",
      windowKey: exhausted.key,
      remainingMs: exhausted.remainingMs,
      projectedPct: exhausted.projectedPct,
      rate: exhausted.rate,
    }
  }

  const hot = paces
    .filter((p) => p.kind === "hot")
    .sort((a, b) => a.timeToFullMs - b.timeToFullMs)[0]
  if (hot) {
    return {
      kind: "hot",
      windowKey: hot.key,
      timeToFullMs: hot.timeToFullMs,
      remainingMs: hot.remainingMs,
      marginMs: Math.max(60_000, hot.remainingMs - hot.timeToFullMs),
      projectedPct: hot.projectedPct,
      rate: hot.rate,
    }
  }

  const steady = [...paces].sort((a, b) => b.projectedPct - a.projectedPct)[0]
  if (steady.rate <= 0.85) {
    return {
      kind: "steady",
      windowKey: steady.key,
      projectedPct: steady.projectedPct,
      rate: steady.rate,
    }
  }

  if (steady.projectedPct >= 100) {
    return {
      kind: "hot",
      windowKey: steady.key,
      projectedPct: steady.projectedPct,
      rate: steady.rate,
    }
  }

  return {
    kind: "steady",
    windowKey: steady.key,
    projectedPct: steady.projectedPct,
    rate: steady.rate,
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
  let minV = Number.POSITIVE_INFINITY
  let maxV = Number.NEGATIVE_INFINITY
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
