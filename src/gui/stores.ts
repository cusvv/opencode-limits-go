import { Schema } from "effect"
import type { LimitCard, ProviderActivitySummary, StripMode, TimeFormat } from "../core/index.ts"

export const CONSOLE_URL = "https://opencode.ai/console"

export type UpdateStatusInfo = {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  autoUpdated: boolean
  restartRequired: boolean
  managedByPackageManager?: boolean
  managedByDev?: boolean
  releaseUrl: string
  checkedAtMs: number
  error: string
}

export type ConsoleBudget = {
  id: string
  limit: number
  spent: number
  resetsAt: number
}

export type ZenActivityInfo = {
  usageUrl?: string
  budgets: ConsoleBudget[]
  today: ProviderActivitySummary
  week: ProviderActivitySummary
}

export const PLACEMENTS = ["bottom", "top", "both", "titlebar", "hidden"] as const
export type Placement = (typeof PLACEMENTS)[number]
export type StripStyle = "bars_pct" | "text" | "bars"
export type PresetKey = "standard" | "only5h" | "text" | "minimal"

export const STRIP_MODES = ["selected", "tightest"] as const
export type { StripMode, TimeFormat }

export const PALETTES = ["traffic", "mono", "calm", "stealth"] as const
export type BarPalette = (typeof PALETTES)[number]

export const DENSITIES = ["compact", "normal", "wide"] as const
export type StripDensity = (typeof DENSITIES)[number]

export const STRIP_RESETS = ["never", "exhausted", "warn", "always"] as const
export type StripResetMode = (typeof STRIP_RESETS)[number]

export const LANG_OVERRIDES = ["auto", "en", "ru"] as const
export type LangOverride = (typeof LANG_OVERRIDES)[number]

export const TIME_FORMATS = ["24h", "12h"] as const

export const RESET_FORMATS = ["both", "relative", "absolute"] as const
export type ResetFormat = (typeof RESET_FORMATS)[number]

export const SAMPLE_CARD: LimitCard = {
  ok: true,
  org: "OpenCode",
  email: "",
  checkedAt: "",
  source: "",
  tight: "",
  error: "",
  rows: [
    { key: "rolling", label: "5h", used: 18, status: "ok", resetsAt: "", resetsIn: "3h 15m" },
    { key: "weekly", label: "1w", used: 42, status: "ok", resetsAt: "", resetsIn: "4d 6h" },
    { key: "monthly", label: "1m", used: 68, status: "ok", resetsAt: "", resetsIn: "11d 2h" },
  ],
}

export const Prefs = Schema.Struct({
  placement: Schema.Literals(PLACEMENTS),
  showBars: Schema.Boolean,
  alerts: Schema.Boolean,
  autoUpdate: Schema.Boolean,
})

export const StripPrefs = Schema.Struct({
  show5h: Schema.Boolean,
  show1w: Schema.Boolean,
  show1m: Schema.Boolean,
  showPercent: Schema.Boolean,
  showLabels: Schema.Boolean,
})

export const ExtrasPrefs = Schema.Struct({
  monoBars: Schema.Boolean,
  showZenStats: Schema.Boolean,
  warnThreshold: Schema.Number,
  pollSeconds: Schema.Number,
})

export const DisplayPrefs = Schema.Struct({
  showRemaining: Schema.Boolean,
})

export const CustomizePrefs = Schema.Struct({
  stripMode: Schema.Literals(STRIP_MODES),
  autoHideBelow: Schema.Number,
  palette: Schema.Literals(PALETTES),
  density: Schema.Literals(DENSITIES),
  stripReset: Schema.Literals(STRIP_RESETS),
  showPaceIcon: Schema.Boolean,
  showElapsedTick: Schema.Boolean,
  langOverride: Schema.Literals(LANG_OVERRIDES),
  timeFormat: Schema.Literals(TIME_FORMATS),
  resetFormat: Schema.Literals(RESET_FORMATS),
  dialogPace: Schema.Boolean,
  dialogSparkline: Schema.Boolean,
  dialogSource: Schema.Boolean,
  burnSpikePct: Schema.Number,
})
