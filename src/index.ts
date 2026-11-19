import { Plugin } from "@opencode/plugin"
import { Limits } from "./rpc.ts"
import { type Identity, createCredentials } from "./server/auth.ts"
import { HttpError, fetchUsage } from "./server/api.ts"
import { log } from "./server/log.ts"
import {
  CodedError,
  type ErrorCode,
  type LimitCard,
  type LimitRow,
  type Locale,
  type UsageSnapshot,
  accountKey,
  attachHistoryDeltas,
  emptyCard,
  errorText,
  formatError,
  localizeRows,
  nextResetDelayMs,
  normalizeLocale,
  parseUsage,
  recordUsageSnapshot,
  selectSnapshotsForClient,
  tightLine,
} from "./core/index.ts"
import { createUpdater } from "./server/updater.ts"

const TTL = 90_000
const NEGATIVE_TTL = 25_000
const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000
const DEADLINE = 25_000
const HTTP_TIMEOUT = 10_000
const INITIAL_UPDATE_DELAY_MS = 15_000
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
const USAGE_EVENT_COOLDOWN_MS = 12_000
const USAGE_EVENT_DEBOUNCE_MS = 1_500
const HISTORY_KEY = "history:v1"
const LAST_GOOD_KEY = "lastGood:v1"
const SHARED_PREFS_KEY = "sharedPrefs:v1"

type SharedPrefs = {
  rolling?: boolean
  weekly?: boolean
  monthly?: boolean
  showRemaining?: boolean
  warnThreshold?: number
  burnSpikePct?: number
  langOverride?: string
}

type CachedRaw =
  | {
      ok: true
      org: string
      email: string
      checkedAt: string
      checkedAtMs: number
      source: string
      rows: LimitRow[]
      at: number
      ttl: number
    }
  | {
      ok: false
      errorCode: ErrorCode
      errorDetail?: string
      at: number
      ttl: number
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

function isValidRow(raw: unknown): raw is LimitRow {
  if (!raw || typeof raw !== "object") return false
  const row = raw as Record<string, unknown>
  return (
    typeof row.label === "string" &&
    typeof row.used === "number" &&
    Number.isFinite(row.used) &&
    typeof row.status === "string" &&
    typeof row.resetsAt === "string" &&
    typeof row.resetsIn === "string"
  )
}

function sanitizeSnapshots(raw: unknown): UsageSnapshot[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is UsageSnapshot => {
    if (!item || typeof item !== "object") return false
    const snap = item as Record<string, unknown>
    return typeof snap.at === "number" && Number.isFinite(snap.at)
  })
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("credential lookup timed out")), Math.max(200, ms))
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function defaultLocale(): Locale {
  const envLang = process.env.OPENCODE_LANG || process.env.LC_ALL || process.env.LANG
  return normalizeLocale(envLang)
}

function formatCached(entry: CachedRaw, lang: Locale, history: readonly UsageSnapshot[], stale = false): LimitCard {
  if (!entry.ok) {
    return emptyCard(formatError(entry.errorCode, entry.errorDetail, lang))
  }
  const now = Date.now()
  const rows = attachHistoryDeltas(localizeRows(entry.rows, now, lang), history, now)
  return {
    ok: true,
    org: entry.org,
    email: entry.email,
    checkedAt: entry.checkedAt,
    checkedAtMs: entry.checkedAtMs,
    source: entry.source,
    rows,
    tight: tightLine(rows, now, lang),
    error: "",
    stale,
    snapshots: selectSnapshotsForClient(history, now, 72),
  }
}

function sanitizeSharedPrefs(raw: unknown): SharedPrefs {
  if (!raw || typeof raw !== "object") return {}
  const rec = raw as Record<string, unknown>
  const out: SharedPrefs = {}
  if (typeof rec.rolling === "boolean") out.rolling = rec.rolling
  if (typeof rec.weekly === "boolean") out.weekly = rec.weekly
  if (typeof rec.monthly === "boolean") out.monthly = rec.monthly
  if (typeof rec.showRemaining === "boolean") out.showRemaining = rec.showRemaining
  if (typeof rec.warnThreshold === "number" && Number.isFinite(rec.warnThreshold)) out.warnThreshold = rec.warnThreshold
  if (typeof rec.burnSpikePct === "number" && Number.isFinite(rec.burnSpikePct)) out.burnSpikePct = rec.burnSpikePct
  if (rec.langOverride === "auto" || rec.langOverride === "en" || rec.langOverride === "ru") {
    out.langOverride = rec.langOverride
  }
  return out
}

