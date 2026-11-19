import { Schema } from "effect"
import type { LimitCard, ProviderActivitySummary } from "../model.ts"

export const CONSOLE_URL = "https://opencode.ai/console"

export type UpdateStatusInfo = {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  autoUpdated: boolean
  restartRequired: boolean
  managedByPackageManager?: boolean
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
}

export const PLACEMENTS = ["bottom", "top", "both", "titlebar", "hidden"] as const
export type Placement = (typeof PLACEMENTS)[number]
export type StripStyle = "bars_pct" | "text" | "bars"
export type PresetKey = "standard" | "only5h" | "text" | "minimal"

export const SAMPLE_CARD: LimitCard = {
  ok: true,
  org: "OpenCode",
  email: "",
  checkedAt: "",
  source: "",
  tight: "",
  error: "",
  rows: [
    { key: "rolling", label: "5h", used: 18, status: "ok", resetsAt: "", resetsIn: "" },
    { key: "weekly", label: "1w", used: 42, status: "ok", resetsAt: "", resetsIn: "" },
    { key: "monthly", label: "1m", used: 68, status: "ok", resetsAt: "", resetsIn: "" },
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
