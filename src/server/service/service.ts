import {
  CodedError,
  type LimitCard,
  type LimitRow,
  errorText,
  nextResetDelayMs,
  parseUsage,
  recordUsageSnapshot,
} from "../../core/index.ts"
import type { SharedPrefs } from "../../settings/index.ts"
import { HttpError } from "../api.ts"
import type { Identity } from "../auth.ts"
import type { InstallResult, UpdateStatus } from "../updater.ts"
import {
  MAX_RETRY_AFTER_MS,
  NEGATIVE_TTL,
  TTL,
  createCache,
  createLastGoodStore,
  type CachedFailure,
  type CachedRaw,
  type CachedSuccess,
} from "./cache.ts"
import { classifyEvent } from "./events.ts"
import { createAccountIdentity, createHistoryStore } from "./history.ts"
import { createPrefsStore } from "./prefs.ts"
import { failureForError, formatCached } from "./status.ts"
import { readStorage, writeStorage, type StorageLike } from "./storage.ts"

const DEADLINE = 25_000
const HTTP_TIMEOUT = 10_000
const INITIAL_UPDATE_DELAY_MS = 15_000
const UPDATE_INTERVAL_MS = 6 * 60 * 60_000
const USAGE_EVENT_COOLDOWN_MS = 12_000
const USAGE_EVENT_DEBOUNCE_MS = 1_500
const AUTO_UPDATE_KEY = "autoUpdate"

export type SchedulerHandle = { cancel(): void }
export type Scheduler = (fn: () => void, ms: number) => SchedulerHandle

export type LimitsServiceEmit = (
  name: "changed" | "updated" | "prefsChanged",
  data: unknown,
) => void | Promise<void>

export type LimitsCredentials = {
  listPrimary(): Promise<Identity[]>
  listFallback(opts?: { freshCli?: boolean }): Promise<Identity[]>
  dropCli(): void
}

export type LimitsUpdater = {
  check(input: { force?: boolean; autoInstall?: boolean; signal?: AbortSignal }): Promise<UpdateStatus>
  install(options?: { signal?: AbortSignal }): Promise<InstallResult>
  currentVersion(): Promise<string>
}

export type LimitsServiceDeps = {
  storage: StorageLike
  credentials: LimitsCredentials
  fetchUsage: (access: string, timeoutMs?: number, signal?: AbortSignal) => Promise<unknown>
  log: (message: string, data?: Record<string, unknown>) => void
  now?: () => number
  schedule?: Scheduler
  emit?: LimitsServiceEmit
  options?: Record<string, unknown>
  updater?: LimitsUpdater
}

export type PrefsView = SharedPrefs & { autoUpdate: boolean }

export type Diagnostics = {
  version: string
  cache: { ok: boolean; ageMs: number; source: string; accountId?: string; revision?: number }
  history: { count: number; accountId?: string }
  prefs: { keys: string[] }
  updater: {
    currentVersion: string
    latestVersion: string
    updateAvailable: boolean
    managedByDev: boolean
    managedByPackageManager: boolean
    error: string
  }
  resetInMs?: number
}

export type LimitsService = {
  readonly signal: AbortSignal
  init(): Promise<void>
  status(input: unknown, options?: { signal?: AbortSignal }): Promise<LimitCard>
  getPrefs(): Promise<PrefsView>
  setPrefs(input: unknown): Promise<PrefsView>
  updateStatus(input: unknown): Promise<UpdateStatus>
  installUpdate(): Promise<InstallResult>
  setUpdateConfig(input: unknown): Promise<{ autoUpdate: boolean }>
  diagnostics(): Promise<Diagnostics>
  handleEvent(ev: unknown): Promise<void>
  subscribe(source: AsyncIterable<unknown>): () => void
  dispose(): Promise<void>
}

const defaultSchedule: Scheduler = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("credential lookup timed out")), Math.max(200, ms))
  })
  timer.unref?.()
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function isTokenError(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404
  }
  if (error instanceof CodedError) {
    return error.code === "EMPTY_USAGE" || error.code === "INVALID_PERCENT" || error.code === "INVALID_JSON"
  }
  return false
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {}
}

