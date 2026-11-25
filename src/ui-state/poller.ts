import type { LimitCard } from "../core/index.ts"

export const DEFAULT_STATUS_TIMEOUT_MS = 30_000

export type StatusFetchInput = {
  force: boolean
  signal: AbortSignal
}

export type StatusPollerOptions = {
  fetchStatus(input: StatusFetchInput): Promise<LimitCard>
  onResult(card: LimitCard, meta: { force: boolean }): void
  onError(error: unknown): void
  /** Called when a request actually starts, including one drained from the queue. */
  onStart?(meta: { force: boolean }): void
  timeoutMs?: number
}

export type RefreshResult = Promise<LimitCard | null>

type Waiter = {
  promise: Promise<LimitCard | null>
  resolve(value: LimitCard | null): void
}

export type StatusPoller = {
  /**
   * Starts a request, or joins the next one with a queued `force` when one is in flight.
   * The promise resolves with the result of the request that covers this call.
   */
  refresh(force?: boolean): RefreshResult
  /** Drops the in-flight request and the queue, resolving their waiters to null. */
  invalidate(): void
  dispose(): void
  /** A request is currently in flight. */
  busy(): boolean
}

/**
 * Framework-agnostic single-flight status poller: one request at a time, forced refreshes
 * queued (coalesced), stale responses dropped, and every request bounded by a timeout.
 */
export function createStatusPoller(options: StatusPollerOptions): StatusPoller {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS
  let seq = 0
  let inFlight = false
  let queuedForce: boolean | null = null
  let controller: AbortController | null = null
  let disposed = false
  let queuedWaiters: Waiter[] = []
  let activeWaiters: Waiter[] | null = null

  // Promise.withResolvers exists at runtime but not in the ES2022 lib this package type-checks against.
  function createWaiter(): Waiter {
    let resolve!: (value: LimitCard | null) => void
    const promise = new Promise<LimitCard | null>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  function resolveWaiters(waiters: readonly Waiter[], value: LimitCard | null): void {
    for (const waiter of waiters) waiter.resolve(value)
  }

  function start(force: boolean, waiters: Waiter[]): RefreshResult {
    inFlight = true
    const token = ++seq
    const ctrl = new AbortController()
    controller = ctrl
    activeWaiters = waiters
    options.onStart?.({ force })

    const settle = (value: LimitCard | null) => {
      if (activeWaiters === waiters) activeWaiters = null
      resolveWaiters(waiters, value)
    }

    const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(timeoutMs)])
    return (async (): Promise<LimitCard | null> => {
      try {
        const card = await options.fetchStatus({ force, signal })
        if (disposed || token !== seq) {
          settle(null)
          return null
        }
        options.onResult(card, { force })
        settle(card)
        return card
      } catch (error) {
        if (disposed || token !== seq) {
          settle(null)
          return null
        }
        options.onError(error)
        settle(null)
        return null
      } finally {
        if (token === seq) {
          inFlight = false
          controller = null
          const next = queuedForce
          queuedForce = null
          if (next !== null && !disposed) {
            const pending = queuedWaiters
            queuedWaiters = []
            void start(next, pending)
          }
        }
      }
    })()
  }

  function refresh(force = false): RefreshResult {
    if (disposed) return Promise.resolve(null)
    if (inFlight) {
      queuedForce = queuedForce === true || force
      const waiter = createWaiter()
      queuedWaiters.push(waiter)
      return waiter.promise
    }
    return start(force, [])
  }

  function invalidate(): void {
    seq += 1
    controller?.abort()
    controller = null
    inFlight = false
    queuedForce = null
    const active = activeWaiters
    activeWaiters = null
    if (active) resolveWaiters(active, null)
    const queued = queuedWaiters
    queuedWaiters = []
    resolveWaiters(queued, null)
  }

  function dispose(): void {
    disposed = true
    invalidate()
  }

  return {
    refresh,
    invalidate,
    dispose,
    busy: () => inFlight,
  }
}
