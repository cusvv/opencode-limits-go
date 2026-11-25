import assert from "node:assert/strict"
import test from "node:test"
import type { LimitCard, LimitRow } from "../core/index.ts"
import { type AlertPrefs, createAlertState, reduceAlerts } from "./alerts.ts"

const NOW = 1_800_000_000_000
const MINUTE = 60_000

function row(used: number, status = "ok"): LimitRow {
  return { key: "rolling", label: "5h", used, status, resetsAt: "", resetsIn: "3h" }
}

function card(rows: LimitRow[], extra: Partial<LimitCard> = {}): LimitCard {
  return {
    ok: true,
    org: "OpenCode",
    email: "user@example.com",
    checkedAt: "",
    source: "cli",
    rows,
    tight: "",
    error: "",
    ...extra,
  }
}

function prefs(overrides: Partial<AlertPrefs> = {}): AlertPrefs {
  return {
    alerts: true,
    warnThreshold: 80,
    burnSpikePct: 0,
    systemNotifications: false,
    lang: "en",
    ...overrides,
  }
}

test("threshold fires once per crossing and repeats only after the count drops", () => {
  const current = createAlertState()
  const first = reduceAlerts(current, card([row(95)]), prefs(), NOW)
  assert.equal(first.notifications.length, 1)
  assert.equal(first.notifications[0]?.kind, "threshold")
  assert.equal(first.notifications[0]?.text, "Limit 5h: 95%, resets: 3h")
  assert.equal(first.notifications[0]?.attention, false)
  assert.equal(first.state.notified.rolling, 80)

  const second = reduceAlerts(first.state, card([row(97)]), prefs(), NOW + MINUTE)
  assert.deepEqual(second.notifications, [])
  assert.equal(second.state.notified.rolling, 80)

  // Crossing the next level (100) alerts once more, then dedupes.
  const top = reduceAlerts(second.state, card([row(100)]), prefs(), NOW + MINUTE)
  assert.equal(top.notifications.length, 1)
  assert.equal(top.notifications[0]?.text, "Limit 5h: 100%, resets: 3h")
  assert.equal(top.state.notified.rolling, 100)
  const topAgain = reduceAlerts(top.state, card([row(100)]), prefs(), NOW + 2 * MINUTE)
  assert.deepEqual(topAgain.notifications, [])
})

test("a limited window below 100 reported percent alerts as threshold with attention", () => {
  const next = reduceAlerts(createAlertState(), card([row(95, "limited")]), prefs({ systemNotifications: true }), NOW)
  assert.equal(next.notifications.length, 1)
  const alert = next.notifications[0]
  assert.equal(alert?.kind, "threshold")
  assert.equal(alert?.variant, "error")
  assert.equal(alert?.attention, true)
  assert.match(alert?.text ?? "", /limit reached \(95% reported\)/)
  assert.equal(next.state.systemAt, NOW)
})

test("attention stays off without system notifications", () => {
  const next = reduceAlerts(createAlertState(), card([row(100)]), prefs(), NOW)
  assert.equal(next.notifications[0]?.attention, false)
  assert.equal(next.state.systemAt, undefined)
})

test("reset alerts after a window falls back below 100", () => {
  const exhausted = reduceAlerts(createAlertState(), card([row(100)]), prefs(), NOW)
  assert.equal(exhausted.notifications[0]?.kind, "threshold")
  const recovered = reduceAlerts(exhausted.state, card([row(42)]), prefs(), NOW + MINUTE)
  assert.equal(recovered.notifications.length, 1)
  assert.equal(recovered.notifications[0]?.kind, "reset")
  assert.equal(recovered.notifications[0]?.variant, "success")
  assert.equal(recovered.notifications[0]?.text, "5h limit reset — now at 42%")
  assert.deepEqual(recovered.state.exhausted, [])
})

test("a changed account clears dedupe state and alerts again", () => {
  const first = reduceAlerts(createAlertState(), card([row(50)]), prefs({ warnThreshold: 50 }), NOW)
  assert.equal(first.notifications.length, 1)
  assert.equal(first.state.account, "opencode|user@example.com|cli")

  const other = reduceAlerts(
    first.state,
    card([row(50)], { email: "other@example.com" }),
    prefs({ warnThreshold: 50 }),
    NOW + MINUTE,
  )
  assert.equal(other.notifications.length, 1)
  assert.equal(other.notifications[0]?.kind, "threshold")
  assert.equal(other.state.account, "opencode|other@example.com|cli")
  assert.equal(other.state.notified.rolling, 50)
})