function emptyUpdateStatus(now: number, error: string): UpdateStatus {
  return {
    currentVersion: "0.0.0",
    latestVersion: "",
    updateAvailable: false,
    autoUpdated: false,
    restartRequired: false,
    managedByPackageManager: false,
    managedByDev: false,
    releaseUrl: "",
    checkedAtMs: now,
    error,
  }
}

export function createLimitsService(deps: LimitsServiceDeps): LimitsService {
  const now = deps.now ?? Date.now
  const schedule = deps.schedule ?? defaultSchedule
  const storage = deps.storage
  const lifetime = new AbortController()

  const cache = createCache({ now })
  const prefs = createPrefsStore({ storage, options: deps.options })
  const history = createHistoryStore({ storage })
  const lastGood = createLastGoodStore({ storage })
  const identity = createAccountIdentity({ storage })

  let epoch = 0
  let lastAccountId: string | undefined
  let diskCache: CachedSuccess | null = null
  let autoUpdate = true
  let lastUpdateStatus: UpdateStatus | null = null
  let disposed = false
  let initPromise: Promise<void> | null = null

  let resetTimer: SchedulerHandle | null = null
  let usageTimer: SchedulerHandle | null = null
  let startupTimer: SchedulerHandle | null = null
  let periodicTimer: SchedulerHandle | null = null
  let lastUsageEmitAt = 0

  function cancelTimer(timer: SchedulerHandle | null): null {
    timer?.cancel()
    return null
  }

  function emit(name: "changed" | "updated" | "prefsChanged", data: unknown): void {
    if (!deps.emit) return
    try {
      void Promise.resolve(deps.emit(name, data)).catch(() => {})
    } catch {}
  }

  function emitPrefsChanged(): void {
    emit("prefsChanged", { prefs: prefs.get(), autoUpdate })
  }

  function startUpdateTimers(): void {
    const updater = deps.updater
    if (!updater || disposed) return
    startupTimer = schedule(() => {
      startupTimer = null
      if (disposed || !autoUpdate) return
      void updater.check({ force: false, autoInstall: true, signal: lifetime.signal }).catch(() => {})
    }, INITIAL_UPDATE_DELAY_MS)

    const tick = () => {
      periodicTimer = null
      if (disposed) return
      if (autoUpdate) void updater.check({ force: true, autoInstall: true, signal: lifetime.signal }).catch(() => {})
      periodicTimer = schedule(tick, UPDATE_INTERVAL_MS)
    }
    periodicTimer = schedule(tick, UPDATE_INTERVAL_MS)
  }

  function init(): Promise<void> {
    if (initPromise) return initPromise
    initPromise = (async () => {
      await prefs.init()
      const savedAuto = await readStorage(storage, AUTO_UPDATE_KEY)
      autoUpdate =
        typeof deps.options?.autoUpdate === "boolean"
          ? deps.options.autoUpdate
          : typeof savedAuto === "boolean"
            ? savedAuto
            : true
      diskCache = await lastGood.load()
      const savedHistory = await history.load()
      if (diskCache?.accountId && savedHistory.account && savedHistory.account !== diskCache.accountId) {
        await history.clear()
      }
      lastAccountId = diskCache?.accountId
      cache.begin(epoch)
      startUpdateTimers()
    })()
    return initPromise
  }

  function scheduleResetTimer(rows: readonly LimitRow[]): void {
    resetTimer = cancelTimer(resetTimer)
    if (disposed) return
    const delay = nextResetDelayMs(rows, now())
    if (delay === null) return
    resetTimer = schedule(() => {
      resetTimer = null
      if (disposed) return
      cache.invalidate()
      emit("changed", { reason: "reset", accountId: lastAccountId, revision: epoch })
    }, delay)
  }

  function applyResult(next: CachedRaw): void {
    if (!next.ok) return
    diskCache = next
    lastAccountId = next.accountId
    void lastGood.save(next)
    scheduleResetTimer(next.rows)
    const previous = history.get()
    const account = next.accountId || previous.account
    const base = previous.account && next.accountId && previous.account !== next.accountId ? [] : previous.snapshots
    const snapshots = recordUsageSnapshot(base, next.rows, next.checkedAtMs)
    const prevLast = previous.snapshots.at(-1)
    const nextLast = snapshots.at(-1)
    const changed =
      account !== previous.account ||
      snapshots.length !== previous.snapshots.length ||
      prevLast?.at !== nextLast?.at
    if (changed) void history.save(account, snapshots)
  }

  async function loadRaw(): Promise<CachedRaw> {
    const deadline = now() + DEADLINE
    const tried = new Set<string>()
    let foundAny = false
    let lastError: unknown = null
    let fatal = false
    let sawStaleCli = false
    let lastAttemptedAccess: string | undefined

    async function failureAccountId(): Promise<string | undefined> {
      if (!lastAttemptedAccess) return undefined
      const fingerprint = await identity.accountId(lastAttemptedAccess).catch(() => "")
      return fingerprint || undefined
    }

    async function tryList(candidates: Identity[]): Promise<CachedRaw | null> {
      for (const id of candidates) {
        if (tried.has(id.access)) continue
        tried.add(id.access)
        foundAny = true
        const remaining = deadline - now()
        if (remaining <= 200 || disposed) break
        lastAttemptedAccess = id.access
        try {
          const loadedAt = now()
          const rows = parseUsage(
            await deps.fetchUsage(id.access, Math.min(HTTP_TIMEOUT, remaining), lifetime.signal),
            loadedAt,
          )
          const accountId = await identity.accountId(id.access).catch(() => "")
          return {
            ok: true,
            org: id.org ?? "OpenCode Go",
            email: id.email ?? "",
            checkedAt: new Date(loadedAt).toTimeString().slice(0, 8),
            checkedAtMs: loadedAt,
            source: id.source,
            rows,
            at: now(),
            ttl: TTL,
            ...(accountId ? { accountId } : {}),
          }
        } catch (error) {
          lastError = error
          const status = error instanceof HttpError ? error.status : undefined
          deps.log("candidate failed", { source: id.source, status, error: errorText(error) })
          if (id.source === "cli" && (status === 401 || status === 403)) {
            deps.credentials.dropCli()
            if (id.cached) sawStaleCli = true
          }
          // 429/5xx may be token-specific: try the next credential instead of stopping discovery.
          const retryableHttp = error instanceof HttpError && error.retryable
          if (!isTokenError(error) && !retryableHttp) {
            fatal = true
            break
          }
        }
      }
      return null
    }

    const primaryList = await withDeadline(deps.credentials.listPrimary(), deadline - now()).catch((error) => {
      lastError = error
      fatal = true
      return [] as Identity[]
    })
    const primary = await tryList(primaryList)
    if (primary) return primary

    if (!fatal && !disposed && now() < deadline - 200) {
      const fallbackList = await withDeadline(deps.credentials.listFallback(), deadline - now()).catch((error) => {
        lastError = error
        return [] as Identity[]
      })
      const fallback = await tryList(fallbackList)
      if (fallback) return fallback
    }

    if (!fatal && sawStaleCli && !disposed && now() < deadline - 500) {
      const refreshedList = await withDeadline(
        deps.credentials.listFallback({ freshCli: true }),
        deadline - now(),
      ).catch(() => [] as Identity[])
      const refreshed = await tryList(refreshedList)
      if (refreshed) return refreshed
    }

    if (!foundAny) {
      const accountId = await failureAccountId()
      if (lastError && fatal) return failureForError(lastError, now(), NEGATIVE_TTL, accountId)
      return { ok: false, errorCode: "NO_TOKEN", cardCode: "NO_TOKEN", at: now(), ttl: NEGATIVE_TTL }
    }
    const retryAfterMs = lastError instanceof HttpError && lastError.retryAfterMs ? lastError.retryAfterMs : 0
    const negTtl =
      retryAfterMs > 0 ? Math.min(Math.max(retryAfterMs, NEGATIVE_TTL), MAX_RETRY_AFTER_MS) : NEGATIVE_TTL
    return failureForError(
      lastError ?? new Error("no credentials available"),
      now(),
      negTtl,
      await failureAccountId(),
    )
  }

  function refresh(epochToRun: number): Promise<CachedRaw> {
    return cache.load(epochToRun, async () => {
      const next = await loadRaw()
      if (epochToRun === epoch && !disposed) applyResult(next)
      return next
    })
  }

  async function loadForCurrentEpoch(): Promise<CachedRaw | null> {
    // A credential change mid-flight makes the response belong to the old account: retry twice at most.
    for (let attempt = 0; attempt < 3; attempt++) {
      const loadedEpoch = epoch
      const result = await refresh(loadedEpoch)
      if (epoch === loadedEpoch) return result
    }
    return null
  }

  function cardFor(entry: CachedRaw, stale = false): LimitCard {
    const accountId = entry.ok ? entry.accountId ?? lastAccountId : lastAccountId
    return formatCached(entry, {
      history: history.get().snapshots,
      now: now(),
      stale,
      accountId,
      revision: epoch,
    })
  }

  async function status(input: unknown, options: { signal?: AbortSignal } = {}): Promise<LimitCard> {
    await init()
    const parsed = inputRecord(input)
    const force = parsed.force === true
    // `lang` is accepted for older clients but ignored: the card contract is language-neutral.
    const requestedMaxAge =
      typeof parsed.maxAgeMs === "number" && Number.isFinite(parsed.maxAgeMs)
        ? Math.max(10_000, Math.min(parsed.maxAgeMs, TTL))
        : undefined

    if (options.signal?.aborted) {
      const abortedHit = cache.peek()
      if (abortedHit) return cardFor(abortedHit)
    }

    const hit = force ? null : cache.peek(requestedMaxAge)
    if (hit) return cardFor(hit)

    // Instant cold start: return last persisted good card while refreshing in background.
    if (!force && !cache.get() && diskCache) {
      const stale = diskCache
      void refresh(epoch)
        .then((next) => {
          if (next.ok && !disposed) emit("changed", {})
        })
        .catch(() => {})
      return cardFor(stale, true)
    }

    const raw = await loadForCurrentEpoch()
    if (!raw) {
      const changed: CachedFailure = {
        ok: false,
        errorCode: "FETCH_FAILED",
        cardCode: "CREDENTIALS_CHANGED",
        errorDetail: "credentials changed",
        at: now(),
        ttl: NEGATIVE_TTL,
      }
      cache.complete(epoch, changed)
      return cardFor(changed)
    }
    return cardFor(raw)
  }

  async function getPrefs(): Promise<PrefsView> {
    await init()
    return { ...prefs.get(), autoUpdate }
  }

  async function setPrefs(input: unknown): Promise<PrefsView> {
    await init()
    const before = JSON.stringify(prefs.get())
    const next = await prefs.set(input)
    if (JSON.stringify(next) !== before) emitPrefsChanged()
    return { ...next, autoUpdate }
  }

  async function updateStatus(input: unknown): Promise<UpdateStatus> {
    await init()
    const parsed = inputRecord(input)
    if (!deps.updater) return emptyUpdateStatus(now(), "updater unavailable")
    const result = await deps.updater.check({
      force: parsed.check === true,
      autoInstall: typeof parsed.autoInstall === "boolean" ? parsed.autoInstall : autoUpdate,
      signal: lifetime.signal,
    })
    lastUpdateStatus = result
    return result
  }

  async function installUpdate(): Promise<InstallResult> {
    await init()
    if (!deps.updater) return { ok: false, version: "", restartRequired: false, error: "updater unavailable" }
    const result = await deps.updater.install({ signal: lifetime.signal })
    if (result.ok) lastUpdateStatus = null
    return result
  }

  async function setUpdateConfig(input: unknown): Promise<{ autoUpdate: boolean }> {
    await init()
    const next = inputRecord(input).autoUpdate
    if (typeof next === "boolean") {
      const changed = autoUpdate !== next
      autoUpdate = next
      await writeStorage(storage, AUTO_UPDATE_KEY, next)
      if (changed) emitPrefsChanged()
    }
    return { autoUpdate }
  }

  async function updateSnapshot(): Promise<UpdateStatus> {
    if (!deps.updater) return emptyUpdateStatus(now(), "updater unavailable")
    if (lastUpdateStatus) return lastUpdateStatus
    try {
      const result = await deps.updater.check({ force: false, autoInstall: false, signal: lifetime.signal })
      lastUpdateStatus = result
      return result
    } catch (error) {
      const currentVersion = await deps.updater.currentVersion().catch(() => "0.0.0")
      return { ...emptyUpdateStatus(now(), errorText(error)), currentVersion }
    }
  }

  async function diagnostics(): Promise<Diagnostics> {
    await init()
    const updater = await updateSnapshot()
    const cached = cache.get() ?? diskCache
    const accountId = cached?.accountId ?? lastAccountId
    const state = history.get()
    const prefsView = await getPrefs()
    const resetInMs = cached?.ok ? nextResetDelayMs(cached.rows, now()) ?? undefined : undefined
    return {
      version: updater.currentVersion,
      cache: {
        ok: cached?.ok === true,
        ageMs: cached ? Math.max(0, now() - cached.at) : 0,
        source: cached?.ok ? cached.source : "",
        ...(accountId ? { accountId } : {}),
        revision: epoch,
      },
      history: {
        count: state.snapshots.length,
        ...(state.account ? { accountId: state.account } : {}),
      },
      prefs: { keys: Object.keys(prefsView).sort() },
      updater: {
        currentVersion: updater.currentVersion,
        latestVersion: updater.latestVersion,
        updateAvailable: updater.updateAvailable,
        managedByDev: updater.managedByDev,
        managedByPackageManager: updater.managedByPackageManager,
        error: updater.error,
      },
      ...(resetInMs !== undefined ? { resetInMs } : {}),
    }
  }

  async function invalidateCredentials(): Promise<void> {
    if (disposed) return
    epoch += 1
    cache.begin(epoch)
    cache.invalidate()
    diskCache = null
    lastAccountId = undefined
    resetTimer = cancelTimer(resetTimer)
    deps.credentials.dropCli()
    await Promise.allSettled([history.clear(), lastGood.clear()])
    emit("changed", { reason: "credentials", revision: epoch })
  }

  function scheduleUsageInvalidation(): void {
    usageTimer = cancelTimer(usageTimer)
    usageTimer = schedule(() => {
      usageTimer = null
      if (disposed) return
      const at = now()
      if (at - lastUsageEmitAt < USAGE_EVENT_COOLDOWN_MS) return
      const current = cache.get()
      if (current && at - current.at < USAGE_EVENT_COOLDOWN_MS) return
      lastUsageEmitAt = at
      cache.invalidate()
      emit("changed", { reason: "usage", accountId: lastAccountId, revision: epoch })
    }, USAGE_EVENT_DEBOUNCE_MS)
  }

  async function handleEvent(ev: unknown): Promise<void> {
    const kind = classifyEvent(ev)
    if (kind === "usage") {
      scheduleUsageInvalidation()
      return
    }
    if (kind === "credentials") await invalidateCredentials()
  }

  function subscribe(source: AsyncIterable<unknown>): () => void {
    if (disposed) return () => {}
    let stopped = false
    void (async () => {
      try {
        for await (const ev of source) {
          if (stopped || disposed) break
          await handleEvent(ev)
        }
      } catch (error) {
        if (!disposed && !stopped) deps.log("event subscription ended", { error: errorText(error) })
      }
    })()
    return () => {
      stopped = true
    }
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    lifetime.abort()
    resetTimer = cancelTimer(resetTimer)
    usageTimer = cancelTimer(usageTimer)
    startupTimer = cancelTimer(startupTimer)
    periodicTimer = cancelTimer(periodicTimer)
  }

  return {
    signal: lifetime.signal,
    init,
    status,
    getPrefs,
    setPrefs,
    updateStatus,
    installUpdate,
    setUpdateConfig,
    diagnostics,
    handleEvent,
    subscribe,
    dispose,
  }
}
