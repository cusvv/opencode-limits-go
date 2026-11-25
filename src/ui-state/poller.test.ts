import assert from "node:assert/strict"
import test from "node:test"
import type { LimitCard } from "../core/index.ts"
import { createStatusPoller, type StatusFetchInput } from "./poller.ts"

function card(org: string): LimitCard {
  return { ok: true, org, email: "", checkedAt: "", source: "", rows: [], tight: "", error: "" }
}

// Promise.withResolvers exists at runtime (Node 24) but not in the ES2022 lib this repo type-checks against.
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

// The poller's continuation is one microtask behind the fetch promise it awaits.
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

test("refresh applies the fetched card with its force flag", async () => {
  const calls: StatusFetchInput[] = []
  const applied: Array<{ org: string; force: boolean }> = []
  const poller = createStatusPoller({
    fetchStatus: async (input) => {
      calls.push(input)
      return card("a")
    },
    onResult: (result, meta) => applied.push({ org: result.org, force: meta.force }),
    onError: () => assert.fail("unexpected error"),
  })

  const first = await poller.refresh(false)
  assert.equal(first?.org, "a")
  assert.deepEqual(applied, [{ org: "a", force: false }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.force, false)
  assert.equal(calls[0]?.signal.aborted, false)
  poller.dispose()
})

test("an overlapping refresh queues force and runs a second request", async () => {
  const first = deferred<LimitCard>()
  const second = deferred<LimitCard>()
  const calls: boolean[] = []
  const applied: Array<{ org: string; force: boolean }> = []
  const poller = createStatusPoller({
    fetchStatus: (input) => {
      calls.push(input.force)
      return calls.length === 1 ? first.promise : second.promise
    },
    onResult: (result, meta) => applied.push({ org: result.org, force: meta.force }),
    onError: () => assert.fail("unexpected error"),
  })

  const pending = poller.refresh(false)
  const queued = poller.refresh(true)

  first.resolve(card("a"))
  assert.equal((await pending)?.org, "a")
  await settle()
  assert.deepEqual(calls, [false, true])
  assert.deepEqual(applied, [{ org: "a", force: false }])

  second.resolve(card("b"))
  assert.equal((await queued)?.org, "b")
  assert.deepEqual(applied, [
    { org: "a", force: false },
    { org: "b", force: true },
  ])
  poller.dispose()
})

test("a queued force-refresh receives the next request's result, not null", async () => {
  const first = deferred<LimitCard>()
  const second = deferred<LimitCard>()
  const poller = createStatusPoller({
    fetchStatus: () => (calls++ === 0 ? first.promise : second.promise),
    onResult: () => {},
    onError: () => assert.fail("unexpected error"),
  })
  let calls = 0

  const active = poller.refresh(true)
  const queuedMany = [poller.refresh(true), poller.refresh(true), poller.refresh(true)]

  first.resolve(card("a"))
  assert.equal((await active)?.org, "a")
  await settle()

  second.resolve(card("b"))
  for (const queued of queuedMany) assert.equal((await queued)?.org, "b")
  poller.dispose()
})

test("invalidate aborts the request and drops its late result", async () => {
  const pending = deferred<LimitCard>()
  let received: AbortSignal | undefined
  const applied: string[] = []
  const errors: unknown[] = []
  const poller = createStatusPoller({
    fetchStatus: (input) => {
      received = input.signal
      return pending.promise
    },
    onResult: (result) => applied.push(result.org),
    onError: (error) => errors.push(error),
  })

  const started = poller.refresh(false)
  const queued = poller.refresh(true)
  poller.invalidate()
  assert.equal(received?.aborted, true)
  pending.resolve(card("stale"))
  assert.equal(await started, null)
  assert.equal(await queued, null)
  await settle()
  assert.deepEqual(applied, [])
  assert.deepEqual(errors, [])
  assert.equal(poller.busy(), false)
  poller.dispose()
})

test("an ignored abort still drops the stale result", async () => {
  const fetch = deferred<LimitCard>()
  const applied: string[] = []
  const errors: unknown[] = []
  const poller = createStatusPoller({
    fetchStatus: () => fetch.promise,
    onResult: (result) => applied.push(result.org),
    onError: (error) => errors.push(error),
  })

  const started = poller.refresh(false)
  poller.invalidate()
  fetch.resolve(card("stale"))
  await started
  await settle()
  assert.deepEqual(applied, [])
  assert.deepEqual(errors, [])
  poller.dispose()
})

test("the timeout aborts the fetch signal passed to the caller", async () => {
  let received: AbortSignal | undefined
  const errors: unknown[] = []
  const poller = createStatusPoller({
    timeoutMs: 10,
    fetchStatus: (input) => {
      received = input.signal
      const pending = deferred<LimitCard>()
      input.signal.addEventListener("abort", () => pending.reject(input.signal.reason), { once: true })
      return pending.promise
    },
    onResult: () => assert.fail("result must not apply"),
    onError: (error) => errors.push(error),
  })

  await poller.refresh(false)
  assert.equal(received?.aborted, true)
  assert.equal(errors.length, 1)
  const reason = errors[0]
  assert.equal(reason instanceof Error, true)
  assert.equal((reason as Error).name, "TimeoutError")
  poller.dispose()
})

test("a second request after invalidate runs instead of staying queued", async () => {
  const first = deferred<LimitCard>()
  const calls: boolean[] = []
  const applied: string[] = []
  const poller = createStatusPoller({
    fetchStatus: (input) => {
      calls.push(input.force)
      if (calls.length === 1) return first.promise
      return Promise.resolve(card("fresh"))
    },
    onResult: (result) => applied.push(result.org),
    onError: () => assert.fail("unexpected error"),
  })

  const old = poller.refresh(false)
  poller.invalidate()
  const fresh = await poller.refresh(true)
  assert.equal(fresh?.org, "fresh")
  await settle()
  assert.deepEqual(calls, [false, true])
  assert.deepEqual(applied, ["fresh"])

  first.resolve(card("old"))
  await old
  await settle()
  assert.deepEqual(applied, ["fresh"])
  poller.dispose()
})
