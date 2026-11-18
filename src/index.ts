import { Plugin } from "@opencode/plugin"
import { Limits } from "./rpc.ts"
import { type Identity, createCredentials } from "./auth.ts"
import { HttpError, fetchUsage } from "./api.ts"
import { log } from "./log.ts"
import {
  CodedError,
  type ErrorCode,
  type LimitCard,
  type LimitRow,
  type Locale,
  type UsageSnapshot,
  attachHistoryDeltas,
  emptyCard,
  errorText,
  formatError,
  localizeRows,
  normalizeLocale,
  parseUsage,
  recordUsageSnapshot,
  tightLine,
} from "./model.ts"
import { createUpdater } from "./updater.ts"

const TTL = 90_000
const NEGATIVE_TTL = 25_000
const DEADLINE = 25_000
const HTTP_TIMEOUT = 10_000
const INITIAL_UPDATE_DELAY_MS = 15_000
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
const USAGE_EVENT_COOLDOWN_MS = 12_000
const USAGE_EVENT_DEBOUNCE_MS = 1_500
const HISTORY_KEY = "history:v1"

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

function defaultLocale(): Locale {
  const envLang = process.env.OPENCODE_LANG || process.env.LC_ALL || process.env.LANG
  return normalizeLocale(envLang)
}

function formatCached(entry: CachedRaw, lang: Locale, history: readonly UsageSnapshot[]): LimitCard {
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
    snapshots: history.slice(-24),
  }
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
    let inflight: Promise<CachedRaw> | null = null
    let rpcRef: { events: { emit: (name: "changed" | "updated", data: any) => Promise<void> } } | null = null

    const savedHistory = await ctx.storage.get(HISTORY_KEY).catch(() => undefined)
    let history: UsageSnapshot[] = Array.isArray(savedHistory)
      ? (savedHistory as UsageSnapshot[]).filter((s) => s && typeof s.at === "number")
      : []

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
            if (!isTokenError(error)) {
              fatal = true
              break
            }
          }
        }
        return null
      }

      const primary = await tryList(await creds.listPrimary())
      if (primary) return primary

      if (!fatal && !stopEvents.signal.aborted && Date.now() < deadline - 200) {
        const fallback = await tryList(await creds.listFallback())
        if (fallback) return fallback
      }

      if (!fatal && sawStaleCli && !stopEvents.signal.aborted && Date.now() < deadline - 500) {
        const refreshed = await tryList(await creds.listFallback({ freshCli: true }))
        if (refreshed) return refreshed
      }

      if (!foundAny) {
        return { ok: false, errorCode: "NO_TOKEN", at: Date.now(), ttl: NEGATIVE_TTL }
      }
      return {
        ok: false,
        errorCode: "FETCH_FAILED",
        errorDetail: errorText(lastError ?? "", "en"),
        at: Date.now(),
        ttl: NEGATIVE_TTL,
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
        return formatCached(cache, lang, history)
      }

      if (!inflight) {
        inflight = (async (): Promise<CachedRaw> => {
          const next = await load()
          if (!stopEvents.signal.aborted || next.ok) {
            cache = next
          }
          if (next.ok) {
            const nextHistory = recordUsageSnapshot(history, next.rows, next.checkedAtMs)
            if (nextHistory.length !== history.length || nextHistory[nextHistory.length - 1] !== history[history.length - 1]) {
              history = nextHistory
              void ctx.storage.set(HISTORY_KEY, history as unknown as any).catch(() => {})
            }
          }
          return next
        })().finally(() => {
          inflight = null
        })
      }

      const raw = await inflight
      return formatCached(raw, lang, history)
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
            cache = null
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
      stopEvents.abort()
    }
  },
})
