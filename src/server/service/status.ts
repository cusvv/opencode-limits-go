import {
  CodedError,
  type CardErrorCode,
  type ErrorCode,
  type LimitCard,
  type UsageSnapshot,
  attachHistoryDeltas,
  emptyCard,
  errorText,
  selectSnapshotsForClient,
} from "../../core/index.ts"
import { HttpError } from "../api.ts"
import type { CachedFailure, CachedRaw } from "./cache.ts"

export function cardCodeForError(error: unknown): CardErrorCode {
  if (error instanceof HttpError) {
    if (error.status === 429) return "RATE_LIMIT"
    if (error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404) return "AUTH"
    return "INTERNAL"
  }
  if (error instanceof CodedError) return "BAD_RESPONSE"
  if (error instanceof Error) {
    if (error instanceof TypeError) return "OFFLINE"
    if (error.name === "AbortError") return "OFFLINE"
    if (/fetch failed|network|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(error.message)) return "OFFLINE"
  }
  return "INTERNAL"
}

export function internalCodeForError(error: unknown): ErrorCode {
  return error instanceof CodedError ? error.code : "FETCH_FAILED"
}

export function failureForError(error: unknown, at: number, ttl: number, accountId?: string): CachedFailure {
  return {
    ok: false,
    errorCode: internalCodeForError(error),
    errorDetail: errorText(error),
    cardCode: cardCodeForError(error),
    ...(accountId ? { accountId } : {}),
    at,
    ttl,
  }
}

export type CardFormatOptions = {
  history: readonly UsageSnapshot[]
  now: number
  stale?: boolean
  accountId?: string
  revision: number
}

/** Builds a language-neutral card. UI layers localize labels, timestamps, and errors on render. */
export function formatCached(entry: CachedRaw, options: CardFormatOptions): LimitCard {
  const { history, now, accountId, revision } = options
  if (!entry.ok) {
    const base = emptyCard(entry.cardCode)
    return {
      ...base,
      checkedAtMs: entry.at,
      stale: options.stale === true,
      ...(entry.accountId ?? accountId ? { accountId: entry.accountId ?? accountId } : {}),
      revision,
      errorCode: entry.cardCode,
      ...(entry.errorDetail ? { errorDetail: entry.errorDetail } : {}),
    }
  }
  const rows = attachHistoryDeltas(entry.rows, history, now)
  const resolvedAccountId = entry.accountId ?? accountId
  return {
    ok: true,
    org: entry.org,
    email: entry.email,
    checkedAt: entry.checkedAt,
    checkedAtMs: entry.checkedAtMs,
    source: entry.source,
    rows,
    tight: "",
    error: "",
    stale: options.stale === true,
    snapshots: selectSnapshotsForClient(history, now, 72),
    ...(resolvedAccountId ? { accountId: resolvedAccountId } : {}),
    revision,
  }
}