export default Plugin.define({
  id: "opencode-limits-go",
  async setup(ctx) {
    const creds = createCredentials({
      integration: ctx.integration,
      provider: ctx.provider,
      options: ctx.options,
    })
    const stopEvents = new AbortController()
    let cache: CachedRaw | null = null
    let diskCache: (CachedRaw & { ok: true }) | null = null
    let inflight: { epoch: number; promise: Promise<CachedRaw> } | null = null
    let resetTimer: ReturnType<typeof setTimeout> | null = null
    let epoch = 0
    let rpcRef: { events: { emit: (name: "changed" | "updated" | "prefsChanged", data: any) => Promise<void> } } | null =
      null

    const savedDisk = await ctx.storage.get(LAST_GOOD_KEY).catch(() => undefined)
    if (savedDisk && typeof savedDisk === "object" && (savedDisk as { ok?: unknown }).ok === true) {
      const candidate = savedDisk as CachedRaw & { ok: true }
      if (Array.isArray(candidate.rows)) {
        const rows = candidate.rows.filter(isValidRow)
        if (rows.length > 0) diskCache = { ...candidate, rows }
      }
    }

    const savedPrefs = sanitizeSharedPrefs(await ctx.storage.get(SHARED_PREFS_KEY).catch(() => undefined))
    const optPrefs = sanitizeSharedPrefs(ctx.options)
    let sharedPrefs: SharedPrefs = { ...optPrefs, ...savedPrefs }

    function scheduleResetTimer(rows: readonly LimitRow[]) {
      if (resetTimer) {
        clearTimeout(resetTimer)
        resetTimer = null
      }
      if (stopEvents.signal.aborted) return
      const delay = nextResetDelayMs(rows, Date.now())
      if (delay === null) return
      resetTimer = setTimeout(() => {
        resetTimer = null
        if (stopEvents.signal.aborted) return
        cache = null
        void rpcRef?.events.emit("changed", {}).catch(() => {})
      }, delay)
      resetTimer.unref?.()
    }

    const savedHistory = await ctx.storage.get(HISTORY_KEY).catch(() => undefined)
    let historyAccount = ""
    let history: UsageSnapshot[] = []
    if (Array.isArray(savedHistory)) {
      history = sanitizeSnapshots(savedHistory)
    } else if (savedHistory && typeof savedHistory === "object") {
      const rec = savedHistory as { account?: unknown; snapshots?: unknown }
      if (typeof rec.account === "string") historyAccount = rec.account
      history = sanitizeSnapshots(rec.snapshots)
    }

    const savedAuto = await ctx.storage.get("autoUpdate").catch(() => undefined)
    let autoUpdate =
      typeof ctx.options.autoUpdate === "boolean"
        ? ctx.options.autoUpdate
        : typeof savedAuto === "boolean"
          ? savedAuto
          : true

    const updater = createUpdater({
      onInstalled: (version) => {
        void rpcRef?.events.emit("updated", { version }).catch(() => {})
      },
    })

    async function load(): Promise<CachedRaw> {
      const deadline = Date.now() + DEADLINE
      const tried = new Set<string>()
      let foundAny = false
      let lastError: unknown = null
      let fatal = false
      let sawStaleCli = false

      async function tryList(candidates: Identity[]): Promise<CachedRaw | null> {
        for (const id of candidates) {
          if (tried.has(id.access)) continue
          tried.add(id.access)
          foundAny = true
          const remaining = deadline - Date.now()
          if (remaining <= 200 || stopEvents.signal.aborted) break
          try {
            const now = Date.now()
            const rows = parseUsage(
              await fetchUsage(id.access, Math.min(HTTP_TIMEOUT, remaining), stopEvents.signal),
              now,
              "en",
            )
            return {
              ok: true,
              org: id.org ?? "OpenCode Go",
              email: id.email ?? "",
              checkedAt: new Date(now).toTimeString().slice(0, 8),
              checkedAtMs: now,
              source: id.source,
              rows,
              at: Date.now(),
              ttl: TTL,
            }
          } catch (error) {
            lastError = error
            const status = error instanceof HttpError ? error.status : undefined
            log("candidate failed", { source: id.source, status, error: errorText(error, "en") })
            if (id.source === "cli" && (status === 401 || status === 403)) {
              creds.dropCli()
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

      const primaryList = await withDeadline(creds.listPrimary(), deadline - Date.now()).catch((error) => {
        lastError = error
        fatal = true
        return [] as Identity[]
      })
      const primary = await tryList(primaryList)
      if (primary) return primary

      if (!fatal && !stopEvents.signal.aborted && Date.now() < deadline - 200) {
        const fallbackList = await withDeadline(creds.listFallback(), deadline - Date.now()).catch((error) => {
          lastError = error
          return [] as Identity[]
        })
        const fallback = await tryList(fallbackList)
        if (fallback) return fallback
      }

      if (!fatal && sawStaleCli && !stopEvents.signal.aborted && Date.now() < deadline - 500) {
        const refreshedList = await withDeadline(creds.listFallback({ freshCli: true }), deadline - Date.now()).catch(
          () => [] as Identity[],
        )
        const refreshed = await tryList(refreshedList)
        if (refreshed) return refreshed
      }

      if (!foundAny) {
        if (lastError && fatal) {
          return { ok: false, errorCode: "FETCH_FAILED", errorDetail: errorText(lastError, "en"), at: Date.now(), ttl: NEGATIVE_TTL }
        }
        return { ok: false, errorCode: "NO_TOKEN", at: Date.now(), ttl: NEGATIVE_TTL }
      }
      const retryAfterMs = lastError instanceof HttpError && lastError.retryAfterMs ? lastError.retryAfterMs : 0
      const negTtl = retryAfterMs > 0 ? Math.min(Math.max(retryAfterMs, NEGATIVE_TTL), MAX_RETRY_AFTER_MS) : NEGATIVE_TTL
      return {
        ok: false,
        errorCode: "FETCH_FAILED",
        errorDetail: errorText(lastError ?? "", "en"),
        at: Date.now(),
        ttl: negTtl,
      }
    }

    async function status(input: unknown): Promise<LimitCard> {
      const parsed = (input ?? {}) as { force?: boolean; lang?: string; maxAgeMs?: number }
      const force = parsed.force === true
      const lang = parsed.lang ? normalizeLocale(parsed.lang) : defaultLocale()
      const requestedMaxAge =
        typeof parsed.maxAgeMs === "number" && Number.isFinite(parsed.maxAgeMs)
          ? Math.max(10_000, Math.min(parsed.maxAgeMs, TTL))
          : undefined

      const effectiveTtl = cache ? (requestedMaxAge ? Math.min(cache.ttl, requestedMaxAge) : cache.ttl) : 0
      if (!force && cache && Date.now() - cache.at < effectiveTtl) {
        return formatCached(cache, lang, history, false)
      }

      const startInflight = () => {
        if (inflight && inflight.epoch === epoch) return inflight.promise
        const runEpoch = epoch
        const promise = (async (): Promise<CachedRaw> => {
          const next = await load()
          if (runEpoch !== epoch) return next
          if (!stopEvents.signal.aborted || next.ok) {
            cache = next
          }
          if (next.ok) {
            diskCache = next
            scheduleResetTimer(next.rows)
            void ctx.storage.set(LAST_GOOD_KEY, next as unknown as any).catch(() => {})
            const acct = accountKey(next.org, next.email, next.source)
            const baseHistory = historyAccount && historyAccount !== acct ? [] : history
            const nextHistory = recordUsageSnapshot(baseHistory, next.rows, next.checkedAtMs)
            const changed =
              historyAccount !== acct ||
              nextHistory.length !== history.length ||
              nextHistory[nextHistory.length - 1] !== history[history.length - 1]
            if (changed) {
              historyAccount = acct
              history = nextHistory
              void ctx.storage
                .set(HISTORY_KEY, { account: historyAccount, snapshots: history } as unknown as any)
                .catch(() => {})
            }
          }
          return next
        })().finally(() => {
          if (inflight?.promise === promise) inflight = null
        })
        inflight = { epoch: runEpoch, promise }
        return promise
      }

      // Instant cold start: return last persisted good card while refreshing in background.
      if (!force && !cache && diskCache) {
        void startInflight().then((next) => {
          if (next.ok && !stopEvents.signal.aborted) {
            void rpcRef?.events.emit("changed", {}).catch(() => {})
          }
        })
        return formatCached(diskCache, lang, history, true)
      }

      const raw = await startInflight()
      return formatCached(raw, lang, history, false)
    }

    async function getPrefs(): Promise<SharedPrefs> {
      return { ...sharedPrefs }
    }

    async function setPrefs(input: unknown): Promise<SharedPrefs> {
      const patch = sanitizeSharedPrefs(input)
      if (Object.keys(patch).length > 0) {
        sharedPrefs = { ...sharedPrefs, ...patch }
        await ctx.storage.set(SHARED_PREFS_KEY, sharedPrefs as unknown as any).catch(() => {})
        void rpcRef?.events.emit("prefsChanged", {}).catch(() => {})
      }
      return { ...sharedPrefs }
    }

    async function updateStatus(input: unknown) {
      const parsed = (input ?? {}) as { check?: boolean; autoInstall?: boolean }
      return updater.check({
        force: parsed.check === true,
        autoInstall: typeof parsed.autoInstall === "boolean" ? parsed.autoInstall : autoUpdate,
      })
    }

    async function installUpdate() {
      return updater.install()
    }

    async function setUpdateConfig(input: unknown) {
      const next = (input as { autoUpdate?: boolean } | null)?.autoUpdate
      if (typeof next === "boolean") {
        autoUpdate = next
        await ctx.storage.set("autoUpdate", next).catch(() => {})
      }
      return { autoUpdate }
    }

    const rpc = await ctx.rpc.register(Limits, {
      status,
      getPrefs,
      setPrefs,
      updateStatus,
      installUpdate,
      setUpdateConfig,
    })
    rpcRef = rpc

    const startupTimer = setTimeout(() => {
      if (!stopEvents.signal.aborted && autoUpdate) {
        void updater.check({ force: false, autoInstall: true })
      }
    }, INITIAL_UPDATE_DELAY_MS)
    startupTimer.unref?.()

    const periodicTimer = setInterval(() => {
      if (!stopEvents.signal.aborted && autoUpdate) {
        void updater.check({ force: true, autoInstall: true })
      }
    }, UPDATE_INTERVAL_MS)
    periodicTimer.unref?.()

    let usageDebounce: ReturnType<typeof setTimeout> | null = null
    let lastUsageEmitAt = 0

    if (typeof ctx.event?.subscribe === "function") {
      void (async () => {
        try {
          for await (const ev of ctx.event.subscribe({
            types: [
              "credential.updated",
              "credential.switched",
              "integration.updated",
              "config.updated",
              "provider.updated",
              "session.usage.updated",
              "session.idle",
            ],
            signal: stopEvents.signal,
          })) {
            const type = (ev as { type?: string })?.type ?? ""
            if (type === "session.usage.updated" || type === "session.idle") {
              if (usageDebounce) clearTimeout(usageDebounce)
              usageDebounce = setTimeout(() => {
                usageDebounce = null
                if (stopEvents.signal.aborted) return
                const now = Date.now()
                if (now - lastUsageEmitAt < USAGE_EVENT_COOLDOWN_MS) return
                if (cache && now - cache.at < USAGE_EVENT_COOLDOWN_MS) return
                lastUsageEmitAt = now
                cache = null
                void rpc.events.emit("changed", {}).catch(() => {})
              }, USAGE_EVENT_DEBOUNCE_MS)
              usageDebounce.unref?.()
              continue
            }
            epoch += 1
            cache = null
            // A different credential may belong to another account: never show the old account's card.
            diskCache = null
            creds.dropCli()
            void rpc.events.emit("changed", {}).catch(() => {})
          }
        } catch (error) {
          if (!stopEvents.signal.aborted) log("event subscription ended", { error: errorText(error, "en") })
        }
      })()
    }

    return () => {
      clearTimeout(startupTimer)
      clearInterval(periodicTimer)
      if (usageDebounce) clearTimeout(usageDebounce)
      if (resetTimer) clearTimeout(resetTimer)
      stopEvents.abort()
    }
  },
})
