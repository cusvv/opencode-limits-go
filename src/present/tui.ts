import {
  type LimitCard,
  type LimitRow,
  type Locale,
  type VisibleWindows,
  estimateWindowPace,
  filterStripRows,
  paceSummary,
  tightestRow,
  windowVerdict,
} from "../core/index.ts"
import { message } from "../i18n/index.ts"
import { paceSummaryText, windowVerdictText } from "./alerts.ts"
import {
  asciiBar,
  bar,
  cardErrorText,
  displayPercent,
  resetText,
  shortErrorLabel,
  sourceLabel,
  span,
  tightLine,
  windowLabel,
} from "./format.ts"

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
  if (!card.ok) {
    return message(lang, "card.error", {
      prefix: message(lang, "card.limits"),
      error: shortErrorLabel(cardErrorText(card, lang), lang),
    })
  }
  const all = filterStripRows(card.rows, visible)
  const rows = compact ? [tightestRow(all, now) ?? all[0]] : all
  return rows
    .map((row) => {
      const lbl = windowLabel(row, lang)
      const pct = displayPercent(row.used, showRemaining)
      const hot = !plain && estimateWindowPace(row, now, card.snapshots)?.kind === "hot" ? "⚡" : ""
      let resetHint = ""
      if (row.resetsAtMs && row.resetsAtMs > now && (row.used >= 100 || row.status === "limited" || (warnAt > 0 && row.used >= warnAt))) {
        resetHint = ` (${span(row.resetsAtMs - now, lang)})`
      }
      const renderedBar = showBars
        ? ` ${plain ? asciiBar(displayPercent(row.used, showRemaining), 4) : bar(displayPercent(row.used, showRemaining), 4)}`
        : ""
      return `${lbl}${renderedBar} ${pct}%${hot}${resetHint}`
    })
    .join(" · ")
}

export function cardDetail(
  card: LimitCard,
  now = Date.now(),
  lang: Locale = "en",
  extraLines: readonly string[] = [],
  showRemaining = false,
  narrow = false,
  plain = false,
): string {
  const source = sourceLabel(card.source, lang)
  const header = `${message(lang, "detail.checked")}: ${card.checkedAt}${source ? ` · ${source}` : ""}`
  const rows = card.rows.map((row: LimitRow) => {
    const label = windowLabel(row, lang)
    const { passed, text } = resetText(row.resetsAtMs, row.resetsIn, now, lang)
    const dateText = row.resetsAt || "?"
    const resetPart = narrow
      ? passed
        ? text
        : message(lang, "detail.pending", { text })
      : passed
        ? `${dateText} (${text})`
        : `${dateText} (${message(lang, "detail.pending", { text })})`
    const deltaPart = row.delta1h && row.delta1h > 0 ? `  +${row.delta1h}%` : ""
    const statusPart = row.status !== "ok" ? `  [${row.status}]` : ""
    const width = narrow ? 10 : 20
    const renderedBar = plain
      ? asciiBar(displayPercent(row.used, showRemaining), width)
      : bar(displayPercent(row.used, showRemaining), width)
    return `${label.padStart(4)}: ${String(displayPercent(row.used, showRemaining)).padStart(3)}%  ${renderedBar}  ${resetPart}${deltaPart}${statusPart}`
  })
  const tightLineStr = tightLine(card.rows, now, lang)
  const pace = paceSummary(card.rows, now, card.snapshots)
  const verdicts = card.rows
    .map((row) => windowVerdict(row, now, card.snapshots))
    .filter((v): v is NonNullable<typeof v> => v !== null && v.kind !== "fits")
    .map((v) => windowVerdictText(v, lang))
  const lines = [header, "", ...rows, "", tightLineStr]
  if (pace) lines.push(paceSummaryText(pace, lang))
  for (const verdict of verdicts) lines.push(verdict)
  for (const extra of extraLines) {
    if (extra) lines.push(extra)
  }
  return lines.join("\n")
}
