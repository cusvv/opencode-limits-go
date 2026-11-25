import { test } from "node:test"
import assert from "node:assert/strict"
import { HttpError } from "./api.ts"
import type { Identity } from "./auth.ts"
import {
  createLimitsService,
  type LimitsCredentials,
  type LimitsServiceDeps,
  type LimitsUpdater,
  type Scheduler,
} from "./service/service.ts"
import type { UpdateStatus } from "./updater.ts"

const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000

function memoryStorage(initial: Record<string, unknown> = {}, withRemove = true) {
  const map = new Map<string, unknown>(Object.entries(initial))
  const storage = {
    map,
    get: async (key: string) => map.get(key),
    set: async (key: string, value: unknown) => {
      map.set(key, value)
    },
    ...(withRemove
      ? {
          remove: async (key: string) => {
            map.delete(key)
          },
        }
      : {}),
  }
  return storage
}

function clock(start = 1_700_000_000_000) {
  let at = start
  return {
    now: () => at,
    advance(ms: number) {
      at += ms
    },
  }
}

type Job = { fn: () => void; ms: number; cancelled: boolean }

function fakeScheduler() {
  const jobs: Job[] = []
  const schedule: Scheduler = (fn, ms) => {
    const job: Job = { fn, ms, cancelled: false }
    jobs.push(job)
    return {
      cancel() {
        job.cancelled = true
      },
    }
  }
  return {
    jobs,
    schedule,
    run(ms?: number) {
      for (const job of jobs) {
        if (job.cancelled) continue
        if (ms !== undefined && job.ms !== ms) continue
        job.cancelled = true
        job.fn()
      }
    },
  }
}

function usagePayload(percent: number) {
  return {
    usage: {
      rolling: { percent, resetInSec: 3_600 },
      weekly: { percent: Math.min(100, percent + 5), resetInSec: 86_400 },
      monthly: { percent: Math.min(100, percent + 10), resetInSec: 30 * 86_400 },
    },
  }
}

function identity(access: string, org = "Acme", email = "a@b.c"): Identity {
  return { access, org, email, source: "env" }
}

type FakeCreds = LimitsCredentials & {
  dropCount(): number
  primaryCalls(): number
  fallbackCalls(): number
}

function fakeCredentials(list: () => Identity[]): FakeCreds {
  let drops = 0
  let primary = 0
  let fallback = 0
  return {
    listPrimary: async () => {
      primary += 1
      return list()
    },
    listFallback: async () => {
      fallback += 1
      return []
    },
    dropCli: () => {
      drops += 1
    },
    dropCount: () => drops,
    primaryCalls: () => primary,
    fallbackCalls: () => fallback,
  }
}

const UPDATE_STATUS: UpdateStatus = {
  currentVersion: "1.7.1",
  latestVersion: "1.7.1",
  updateAvailable: false,
  autoUpdated: false,
  restartRequired: false,
  managedByPackageManager: false,
  managedByDev: true,
  releaseUrl: "",
  checkedAtMs: 0,
  error: "",
}

function fakeUpdater(status: UpdateStatus = UPDATE_STATUS): LimitsUpdater {
  return {
    check: async () => status,
    install: async () => ({ ok: true, version: status.currentVersion, restartRequired: false, error: "" }),
    currentVersion: async () => status.currentVersion,
  }
}

type BuildOptions = {
  storage: ReturnType<typeof memoryStorage>
  credentials: LimitsCredentials
  fetchUsage: LimitsServiceDeps["fetchUsage"]
  now?: () => number
  schedule?: Scheduler
  options?: Record<string, unknown>
  updater?: LimitsUpdater
  emits?: Array<{ name: string; data: unknown }>
}

