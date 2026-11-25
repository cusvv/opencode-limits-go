import { type LimitRow, type UsageSnapshot, rowWindowKey } from "./types.ts"

// Track the highest threshold seen per window so notifications fire once per crossing and reset after drop.
export function newAlerts(rows: LimitRow[], notified: Map<string, number>, warnThreshold = 80): LimitRow[] {
  const thresholds = warnThreshold > 0 && warnThreshold < 100 ? [warnThreshold, 100] : [100]
  const alerts: LimitRow[] = []
  for (const row of rows) {
    const id = row.key ?? row.label
    // A `limited` window is at 100% for alerting even if the reported percent lags behind.
    const effectiveUsed = row.status === "limited" ? Math.max(100, row.used) : row.used
    const level = thresholds.filter((t) => effectiveUsed >= t).pop() ?? 0
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

export type BurnSpike = {
  row: LimitRow
  delta: number
  spanMs: number
}

export function detectBurnSpike(
  rows: readonly LimitRow[],
  snapshots: readonly UsageSnapshot[] | undefined,
  thresholdPct = 20,
  now = Date.now(),
): BurnSpike | null {
  if (thresholdPct <= 0 || !snapshots?.length) return null
  const row = rows.find((r) => rowWindowKey(r) === "rolling")
  if (!row || row.used < thresholdPct || row.used >= 100) return null
  const minAgeMs = 5 * 60_000
  const maxAgeMs = 30 * 60_000
  let best: { delta: number; spanMs: number } | null = null
  for (const snap of snapshots) {
    const val = snap.rolling
    if (typeof val !== "number") continue
    const snapReset = snap.resets?.rolling
    if (row.resetsAtMs && typeof snapReset === "number" && snapReset !== row.resetsAtMs) continue
    const ageMs = now - snap.at
    if (ageMs < minAgeMs || ageMs > maxAgeMs) continue
    const delta = row.used - val
    if (delta >= thresholdPct && (!best || delta > best.delta)) {
      best = { delta, spanMs: ageMs }
    }
  }
  return best ? { row, delta: best.delta, spanMs: best.spanMs } : null
}
