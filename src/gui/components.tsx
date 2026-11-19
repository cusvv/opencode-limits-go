import { For, Show } from "solid-js"
import {
  type LimitCard,
  type LimitRow,
  type Locale,
  type VisibleWindows,
  displayPercent,
  estimateWindowPace,
  filterStripRows,
  shortErrorLabel,
  span,
  windowLabel,
} from "../model.ts"

export function amberText(light: boolean): string {
  return light ? "#b45309" : "#f59e0b"
}

export function tone(used: number, opts?: { mono?: boolean; light?: boolean; warnAt?: number }): string {
  if (used >= 100) return "#ef4444"
  const warn = opts?.warnAt ?? 80
  if (warn > 0 && used >= warn) return "#f59e0b"
  if (opts?.mono) return opts.light ? "rgba(0,0,0,.45)" : "rgba(255,255,255,.58)"
  return "#22c55e"
}

export function MiniBar(props: {
  used: number
  width?: number
  light: boolean
  mono?: boolean
  warnAt?: number
  elapsedRatio?: number | null
}) {
  const track = () => (props.light ? "rgba(0,0,0,.14)" : "rgba(255,255,255,.16)")
  const widthPct = () => Math.min(Math.max(props.used, 0), 100)
  const tickColor = () => (props.light ? "rgba(0,0,0,.55)" : "rgba(255,255,255,.75)")
  const tickPct = () => {
    if (typeof props.elapsedRatio !== "number") return null
    return Math.min(98, Math.max(2, Math.round(props.elapsedRatio * 100)))
  }
  return (
    <span
      style={`position:relative;display:inline-block;width:${props.width ?? 32}px;height:5px;background:${track()};border-radius:999px;overflow:hidden;vertical-align:middle;`}
    >
      <span
        style={`display:block;height:100%;width:${widthPct()}%;background:${tone(props.used, { mono: props.mono, light: props.light, warnAt: props.warnAt })};`}
      />
      <Show when={tickPct() !== null}>
        <span
          style={`position:absolute;top:0;bottom:0;left:${tickPct()}%;width:1.5px;background:${tickColor()};`}
        />
      </Show>
    </span>
  )
}

export function SectionDivider(props: { label: string; light: boolean }) {
  const border = () => (props.light ? "rgba(0,0,0,.08)" : "rgba(255,255,255,.08)")
  return (
    <div
      style={`font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;opacity:.5;padding-top:6px;margin-top:2px;border-top:1px solid ${border()};`}
    >
      {props.label}
    </div>
  )
}

export function LimitsStrip(props: {
  card: LimitCard | null
  ready: boolean
  stale?: boolean
  lang: Locale
  light: boolean
  showBars: boolean
  showPercent: boolean
  showLabels: boolean
  showRemaining?: boolean
  monoBars?: boolean
  warnAt?: number
  visible: VisibleWindows
  variant: "bottom" | "top"
  preview?: boolean
  onOpen: () => void
}) {
  const rows = () => filterStripRows(props.card?.rows ?? [], props.visible)
  const effBars = () => props.showBars
  const effPercent = () => props.showPercent || !effBars()
  const prefix = () => (props.lang === "ru" ? "лимиты" : "limits")

  const buttonStyle = () => {
    const cursor = props.preview ? "default" : "pointer"
    const opacity = props.stale ? "opacity:.72;" : ""
    if (props.variant === "top") {
      const border = props.light ? "rgba(0,0,0,.12)" : "rgba(255,255,255,.12)"
      const bg = props.light ? "rgba(0,0,0,.04)" : "rgba(255,255,255,.05)"
      return `background:${bg};border:1px solid ${border};border-radius:6px;margin:0;color:inherit;font:inherit;cursor:${cursor};display:inline-flex;align-items:center;gap:8px;padding:4px 8px;font-size:11px;line-height:1.2;white-space:nowrap;${opacity}`
    }
    return `background:transparent;border:0;margin:0;color:inherit;font:inherit;cursor:${cursor};display:inline-flex;align-items:center;gap:12px;padding:3px 10px;font-size:11px;white-space:nowrap;${opacity}`
  }

  return (
    <button type="button" onClick={props.onOpen} style={buttonStyle()}>
      <Show
        when={props.card?.ok}
        fallback={
          <span style={`color:${amberText(props.light)};`}>
            {prefix()}: {props.ready ? shortErrorLabel(props.card?.error, props.lang) : "…"}
          </span>
        }
      >
        <For each={rows()}>
          {(row: LimitRow) => {
            const nowMs = () => props.card?.checkedAtMs || Date.now()
            const hot = () =>
              estimateWindowPace(row, nowMs(), props.lang, props.card?.snapshots)?.kind === "hot"
            const exhaustedReset = () => {
              if (row.used < 100 && row.status !== "limited") return ""
              if (!row.resetsAtMs || row.resetsAtMs <= nowMs()) return ""
              return span(row.resetsAtMs - nowMs(), props.lang)
            }
            return (
              <span style="display:inline-flex;align-items:center;gap:5px;">
                <Show when={props.showLabels}>
                  <span style="opacity:.6;">{windowLabel(row, props.lang)}</span>
                </Show>
                <Show when={effBars()}>
                  <MiniBar
                    used={row.used}
                    width={props.variant === "top" ? 24 : 32}
                    light={props.light}
                    mono={props.monoBars}
                    warnAt={props.warnAt}
                  />
                </Show>
                <Show when={effPercent()}>
                  <span style="font-variant-numeric:tabular-nums;">
                    {displayPercent(row.used, props.showRemaining)}%
                  </span>
                </Show>
                <Show when={exhaustedReset()}>
                  <span style="color:#ef4444;font-size:10px;font-variant-numeric:tabular-nums;">
                    ({exhaustedReset()})
                  </span>
                </Show>
                <Show when={hot()}>
                  <span style={`color:${amberText(props.light)};font-size:10px;line-height:1;`}>⚡</span>
                </Show>
              </span>
            )
          }}
        </For>
      </Show>
    </button>
  )
}