async function buildService(options: BuildOptions) {
  const emits = options.emits ?? []
  const service = createLimitsService({
    storage: options.storage,
    credentials: options.credentials,
    fetchUsage: options.fetchUsage,
    log: () => {},
    now: options.now,
    schedule: options.schedule,
    options: options.options,
    updater: options.updater,
    emit: (name, data) => {
      emits.push({ name, data })
    },
  })
  await service.init()
  return { service, emits }
}

function historyEnvelope(raw: unknown): { account: string; snapshots: Array<{ at: number }> } {
  assert.ok(raw && typeof raw === "object")
  assert.ok("account" in raw && typeof raw.account === "string")
  assert.ok("snapshots" in raw)
  const snapshots: unknown = raw.snapshots
  assert.ok(Array.isArray(snapshots))
  return { account: raw.account, snapshots }
}

function eventReason(data: unknown): unknown {
  return data && typeof data === "object" && "reason" in data ? data.reason : undefined
}

test("status caches for TTL, honors force and maxAgeMs, and exposes accountId/revision", async () => {
  const t = clock()
  const storage = memoryStorage()
  const credentials = fakeCredentials(() => [identity("tok-a")])
  let calls = 0
  const { service } = await buildService({
    storage,
    credentials,
    now: t.now,
    fetchUsage: async () => {
      calls += 1
      return usagePayload(10)
    },
  })

  const first = await service.status({ lang: "en" })
  assert.equal(first.ok, true)
  assert.equal(calls, 1)
  assert.equal(first.checkedAtMs, t.now())
  assert.equal(first.revision, 0)
  assert.equal(typeof first.accountId, "string")
  assert.ok(first.accountId)

  const cached = await service.status({ lang: "en" })
  assert.equal(cached.ok, true)
  assert.equal(calls, 1)
  assert.equal(cached.accountId, first.accountId)

  const forced = await service.status({ force: true, lang: "en" })
  assert.equal(forced.ok, true)
  assert.equal(calls, 2)

  t.advance(50_000)
  const stillFresh = await service.status({ lang: "en" })
  assert.equal(stillFresh.ok, true)
  assert.equal(calls, 2)

  await service.status({ lang: "en", maxAgeMs: 10_000 })
  assert.equal(calls, 3)

  t.advance(20_000)
  await service.status({ lang: "en" })
  assert.equal(calls, 3)

  const sameAccount = await buildService({
    storage,
    credentials,
    now: t.now,
    fetchUsage: async () => usagePayload(11),
  })
  const second = await sameAccount.service.status({ force: true, lang: "en" })
  assert.equal(second.accountId, first.accountId)
  await sameAccount.service.dispose()
  await service.dispose()
})

test("status ignores lang and returns language-neutral rows", async () => {
  const t = clock()
  let calls = 0
  const { service } = await buildService({
    storage: memoryStorage(),
    credentials: fakeCredentials(() => [identity("tok-a")]),
    now: t.now,
    fetchUsage: async () => {
      calls += 1
      return usagePayload(10)
    },
  })

  const en = await service.status({ force: true, lang: "en" })
  const ru = await service.status({ force: true, lang: "ru" })
  const bare = await service.status({ force: true })
  assert.equal(calls, 3)
  assert.equal(en.ok, true)
  assert.deepEqual(ru.rows, en.rows)
  assert.deepEqual(bare.rows, en.rows)
  assert.equal(en.tight, "")
  assert.equal(ru.tight, "")
  assert.deepEqual(en.rows.map((row) => row.label), ["5h", "1w", "1m"])
  assert.ok(en.rows.every((row) => row.resetsIn === ""))
  assert.ok(en.rows.every((row) => /^\d{2}\.\d{2} \d{2}:\d{2}$/.test(row.resetsAt)))
  await service.dispose()
})

