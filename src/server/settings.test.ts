import { test } from "node:test"
import assert from "node:assert/strict"
import {
  SHARED_PREFS_DEFAULTS,
  mergeSharedPrefs,
  sanitizeSharedPrefs,
} from "../settings/index.ts"
import { createPrefsStore, SHARED_PREFS_KEY } from "./service/prefs.ts"
import { createLimitsService } from "./service/service.ts"

function memoryStorage(initial: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(initial))
  return {
    map,
    get: async (key: string) => map.get(key),
    set: async (key: string, value: unknown) => {
      map.set(key, value)
    },
    remove: async (key: string) => {
      map.delete(key)
    },
  }
}

test("sanitizeSharedPrefs keeps known typed keys and drops everything else", () => {
  const patch = sanitizeSharedPrefs({
    rolling: false,
    weekly: "yes",
    monthly: true,
    showRemaining: 1,
    alerts: false,
    systemNotifications: true,
    warnThreshold: 75,
    burnSpikePct: Number.NaN,
    langOverride: "de",
    autoUpdate: false,
    token: "secret",
  })
  assert.deepEqual(patch, {
    rolling: false,
    monthly: true,
    alerts: false,
    systemNotifications: true,
    warnThreshold: 75,
  })
  assert.equal(sanitizeSharedPrefs(null).rolling, undefined)
  assert.deepEqual(sanitizeSharedPrefs("nope"), {})
})

test("mergeSharedPrefs starts from full defaults and applies layers left-to-right", () => {
  assert.deepEqual(mergeSharedPrefs(), SHARED_PREFS_DEFAULTS)
  const merged = mergeSharedPrefs({ showRemaining: true, warnThreshold: 70 }, { warnThreshold: 90, langOverride: "ru" })
  assert.deepEqual(merged, {
    ...SHARED_PREFS_DEFAULTS,
    showRemaining: true,
    warnThreshold: 90,
    langOverride: "ru",
  })
})

test("prefs store gives storage priority over options and always returns full defaults", async () => {
  const storage = memoryStorage({
    [SHARED_PREFS_KEY]: { alerts: false, weekly: false, warnThreshold: 95 },
  })
  const store = createPrefsStore({
    storage,
    options: { alerts: true, weekly: true, monthly: false, showRemaining: true, warnThreshold: 60 },
  })
  const initial = await store.init()
  assert.deepEqual(initial, {
    ...SHARED_PREFS_DEFAULTS,
    alerts: false,
    weekly: false,
    monthly: false,
    showRemaining: true,
    warnThreshold: 95,
  })

  const next = await store.set({ showRemaining: false, autoUpdate: false, langOverride: "en" })
  assert.equal(next.showRemaining, false)
  assert.equal(next.langOverride, "en")
  assert.equal("autoUpdate" in next, false)
  assert.equal(store.get().alerts, false)
  assert.deepEqual(storage.map.get(SHARED_PREFS_KEY), next)
})

test("autoUpdate follows options/storage precedence and persists through setUpdateConfig", async () => {
  const storage = memoryStorage({ autoUpdate: false })
  const emits: Array<{ name: string; data: unknown }> = []
  const credentials = {
    listPrimary: async () => [],
    listFallback: async () => [],
    dropCli: () => {},
  }
  const build = async (options?: Record<string, unknown>) => {
    const service = createLimitsService({
      storage,
      credentials,
      fetchUsage: async () => ({}),
      log: () => {},
      options,
      emit: (name, data) => {
        emits.push({ name, data })
      },
    })
    await service.init()
    return service
  }

  // Plugin options are the explicit configuration and win on startup, as before.
  const first = await build({ autoUpdate: true })
  assert.equal((await first.getPrefs()).autoUpdate, true)
  assert.equal(storage.map.get("autoUpdate"), false)

  await first.setUpdateConfig({ autoUpdate: false })
  assert.equal((await first.getPrefs()).autoUpdate, false)
  assert.equal(storage.map.get("autoUpdate"), false)
  const event = emits.find((entry) => entry.name === "prefsChanged")
  assert.ok(event)
  assert.ok(event.data && typeof event.data === "object" && "autoUpdate" in event.data)
  assert.equal(event.data.autoUpdate, false)
  await first.dispose()

  // Without the option the persisted value is restored.
  const second = await build()
  assert.equal((await second.getPrefs()).autoUpdate, false)
  await second.setUpdateConfig({ autoUpdate: true })
  assert.equal(storage.map.get("autoUpdate"), true)
  assert.equal((await second.getPrefs()).autoUpdate, true)

  const third = await build()
  assert.equal((await third.getPrefs()).autoUpdate, true)
  await third.dispose()
  await second.dispose()
})
