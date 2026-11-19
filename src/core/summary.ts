import { type LimitCard, type Locale, type VisibleWindows, filterStripRows, windowLabel } from "./types.ts"
import { bar, displayPercent, resetText, shortErrorLabel, sourceLabel, span, tightLine } from "./format.ts"
import { estimateWindowPace, paceSummary } from "./pace.ts"

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