test("error cards expose the machine code regardless of lang", async () => {
  const t = clock()
  const { service } = await buildService({
    storage: memoryStorage(),
    credentials: fakeCredentials(() => [identity("tok-a")]),
    now: t.now,
    fetchUsage: async () => {
      throw new HttpError(401, "bad token")
    },
  })

  const en = await service.status({ force: true, lang: "en" })
  const ru = await service.status({ force: true, lang: "ru" })
  for (const card of [en, ru]) {
    assert.equal(card.ok, false)
    assert.equal(card.error, "AUTH")
    assert.equal(card.errorCode, "AUTH")
    assert.equal(card.tight, "")
  }
  assert.equal(ru.errorDetail, en.errorDetail)
  await service.dispose()
})

test("negative cache honors NEGATIVE_TTL and classifies auth errors", async () => {
  const t = clock()
  const storage = memoryStorage()
  let calls = 0
  const { service } = await buildService({
    storage,
    credentials: fakeCredentials(() => [identity("tok-a")]),
    now: t.now,
    fetchUsage: async () => {
      calls += 1
      throw new HttpError(401, "bad token")
    },
  })

  const first = await service.status({ lang: "en" })
  assert.equal(first.ok, false)
  assert.equal(first.errorCode, "AUTH")
  assert.equal(first.checkedAtMs, t.now())
  assert.equal(first.stale, false)
  assert.equal(first.revision, 0)
  assert.equal(typeof first.accountId, "string")
  assert.equal(first.error, "AUTH")
  assert.equal(first.tight, "")

  t.advance(24_000)
  const cached = await service.status({ lang: "en" })
  assert.equal(cached.ok, false)
  assert.equal(cached.errorCode, "AUTH")
  assert.equal(calls, 1)

  t.advance(2_000)
  await service.status({ lang: "en" })
  assert.equal(calls, 2)
  await service.dispose()
})

test("Retry-After extends the negative TTL and is clamped to 24h", async () => {
  const t = clock()
  const storage = memoryStorage()
  let calls = 0
  const { service } = await buildService({
    storage,
    credentials: fakeCredentials(() => [identity("tok-a")]),
    now: t.now,
    fetchUsage: async () => {
      calls += 1
      throw new HttpError(429, "slow down", MAX_RETRY_AFTER_MS * 2)
    },
  })

  const first = await service.status({ lang: "en" })
  assert.equal(first.errorCode, "RATE_LIMIT")

  t.advance(MAX_RETRY_AFTER_MS - 1_000)
  await service.status({ lang: "en" })
  assert.equal(calls, 1)

  t.advance(2_000)
  await service.status({ lang: "en" })
  assert.equal(calls, 2)
  await service.dispose()
})

test("concurrent status calls share one in-flight load", async () => {
  const storage = memoryStorage()
  let calls = 0
  let release: (value: unknown) => void = () => {}
  const gate = new Promise<unknown>((resolve) => {
    release = resolve
  })
  const { service } = await buildService({
    storage,
    credentials: fakeCredentials(() => [identity("tok-a")]),
    fetchUsage: () => {
      calls += 1
      return gate
    },
  })

  const first = service.status({ force: true, lang: "en" })
  const second = service.status({ force: true, lang: "en" })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  release(usagePayload(10))
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(a.accountId, b.accountId)
  await service.dispose()
})

test("credential epoch change retries the load and never returns the old account", async () => {
  const storage = memoryStorage()
  let current = [identity("tok-a", "Old Account")]
  let started: () => void = () => {}
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve
  })
  let releaseOld: (value: unknown) => void = () => {}
  const oldGate = new Promise<unknown>((resolve) => {
    releaseOld = resolve
  })
  const accesses: string[] = []
  const { service } = await buildService({
    storage,
    credentials: fakeCredentials(() => current),
    fetchUsage: (access) => {
      accesses.push(access)
      if (access === "tok-a") {
        started()
        return oldGate
      }
      return Promise.resolve(usagePayload(42))
    },
  })

  const pending = service.status({ force: true, lang: "en" })
  await startedPromise

  current = [identity("tok-b", "New Account")]
  await service.handleEvent({ type: "credential.updated" })
  releaseOld(usagePayload(99))

  const card = await pending
  assert.equal(card.ok, true)
  assert.equal(card.org, "New Account")
  assert.equal(card.rows[0].used, 42)
  assert.equal(card.revision, 1)
  assert.equal(accesses.length, 2)
  assert.equal(accesses[0], "tok-a")
  assert.equal(accesses[1], "tok-b")
  await service.dispose()
})

