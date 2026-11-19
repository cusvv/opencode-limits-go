import { type LimitCard, type Locale, type VisibleWindows, filterStripRows, tightestRow, windowLabel } from "./types.ts"
import { bar, displayPercent, resetText, shortErrorLabel, sourceLabel, span, tightLine } from "./format.ts"
import { estimateWindowPace, paceSummary, windowVerdict } from "./pace.ts"

export function formatTuiSidebar(
  card: LimitCard,
  visible: VisibleWindows,
  showBars = false,
  lang: Locale = "en",
  now = Date.now(),
  showRemaining = false,
  warnAt = 80,
  plain = false,
  compact = false,
): string {
  if (!card.ok) return `${lang === "ru" ? "лимиты" : "limits"}: ${shortErrorLabel(card.error, lang)}`
  const all = filterStripRows(card.rows, visible)
  const rows = compact ? [tightestRow(all, now) ?? all[0]] : all
  return rows
    .map((row) => {
      const lbl = windowLabel(row, lang)
      const pct = displayPercent(row.used, showRemaining)
      const hot = !plain && estimateWindowPace(row, now, lang, card.snapshots)?.kind === "hot" ? "⚡" : ""
      let resetHint = ""
      if (row.resetsAtMs && row.resetsAtMs > now && (row.used >= 100 || row.status === "limited" || (warnAt > 0 && row.used >= warnAt))) {
        resetHint = ` (${span(row.resetsAtMs - now, lang)})`
      }
      const renderedBar = showBars ? ` ${plain ? asciiBar(displayPercent(row.used, showRemaining), 4) : bar(displayPercent(row.used, showRemaining), 4)}` : ""
      return `${lbl}${renderedBar} ${pct}%${hot}${resetHint}`
    })
    .join(" · ")
}

function asciiBar(percent: number, width: number): string {
  const filled = Math.round((width * Math.min(Math.max(percent, 0), 100)) / 100)
  return `${"#".repeat(filled)}${"-".repeat(width - filled)}`
}

export function cardDetail(
  card: LimitCard,
  now = Date.now(),
  lang: Locale = "en",
  extraLines: readonly string[] = [],
  showRemaining = false,
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
    const statusPart = row.status !== "ok" ? `  [${row.status}]` : ""
    return `${label.padStart(4)}: ${String(displayPercent(row.used, showRemaining)).padStart(3)}%  ${bar(displayPercent(row.used, showRemaining))}  ${resetPart}${deltaPart}${statusPart}`
  })
  const tightLineStr = tightLine(card.rows, now, lang)
  const pace = paceSummary(card.rows, now, lang, card.snapshots)
  const verdicts = card.rows
    .map((row) => windowVerdict(row, now, lang, card.snapshots))
    .filter((v): v is NonNullable<typeof v> => v !== null && v.kind !== "fits")
    .map((v) => v.text)
  const lines = [header, "", ...rows, "", tightLineStr]
  if (pace) lines.push(pace.text)
  for (const verdict of verdicts) lines.push(verdict)
  for (const extra of extraLines) {
    if (extra) lines.push(extra)
  }
  return lines.join("\n")
}
