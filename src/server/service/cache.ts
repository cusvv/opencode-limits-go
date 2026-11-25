import type { CardErrorCode, ErrorCode, LimitRow } from "../../core/index.ts"
import { isValidRow } from "./history.ts"
import { clearStorage, readStorage, writeStorage, type StorageLike } from "./storage.ts"

export const TTL = 90_000
export const NEGATIVE_TTL = 25_000
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000
export const LAST_GOOD_KEY = "lastGood:v1"

export type CachedSuccess = {
  ok: true
  org: string
  email: string
  checkedAt: string
  checkedAtMs: number
  source: string
  rows: LimitRow[]
  at: number
  ttl: number
  accountId?: string
}

export type CachedFailure = {
  ok: false
  /** Parse-level code used to build the localized legacy message. */
  errorCode: ErrorCode
  errorDetail?: string
  /** Additive machine-readable contract code. */
  cardCode: CardErrorCode
  /** Fingerprint of the credential that failed, when one was tried. */
  accountId?: string
  at: number
  ttl: number
}

export type CachedRaw = CachedSuccess | CachedFailure

export type LimitsCache = {
  get(): CachedRaw | null
  peek(maxAgeMs?: number): CachedRaw | null
  begin(epoch: number): void
  complete(epoch: number, result: CachedRaw): boolean
  invalidate(): void
  load(epoch: number, loader: () => Promise<CachedRaw>): Promise<CachedRaw>
}

export function createCache(deps: { now?: () => number } = {}): LimitsCache {
  const now = deps.now ?? Date.now
  let entry: CachedRaw | null = null
  let currentEpoch = 0
  let generation = 0
  let inflight: { epoch: number; promise: Promise<CachedRaw> } | null = null

  function get(): CachedRaw | null {
    return entry
  }

  function peek(maxAgeMs?: number): CachedRaw | null {
    if (!entry) return null
    const ttl = maxAgeMs === undefined ? entry.ttl : Math.min(entry.ttl, maxAgeMs)
    return Math.max(0, now() - entry.at) < ttl ? entry : null
  }

  function begin(epoch: number): void {
    currentEpoch = epoch
  }

  function complete(epoch: number, result: CachedRaw): boolean {
    if (epoch !== currentEpoch) return false
    entry = result
    return true
  }

  function invalidate(): void {
    entry = null
    generation += 1
  }

  function load(epoch: number, loader: () => Promise<CachedRaw>): Promise<CachedRaw> {
    if (inflight && inflight.epoch === epoch) return inflight.promise
    const runGeneration = generation
    const promise = (async (): Promise<CachedRaw> => {
      const result = await loader()
      if (runGeneration === generation && epoch === currentEpoch) entry = result
      return result
    })().finally(() => {
      if (inflight?.promise === promise) inflight = null
    })
    inflight = { epoch, promise }
    return promise
  }

  return { get, peek, begin, complete, invalidate, load }
}

export type LastGoodStore = {
  load(): Promise<CachedSuccess | null>
  get(): CachedSuccess | null
  save(entry: CachedSuccess): Promise<void>
  clear(): Promise<void>
}

function validSuccess(raw: unknown): CachedSuccess | null {
  if (!raw || typeof raw !== "object") return null
  const rec = raw as Record<string, unknown>
  if (rec.ok !== true) return null
  if (!Array.isArray(rec.rows)) return null
  const rows = rec.rows.filter(isValidRow)
  if (rows.length === 0) return null
  if (
    typeof rec.org !== "string" ||
    typeof rec.email !== "string" ||
    typeof rec.checkedAt !== "string" ||
    typeof rec.source !== "string" ||
    typeof rec.checkedAtMs !== "number" ||
    !Number.isFinite(rec.checkedAtMs) ||
    typeof rec.at !== "number" ||
    !Number.isFinite(rec.at) ||
    typeof rec.ttl !== "number" ||
    !Number.isFinite(rec.ttl)
  ) {
    return null
  }
  return {
    ok: true,
    org: rec.org,
    email: rec.email,
    checkedAt: rec.checkedAt,
    checkedAtMs: rec.checkedAtMs,
    source: rec.source,
    rows,
    at: rec.at,
    ttl: rec.ttl,
    ...(typeof rec.accountId === "string" && rec.accountId ? { accountId: rec.accountId } : {}),
  }
}

export function createLastGoodStore(deps: { storage: StorageLike }): LastGoodStore {
  const { storage } = deps
  let entry: CachedSuccess | null = null

  async function load(): Promise<CachedSuccess | null> {
    const parsed = validSuccess(await readStorage(storage, LAST_GOOD_KEY))
    entry = parsed
    return parsed
  }

  function get(): CachedSuccess | null {
    return entry
  }

  async function save(next: CachedSuccess): Promise<void> {
    entry = next
    await writeStorage(storage, LAST_GOOD_KEY, next)
  }

  async function clear(): Promise<void> {
    entry = null
    // A sentinel is ignored by validSuccess, so it is safe without a delete API.
    await clearStorage(storage, LAST_GOOD_KEY, { ok: false })
  }

  return { load, get, save, clear }
}
