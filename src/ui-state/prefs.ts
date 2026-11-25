export const SHARED_PREF_KEYS = [
  "rolling",
  "weekly",
  "monthly",
  "showRemaining",
  "alerts",
  "systemNotifications",
  "warnThreshold",
  "burnSpikePct",
  "langOverride",
  "autoUpdate",
] as const

export type SharedPrefKey = (typeof SHARED_PREF_KEYS)[number]
export type SharedPrefs = Partial<Record<SharedPrefKey, unknown>>
export type LangChoice = "auto" | "en" | "ru"

export type SharedPrefHandlers = {
  windows?: (value: { rolling?: boolean; weekly?: boolean; monthly?: boolean }) => void
  showRemaining?: (value: boolean) => void
  alerts?: (value: boolean) => void
  systemNotifications?: (value: boolean) => void
  warnThreshold?: (value: number) => void
  burnSpikePct?: (value: number) => void
  langOverride?: (value: LangChoice) => void
  autoUpdate?: (value: boolean) => void
}

/** Keeps only the keys the server shares with both UIs. Values are passed through untouched. */
export function pickSharedPrefs(patch: Record<string, unknown>): SharedPrefs {
  const picked: SharedPrefs = {}
  for (const key of SHARED_PREF_KEYS) {
    if (key in patch) picked[key] = patch[key]
  }
  return picked
}

function isLangChoice(value: unknown): value is LangChoice {
  return value === "auto" || value === "en" || value === "ru"
}

/**
 * Applies a `getPrefs` reply to the caller's stores. Type checks only: the server validates
 * values, so a field of an unexpected type is ignored instead of trusted.
 */
export function applySharedPrefs(shared: Record<string, unknown> | null | undefined, handlers: SharedPrefHandlers): void {
  if (!shared) return

  const windows: { rolling?: boolean; weekly?: boolean; monthly?: boolean } = {}
  if (typeof shared.rolling === "boolean") windows.rolling = shared.rolling
  if (typeof shared.weekly === "boolean") windows.weekly = shared.weekly
  if (typeof shared.monthly === "boolean") windows.monthly = shared.monthly
  if (Object.keys(windows).length > 0) handlers.windows?.(windows)

  if (typeof shared.showRemaining === "boolean") handlers.showRemaining?.(shared.showRemaining)
  if (typeof shared.alerts === "boolean") handlers.alerts?.(shared.alerts)
  if (typeof shared.systemNotifications === "boolean") {
    handlers.systemNotifications?.(shared.systemNotifications)
  }
  if (typeof shared.warnThreshold === "number") handlers.warnThreshold?.(shared.warnThreshold)
  if (typeof shared.burnSpikePct === "number") handlers.burnSpikePct?.(shared.burnSpikePct)
  if (isLangChoice(shared.langOverride)) handlers.langOverride?.(shared.langOverride)
  if (typeof shared.autoUpdate === "boolean") handlers.autoUpdate?.(shared.autoUpdate)
}