test("stale cards and disabled alerts leave the state untouched", () => {
  const current = createAlertState({ account: "opencode|user@example.com|cli", notified: { rolling: 100 }, spikeAt: 7 })
  const stale = reduceAlerts(current, card([row(99)], { stale: true }), prefs(), NOW)
  assert.equal(stale.state, current)
  assert.deepEqual(stale.notifications, [])

  const disabled = reduceAlerts(current, card([row(99)]), prefs({ alerts: false }), NOW)
  assert.equal(disabled.state, current)
  assert.deepEqual(disabled.notifications, [])

  const failedCard = reduceAlerts(current, { ...card([]), ok: false, error: "boom" }, prefs(), NOW)
  assert.equal(failedCard.state, current)
  assert.deepEqual(failedCard.notifications, [])
})

test("spike alerts respect the 30 minute gate", () => {
  const spikeCard = card([row(40)], { snapshots: [{ at: NOW - 10 * MINUTE, rolling: 5 }] })
  const options = prefs({ burnSpikePct: 20 })

  const first = reduceAlerts(createAlertState(), spikeCard, options, NOW)
  const spikes = first.notifications.filter((n) => n.kind === "spike")
  assert.equal(spikes.length, 1)
  assert.match(spikes[0]?.text ?? "", /Fast burn on 5h: \+35% in/)
  assert.equal(first.state.spikeAt, NOW)

  const gated = reduceAlerts(first.state, spikeCard, options, NOW + 10 * MINUTE)
  assert.deepEqual(
    gated.notifications.filter((n) => n.kind === "spike"),
    [],
  )

  const afterGate = reduceAlerts({ ...first.state, spikeAt: NOW - 31 * MINUTE }, spikeCard, options, NOW)
  assert.equal(afterGate.notifications.filter((n) => n.kind === "spike").length, 1)
})

test("system notifications are throttled to one per 10 minutes", () => {
  const options = prefs({ systemNotifications: true })

  const first = reduceAlerts(createAlertState(), card([row(100)]), options, NOW)
  assert.equal(first.notifications[0]?.attention, true)
  assert.equal(first.state.systemAt, NOW)

  // Recovered and hits 100 again inside the throttle window: toast yes, OS notification no.
  const recovered = reduceAlerts(first.state, card([row(20)]), options, NOW + MINUTE)
  const second = reduceAlerts(recovered.state, card([row(100)]), options, NOW + 2 * MINUTE)
  assert.equal(second.notifications.filter((n) => n.kind === "threshold").length, 1)
  assert.equal(second.notifications.find((n) => n.kind === "threshold")?.attention, false)
  assert.equal(second.state.systemAt, NOW)

  // Past the window it notifies the system again.
  const recoveredLater = reduceAlerts(second.state, card([row(20)]), options, NOW + 11 * MINUTE)
  const third = reduceAlerts(recoveredLater.state, card([row(100)]), options, NOW + 12 * MINUTE)
  assert.equal(third.notifications.find((n) => n.kind === "threshold")?.attention, true)
  assert.equal(third.state.systemAt, NOW + 12 * MINUTE)
})

test("tight pace notifications dedupe by window and reset time", () => {
  const resetsAtMs = NOW + 4 * 3_600_000
  const tightRow: LimitRow = {
    key: "rolling",
    label: "5h",
    used: 50,
    status: "ok",
    resetsAt: "",
    resetsAtMs,
    resetsIn: "4h",
  }
  const first = reduceAlerts(createAlertState(), card([tightRow]), prefs(), NOW)
  const tight = first.notifications.filter((n) => n.kind === "tight")
  assert.equal(tight.length, 1)
  assert.equal(tight[0]?.text, "5h: ~1h 00m to 100%, resets in 4h 00m")

  const repeat = reduceAlerts(first.state, card([tightRow]), prefs(), NOW + MINUTE)
  assert.deepEqual(
    repeat.notifications.filter((n) => n.kind === "tight"),
    [],
  )

  const nextWindow = reduceAlerts(first.state, card([{ ...tightRow, resetsAtMs: resetsAtMs + 5 * 3_600_000 }]), prefs(), NOW)
  assert.equal(nextWindow.notifications.filter((n) => n.kind === "tight").length, 1)
})

test("createAlertState tolerates old or malformed stored values", () => {
  const restored = createAlertState({
    notified: { rolling: 100, bad: Number.NaN },
    exhausted: ["rolling", 7 as unknown as string],
    risk: { rolling: "123", bad: 5 as unknown as string },
    spikeAt: Number.POSITIVE_INFINITY,
  })
  assert.deepEqual(restored.notified, { rolling: 100 })
  assert.deepEqual(restored.exhausted, ["rolling"])
  assert.deepEqual(restored.risk, { rolling: "123" })
  assert.equal(restored.spikeAt, 0)
  assert.equal(restored.account, "")
  assert.equal(restored.systemAt, undefined)
})
