import {
  type BurnSpike,
  type LimitRow,
  type Locale,
  type PaceSummary,
  type WindowVerdict,
} from "../core/index.ts"
import { message } from "../i18n/index.ts"
import { resetText, span, windowLabel, windowLabelForKey } from "./format.ts"

export function alertMessage(row: LimitRow, now = Date.now(), lang: Locale = "en"): string {
  const label = windowLabel(row, lang)
  const { passed, text } = resetText(row.resetsAtMs, row.resetsIn, now, lang)
  const suffix = passed
    ? message(lang, "alert.passedSuffix", { text })
    : message(lang, "alert.pendingSuffix", { text })
  if (row.status === "limited" && row.used < 100) {
    return message(lang, "alert.limitReached", { label, used: row.used, suffix })
  }
  return message(lang, "alert.limit", { label, used: row.used, suffix })
}

export function resetAlertMessage(row: LimitRow, lang: Locale = "en"): string {
  return message(lang, "alert.reset", { label: windowLabel(row, lang), used: row.used })
}

export function burnSpikeMessage(spike: BurnSpike, lang: Locale = "en"): string {
  return message(lang, "alert.burnSpike", {
    label: windowLabel(spike.row, lang),
    delta: Math.round(spike.delta),
    span: span(spike.spanMs, lang),
  })
}

export function windowVerdictText(verdict: WindowVerdict, lang: Locale = "en"): string {
  const label = windowLabelForKey(verdict.labelKey, lang)
  if (verdict.kind === "exhausted") {
    return message(lang, "verdict.exhausted", { label, span: span(verdict.remainingMs, lang) })
  }
  if (verdict.kind === "tight") {
    return message(lang, "verdict.tight", {
      label,
      timeToFull: span(verdict.timeToFullMs ?? 0, lang),
      remaining: span(verdict.remainingMs, lang),
    })
  }
  const projected = Math.min(100, Math.max(0, verdict.projectedPct))
  return message(lang, "verdict.fits", { label, projected })
}

export function paceSummaryText(summary: PaceSummary, lang: Locale = "en"): string {
  if (!summary.windowKey) return ""
  const label = windowLabelForKey(summary.windowKey, lang)
  if (summary.kind === "exhausted") {
    return message(lang, "pace.exhausted", { label, span: span(summary.remainingMs ?? 0, lang) })
  }
  if (summary.kind === "hot") {
    if (summary.timeToFullMs === undefined) {
      return message(lang, "pace.mayRunOut", { label, projected: summary.projectedPct })
    }
    const marginMs = summary.marginMs ?? Math.max(60_000, (summary.remainingMs ?? 0) - summary.timeToFullMs)
    return message(lang, "pace.hot", {
      label,
      timeToFull: span(summary.timeToFullMs, lang),
      margin: span(marginMs, lang),
    })
  }
  if (summary.rate <= 0.85) {
    return message(lang, "pace.comfortable", { label, projected: summary.projectedPct })
  }
  return message(lang, "pace.steady", { label, projected: summary.projectedPct })
}
