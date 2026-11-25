import { For, Show } from "solid-js"
import {
  type LimitCard,
  type LimitRow,
  type Locale,
  type StripMode,
  type UsageSnapshot,
  type VisibleWindows,
  buildSparklinePoints,
  estimateWindowPace,
  selectStripRows,
  windowElapsedRatio,
} from "../core/index.ts"
import { cardErrorText, displayPercent, shortErrorLabel, span, windowLabel } from "../present/index.ts"
import { message } from "../i18n/index.ts"
import type { BarPalette, StripDensity, StripResetMode } from "./stores.ts"

export function amberText(light: boolean): string {
  return light ? "#b45309" : "#f59e0b"
}

export function tone(
  used: number,
  opts?: { palette?: BarPalette; mono?: boolean; light?: boolean; warnAt?: number },
): string {
  const palette: BarPalette = opts?.palette ?? (opts?.mono ? "mono" : "traffic")
  const neutral = opts?.light ? "rgba(0,0,0,.55)" : "rgba(255,255,255,.58)"
  if (used >= 100) return opts?.light ? "#dc2626" : "#ef4444"
  if (palette === "stealth") return neutral
  const warn = opts?.warnAt ?? 80
  if (warn > 0 && used >= warn) return opts?.light ? "#b45309" : "#f59e0b"
  if (palette === "mono") return neutral
  if (palette === "calm") return opts?.light ? "#1d4ed8" : "#3b82f6"
  return opts?.light ? "#15803d" : "#22c55e"
}

export function MiniBar(props: {
  used: number
  width?: number
  height?: number
  light: boolean
  palette?: BarPalette
  mono?: boolean
  warnAt?: number
  elapsedRatio?: number | null
}) {
  const track = () => (props.light ? "rgba(0,0,0,.2)" : "rgba(255,255,255,.16)")
  const widthPct = () => Math.min(Math.max(props.used, 0), 100)
  const tickColor = () => (props.light ? "rgba(0,0,0,.55)" : "rgba(255,255,255,.75)")
  const tickPct = () => {
    if (typeof props.elapsedRatio !== "number") return null
    return Math.min(98, Math.max(2, Math.round(props.elapsedRatio * 100)))
  }
  return (
    <span
      style={`position:relative;display:inline-block;width:${props.width ?? 32}px;height:${props.height ?? 5}px;background:${track()};border-radius:999px;overflow:hidden;vertical-align:middle;`}
    >
      <span
        style={`display:block;height:100%;width:${widthPct()}%;background:${tone(props.used, { palette: props.palette, mono: props.mono, light: props.light, warnAt: props.warnAt })};`}
      />
      <Show when={tickPct() !== null}>
        <span
          style={`position:absolute;top:0;bottom:0;left:${tickPct()}%;width:1.5px;background:${tickColor()};`}
        />
      </Show>
    </span>
  )
}

