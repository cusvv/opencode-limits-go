import { type LimitRow, type Locale, type UsageSnapshot, rowWindowKey, windowLabel } from "./types.ts"
import { resetText, span } from "./format.ts"

export function alertMessage(row: LimitRow, now = Date.now(), lang: Locale = "en"): string {
  const label = windowLabel(row, lang)
  const { passed, text } = resetText(row.resetsAtMs, row.resetsIn, now, lang)
  if (lang === "ru") {
    return `Лимит ${label}: ${row.used}%${passed ? ` (${text})` : `, сброс: ${text}`}`
  }
  return `Limit ${label}: ${row.used}%${passed ? ` (${text})` : `, resets: ${text}`}`
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
    ? `Лимит ${label} сброшен — сейчас ${row.used}%`
    : `${label} limit reset — now at ${row.used}%`
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
    const ageMs = now - snap.at
    if (ageMs < minAgeMs || ageMs > maxAgeMs) continue
    const delta = row.used - val
    if (delta >= thresholdPct && (!best || delta > best.delta)) {
      best = { delta, spanMs: ageMs }
    }
  }
  return best ? { row, delta: best.delta, spanMs: best.spanMs } : null
}

export function burnSpikeMessage(spike: BurnSpike, lang: Locale = "en"): string {
  const lbl = windowLabel(spike.row, lang)
  const duration = span(spike.spanMs, lang)
  return lang === "ru"
    ? `Быстрый расход ${lbl}: +${Math.round(spike.delta)}% за ${duration}`
    : `Fast burn on ${lbl}: +${Math.round(spike.delta)}% in ${duration}`
}
