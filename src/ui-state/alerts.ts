import {
  type LimitCard,
  type Locale,
  accountKey,
  detectBurnSpike,
  newAlerts,
  recoveredAlerts,
  windowVerdict,
} from "../core/index.ts"
import { alertMessage, burnSpikeMessage, resetAlertMessage, windowVerdictText } from "../present/index.ts"

export const ALERT_STATE_VERSION = 1
export const SYSTEM_NOTIFY_INTERVAL_MS = 10 * 60_000
export const SPIKE_INTERVAL_MS = 30 * 60_000

export type AlertState = {
  account: string
  notified: Record<string, number>
  exhausted: string[]
  risk: Record<string, string>
  spikeAt: number
  systemAt?: number
}

export type AlertPrefs = {
  alerts: boolean
  warnThreshold: number
  burnSpikePct: number
  systemNotifications: boolean
  lang: Locale
}

export type AlertNotification = {
  kind: "threshold" | "reset" | "tight" | "spike"
  variant: "default" | "success" | "error" | "warning"
  text: string
  attention: boolean
}

export type AlertReduction = {
  state: AlertState
  notifications: AlertNotification[]
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function cardAccountId(card: LimitCard): string | undefined {
  if (!("accountId" in card)) return undefined
  const value: unknown = card.accountId
  return typeof value === "string" ? value : undefined
}

export type AlertStateInput = {
  account?: string
  notified?: Readonly<Record<string, number>>
  exhausted?: readonly string[]
  risk?: Readonly<Record<string, string>>
  spikeAt?: number
  systemAt?: number
}

/** Builds a complete state from a possibly older or partial stored value. */
export function createAlertState(initial: AlertStateInput = {}): AlertState {
  const notified: Record<string, number> = {}
  if (initial.notified && typeof initial.notified === "object") {
    for (const [key, value] of Object.entries(initial.notified)) {
      if (isFiniteNumber(value)) notified[key] = value
    }
  }
  const risk: Record<string, string> = {}
  if (initial.risk && typeof initial.risk === "object") {
    for (const [key, value] of Object.entries(initial.risk)) {
      if (typeof value === "string") risk[key] = value
    }
  }
  const exhausted = Array.isArray(initial.exhausted)
    ? initial.exhausted.filter((key): key is string => typeof key === "string")
    : []
  const state: AlertState = {
    account: typeof initial.account === "string" ? initial.account : "",
    notified,
    exhausted,
    risk,
    spikeAt: isFiniteNumber(initial.spikeAt) ? initial.spikeAt : 0,
  }
  if (isFiniteNumber(initial.systemAt)) state.systemAt = initial.systemAt
  return state
}

/**
 * Advances alert dedupe state for one status card and reports what the UI should show.
 * Stale, failed, or disabled polls leave the state untouched so a later valid poll can still alert.
 */
export function reduceAlerts(
  state: AlertState,
  card: LimitCard,
  prefs: AlertPrefs,
  now = Date.now(),
): AlertReduction {
  if (!card.ok || card.stale || !prefs.alerts) return { state, notifications: [] }

  const account = cardAccountId(card) ?? accountKey(card.org, card.email, card.source)
  const changedAccount = !!state.account && state.account !== account

  const notified = new Map<string, number>(changedAccount ? [] : Object.entries(state.notified))
  const exhausted = new Set<string>(changedAccount ? [] : state.exhausted)
  const risk: Record<string, string> = changedAccount ? {} : { ...state.risk }
  let spikeAt = changedAccount ? 0 : state.spikeAt
  let systemAt = changedAccount ? undefined : state.systemAt

  const notifications: AlertNotification[] = []

  for (const row of newAlerts(card.rows, notified, prefs.warnThreshold)) {
    const exhaustedNow = row.used >= 100 || row.status === "limited"
    let attention = false
    if (prefs.systemNotifications && exhaustedNow) {
      if (systemAt === undefined || now - systemAt >= SYSTEM_NOTIFY_INTERVAL_MS) {
        attention = true
        systemAt = now
      }
    }
    notifications.push({
      kind: "threshold",
      variant: exhaustedNow ? "error" : "warning",
      text: alertMessage(row, now, prefs.lang),
      attention,
    })
  }

  for (const row of recoveredAlerts(card.rows, exhausted)) {
    notifications.push({
      kind: "reset",
      variant: "success",
      text: resetAlertMessage(row, prefs.lang),
      attention: false,
    })
  }

  for (const row of card.rows) {
    const verdict = windowVerdict(row, now, card.snapshots)
    if (!verdict || verdict.kind !== "tight") continue
    const id = row.key ?? row.label
    const signature = String(row.resetsAtMs ?? 0)
    if (risk[id] === signature) continue
    risk[id] = signature
    notifications.push({ kind: "tight", variant: "warning", text: windowVerdictText(verdict, prefs.lang), attention: false })
  }

  if (prefs.burnSpikePct > 0 && now - spikeAt > SPIKE_INTERVAL_MS) {
    const spike = detectBurnSpike(card.rows, card.snapshots, prefs.burnSpikePct, now)
    if (spike) {
      spikeAt = now
      notifications.push({
        kind: "spike",
        variant: "warning",
        text: burnSpikeMessage(spike, prefs.lang),
        attention: false,
      })
    }
  }

  const next: AlertState = {
    account,
    notified: Object.fromEntries(notified),
    exhausted: [...exhausted],
    risk,
    spikeAt,
  }
  if (systemAt !== undefined) next.systemAt = systemAt
  return { state: next, notifications }
}
