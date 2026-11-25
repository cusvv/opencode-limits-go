export const LANG_OVERRIDES = ["auto", "en", "ru"] as const
export type LangOverride = (typeof LANG_OVERRIDES)[number]

/** Preferences shared between the server and every UI. */
export type SharedPrefs = {
  rolling: boolean
  weekly: boolean
  monthly: boolean
  showRemaining: boolean
  alerts: boolean
  systemNotifications: boolean
  warnThreshold: number
  burnSpikePct: number
  langOverride: LangOverride
}

export type SharedPrefsPatch = Partial<SharedPrefs>

export const SHARED_PREFS_DEFAULTS: SharedPrefs = {
  rolling: true,
  weekly: true,
  monthly: true,
  showRemaining: false,
  alerts: true,
  systemNotifications: false,
  warnThreshold: 80,
  burnSpikePct: 20,
  langOverride: "auto",
}

export function isLangOverride(value: unknown): value is LangOverride {
  return value === "auto" || value === "en" || value === "ru"
}

/** Keeps only known preference keys with the right types; drops everything else. */
export function sanitizeSharedPrefs(raw: unknown): SharedPrefsPatch {
  if (!raw || typeof raw !== "object") return {}
  const rec = raw as Record<string, unknown>
  const out: SharedPrefsPatch = {}
  if (typeof rec.rolling === "boolean") out.rolling = rec.rolling
  if (typeof rec.weekly === "boolean") out.weekly = rec.weekly
  if (typeof rec.monthly === "boolean") out.monthly = rec.monthly
  if (typeof rec.showRemaining === "boolean") out.showRemaining = rec.showRemaining
  if (typeof rec.alerts === "boolean") out.alerts = rec.alerts
  if (typeof rec.systemNotifications === "boolean") out.systemNotifications = rec.systemNotifications
  if (typeof rec.warnThreshold === "number" && Number.isFinite(rec.warnThreshold)) out.warnThreshold = rec.warnThreshold
  if (typeof rec.burnSpikePct === "number" && Number.isFinite(rec.burnSpikePct)) out.burnSpikePct = rec.burnSpikePct
  if (isLangOverride(rec.langOverride)) out.langOverride = rec.langOverride
  return out
}

/** Layers patches left-to-right on top of the defaults; later layers win. */
export function mergeSharedPrefs(...layers: Array<SharedPrefsPatch | undefined>): SharedPrefs {
  const out: SharedPrefs = { ...SHARED_PREFS_DEFAULTS }
  for (const layer of layers) {
    if (layer) Object.assign(out, layer)
  }
  return out
}