test("credential invalidation clears persisted lastGood and history", async () => {
  const t = clock()
  const storage = memoryStorage()
  const { service } = await buildService({
    storage,
    credentials: fakeCredentials(() => [identity("tok-a")]),
    now: t.now,
    fetchUsage: async () => usagePayload(10),
  })

  await service.status({ force: true, lang: "en" })
  const saved = await storage.get("lastGood:v1")
  assert.ok(saved && typeof saved === "object" && "ok" in saved)
  assert.equal(saved.ok, true)
  const envelope = historyEnvelope(await storage.get("history:v2"))
  assert.ok(envelope.account)

  await service.handleEvent({ type: "credential.updated" })
  assert.equal(await storage.get("lastGood:v1"), undefined)
  assert.equal(await storage.get("history:v2"), undefined)
  await service.dispose()
})

test("credential invalidation writes sentinels when storage has no delete", async () => {
  const t = clock()
  const storage = memoryStorage({}, false)
  const { service } = await buildService({
    storage,
    credentials: fakeCredentials(() => [identity("tok-a")]),
    now: t.now,
    fetchUsage: async () => usagePayload(10),
  })

  await service.status({ force: true, lang: "en" })
  await service.handleEvent({ type: "credential.updated" })

  const lastGood = await storage.get("lastGood:v1")
  assert.ok(lastGood && typeof lastGood === "object" && "ok" in lastGood)
  assert.equal(lastGood.ok, false)
  const envelope = historyEnvelope(await storage.get("history:v2"))
  assert.equal(envelope.account, "")
  assert.equal(envelope.snapshots.length, 0)

  const restarted = await buildService({
    storage,
    credentials: fakeCredentials(() => []),
    now: t.now,
    fetchUsage: async () => usagePayload(10),
  })
  const diagnostics = await restarted.service.diagnostics()
  assert.equal(diagnostics.cache.ok, false)
  assert.equal(diagnostics.history.count, 0)
  await restarted.service.dispose()
  await service.dispose()
})

test("account change resets history instead of appending", async () => {
  const t = clock()
  const storage = memoryStorage()
  let current = [identity("tok-a")]
  const { service } = await buildService({
    storage,
    credentials: fakeCredentials(() => current),
    now: t.now,
    fetchUsage: async () => usagePayload(10),
  })

  await service.status({ force: true, lang: "en" })
  const first = historyEnvelope(await storage.get("history:v2"))
  assert.equal(first.snapshots.length, 1)
  assert.ok(first.account)

  current = [identity("tok-b")]
  t.advance(10_000)
  await service.status({ force: true, lang: "en" })

  const second = historyEnvelope(await storage.get("history:v2"))
  assert.notEqual(second.account, first.account)
  assert.equal(second.snapshots.length, 1)
  const diagnostics = await service.diagnostics()
  assert.equal(diagnostics.history.accountId, second.account)
  await service.dispose()
})