export function Sparkline(props: {
  snapshots: readonly UsageSnapshot[] | undefined
  light: boolean
  label: string
  palette?: BarPalette
  warnAt?: number
}) {
  const width = 260
  const height = 28
  const data = () => buildSparklinePoints(props.snapshots, "rolling", width, height)
  const strokeColor = () => {
    const d = data()
    if (!d) return "#22c55e"
    return tone(d.max, { palette: props.palette, light: props.light, warnAt: props.warnAt })
  }
  const boxStyle = () => {
    const border = props.light ? "rgba(0,0,0,.09)" : "rgba(255,255,255,.09)"
    const bg = props.light ? "rgba(0,0,0,.02)" : "rgba(255,255,255,.02)"
    return `display:flex;flex-direction:column;gap:4px;padding:6px 10px;border-radius:8px;border:1px solid ${border};background:${bg};`
  }

  return (
    <Show when={data()}>
      {(d) => (
        <div style={boxStyle()}>
          <div style="display:flex;align-items:center;justify-content:space-between;font-size:10px;opacity:.65;font-variant-numeric:tabular-nums;">
            <span>{props.label}</span>
            <span>
              {d().min}% → {d().max}%
            </span>
          </div>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${props.label}: ${d().min}% to ${d().max}%`}
            style="width:100%;height:26px;display:block;overflow:visible;"
          >
            <polygon points={d().area} fill={strokeColor()} fill-opacity="0.14" />
            <polyline
              points={d().polyline}
              fill="none"
              stroke={strokeColor()}
              stroke-width="1.6"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
          </svg>
        </div>
      )}
    </Show>
  )
}

export function SectionDivider(props: { label: string; light: boolean }) {
  const border = () => (props.light ? "rgba(0,0,0,.08)" : "rgba(255,255,255,.08)")
  return (
    <div
      style={`font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;opacity:.62;padding-top:6px;margin-top:2px;border-top:1px solid ${border()};`}
    >
      {props.label}
    </div>
  )
}

const DENSITY_METRICS: Record<
  StripDensity,
  { fontSize: number; gapTop: number; gapBottom: number; barTop: number; barBottom: number; barHeight: number }
> = {
  compact: { fontSize: 10, gapTop: 6, gapBottom: 8, barTop: 18, barBottom: 24, barHeight: 4 },
  normal: { fontSize: 11, gapTop: 8, gapBottom: 12, barTop: 24, barBottom: 32, barHeight: 5 },
  wide: { fontSize: 12, gapTop: 10, gapBottom: 14, barTop: 34, barBottom: 44, barHeight: 6 },
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
  palette?: BarPalette
  density?: StripDensity
  stripMode?: StripMode
  stripReset?: StripResetMode
  showPaceIcon?: boolean
  showElapsedTick?: boolean
  warnAt?: number
  visible: VisibleWindows
  variant: "bottom" | "top"
  preview?: boolean
  onOpen: () => void
}) {
  const rows = () => selectStripRows(props.card?.rows ?? [], props.visible, props.stripMode ?? "selected")
  const effBars = () => props.showBars
  const effPercent = () => props.showPercent || !effBars()
  const prefix = () => message(props.lang, "card.limits")
  const metrics = () => DENSITY_METRICS[props.density ?? "normal"]
  const ariaLabel = () => {
    const base = message(props.lang, "strip.title")
    if (!props.card?.ok) {
      return `${base}: ${props.ready ? shortErrorLabel(cardErrorText(props.card, props.lang), props.lang) : "…"}`
    }
    const summary = rows()
      .map((row) => {
        const pct = displayPercent(row.used, props.showRemaining)
        const reset = row.resetsAtMs ? `, ${span(row.resetsAtMs - Date.now(), props.lang)}` : ""
        return `${windowLabel(row, props.lang)} ${pct}%${props.showRemaining ? " left" : ""}${reset}`
      })
      .join("; ")
    return `${base}: ${summary}. ${message(props.lang, "strip.openDetails")}`
  }

  const buttonStyle = () => {
    const m = metrics()
    const cursor = props.preview ? "default" : "pointer"
    const opacity = props.stale ? "opacity:.72;" : ""
    if (props.variant === "top") {
      const border = props.light ? "rgba(0,0,0,.12)" : "rgba(255,255,255,.12)"
      const bg = props.light ? "rgba(0,0,0,.04)" : "rgba(255,255,255,.05)"
      return `background:${bg};border:1px solid ${border};border-radius:6px;margin:0;color:inherit;font:inherit;cursor:${cursor};display:inline-flex;align-items:center;gap:${m.gapTop}px;padding:4px 8px;font-size:${m.fontSize}px;line-height:1.2;white-space:nowrap;${opacity}`
    }
    return `background:transparent;border:0;margin:0;color:inherit;font:inherit;cursor:${cursor};display:inline-flex;align-items:center;gap:${m.gapBottom}px;padding:3px 10px;font-size:${m.fontSize}px;white-space:nowrap;${opacity}`
  }

  return (
    <button type="button" aria-label={ariaLabel()} onClick={props.onOpen} style={buttonStyle()}>
      <Show
        when={props.card?.ok}
        fallback={
          <span style={`color:${amberText(props.light)};`}>
            {prefix()}: {props.ready ? shortErrorLabel(cardErrorText(props.card, props.lang), props.lang) : "…"}
          </span>
        }
      >
        <For each={rows()}>
          {(row: LimitRow) => {
            const nowMs = () => props.card?.checkedAtMs || Date.now()
            const hot = () =>
              (props.showPaceIcon ?? true) &&
              estimateWindowPace(row, nowMs(), props.card?.snapshots)?.kind === "hot"
            const elapsed = () => (props.showElapsedTick ? windowElapsedRatio(row, nowMs()) : null)
            const resetHint = () => {
              const mode = props.stripReset ?? "exhausted"
              if (mode === "never") return ""
              const isExhausted = row.used >= 100 || row.status === "limited"
              const warn = props.warnAt ?? 80
              const isWarn = warn > 0 && row.used >= warn
              if (mode === "exhausted" && !isExhausted) return ""
              if (mode === "warn" && !isExhausted && !isWarn) return ""
              if (row.resetsAtMs && row.resetsAtMs > nowMs()) {
                return span(row.resetsAtMs - nowMs(), props.lang)
              }
              return props.preview && row.resetsIn ? row.resetsIn : ""
            }
            const resetColor = () =>
              row.used >= 100 || row.status === "limited" ? (props.light ? "#dc2626" : "#ef4444") : "inherit"
            return (
              <span style="display:inline-flex;align-items:center;gap:5px;">
                <Show when={props.showLabels}>
                  <span style="opacity:.6;">{windowLabel(row, props.lang)}</span>
                </Show>
                <Show when={effBars()}>
                  <MiniBar
                    used={row.used}
                    width={props.variant === "top" ? metrics().barTop : metrics().barBottom}
                    height={metrics().barHeight}
                    light={props.light}
                    palette={props.palette}
                    warnAt={props.warnAt}
                    elapsedRatio={elapsed()}
                  />
                </Show>
                <Show when={effPercent()}>
                  <span style="font-variant-numeric:tabular-nums;">
                    {displayPercent(row.used, props.showRemaining)}%
                  </span>
                </Show>
                <Show when={resetHint()}>
                  <span
                    style={`color:${resetColor()};opacity:${row.used >= 100 ? "1" : ".65"};font-size:${Math.max(9, metrics().fontSize - 1)}px;font-variant-numeric:tabular-nums;`}
                  >
                    ({resetHint()})
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