test("usage events debounce and cool down, and the reset timer invalidates the cache", async () => {
  const t = clock()
  const scheduler = fakeScheduler()
  let calls = 0
  const { service, emits } = await buildService({
    storage: memoryStorage(),
    credentials: fakeCredentials(() => [identity("tok-a")]),
    now: t.now,
    schedule: scheduler.schedule,
    fetchUsage: async () => {
      calls += 1
      return usagePayload(10)
    },
  })
  const changes = () => emits.filter((entry) => entry.name === "changed")

  await service.status({ force: true, lang: "en" })
  assert.equal(calls, 1)
  t.advance(13_000)

  await service.handleEvent({ type: "session.usage.updated" })
  await service.handleEvent({ type: "session.idle" })
  scheduler.run(1_500)
  assert.equal(changes().length, 1)
  assert.equal(eventReason(changes()[0].data), "usage")

  t.advance(1_000)
  await service.handleEvent({ type: "session.usage.updated" })
  scheduler.run(1_500)
  assert.equal(changes().length, 1)

  const resetJob = scheduler.jobs.find((job) => !job.cancelled && job.ms > 2_000)
  assert.ok(resetJob)
  resetJob.cancelled = true
  resetJob.fn()
  assert.equal(changes().length, 2)
  assert.equal(eventReason(changes()[1].data), "reset")

  await service.status({ force: true, lang: "en" })
  assert.equal(calls, 2)
  await service.dispose()
})

test("prefs merge defaults with storage above options; setPrefs cannot change autoUpdate", async () => {
  const storage = memoryStorage({
    "sharedPrefs:v1": { rolling: false, warnThreshold: 90, langOverride: "ru" },
  })
  const emits: Array<{ name: string; data: unknown }> = []
  const { service } = await buildService({
    storage,
    credentials: fakeCredentials(() => []),
    fetchUsage: async () => usagePayload(10),
    options: { showRemaining: true, warnThreshold: 70, alerts: false, autoUpdate: false },
    emits,
  })

  const prefs = await service.getPrefs()
  assert.deepEqual(prefs, {
    rolling: false,
    weekly: true,
    monthly: true,
    showRemaining: true,
    alerts: false,
    systemNotifications: false,
    warnThreshold: 90,
    burnSpikePct: 20,
    langOverride: "ru",
    autoUpdate: false,
  })

  await service.setPrefs({ showRemaining: false, autoUpdate: true, bogus: 1 })
  const after = await service.getPrefs()
  assert.equal(after.showRemaining, false)
  assert.equal(after.autoUpdate, false)
  const event = emits.find((entry) => entry.name === "prefsChanged")
  assert.ok(event)
  assert.deepEqual(event.data, {
    prefs: {
      rolling: false,
      weekly: true,
      monthly: true,
      showRemaining: false,
      alerts: false,
      systemNotifications: false,
      warnThreshold: 90,
      burnSpikePct: 20,
      langOverride: "ru",
    },
    autoUpdate: false,
  })
  await service.dispose()
})

test("diagnostics reports cache, history, prefs, updater, and no credential material", async () => {
  const t = clock()
  const storage = memoryStorage()
  const { service } = await buildService({
    storage,
    credentials: fakeCredentials(() => [identity("tok-a")]),
    now: t.now,
    fetchUsage: async () => usagePayload(10),
    updater: fakeUpdater(),
  })

  const card = await service.status({ force: true, lang: "en" })
  t.advance(5_000)
  const diagnostics = await service.diagnostics()

  assert.equal(diagnostics.version, "1.7.1")
  assert.equal(diagnostics.cache.ok, true)
  assert.equal(diagnostics.cache.ageMs, 5_000)
  assert.equal(diagnostics.cache.source, "env")
  assert.equal(diagnostics.cache.accountId, card.accountId)
  assert.equal(diagnostics.cache.revision, 0)
  assert.equal(diagnostics.history.count, 1)
  assert.equal(diagnostics.history.accountId, card.accountId)
  assert.ok(diagnostics.prefs.keys.includes("autoUpdate"))
  assert.equal(diagnostics.updater.currentVersion, "1.7.1")
  assert.equal(diagnostics.updater.managedByDev, true)
  assert.equal(diagnostics.updater.error, "")
  assert.equal(typeof diagnostics.resetInMs, "number")
  assert.equal(JSON.stringify(diagnostics).includes("tok-a"), false)
  await service.dispose()
})
