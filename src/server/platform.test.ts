import { test } from "node:test"
import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import { anySignal, capabilities, hasUnzip, nodeSupportsAbortSignalAny, tarCommand } from "./platform.ts"

test("anySignal forwards a single signal's abort", () => {
  const only = new AbortController()
  const combined = anySignal([only.signal])
  assert.equal(combined.aborted, false)
  only.abort(new Error("only"))
  assert.equal(combined.aborted, true)
  assert.equal((combined.reason as Error).message, "only")
})

test("anySignal aborts the combined signal when either source aborts", () => {
  const first = new AbortController()
  const second = new AbortController()
  const combined = anySignal([first.signal, second.signal])
  assert.equal(combined.aborted, false)

  first.abort(new Error("first"))
  assert.equal(combined.aborted, true)
  assert.equal((combined.reason as Error).message, "first")

  // Aborting the other source afterwards must not throw.
  second.abort()
  assert.equal(combined.aborted, true)
})

test("anySignal fallback links listeners once and removes them on abort", () => {
  const original = AbortSignal.any
  // Force the fallback: native `AbortSignal.any` is not available on older Node releases.
  Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true, writable: true })
  try {
    assert.equal(nodeSupportsAbortSignalAny(), false)
    const first = new AbortController()
    const second = new AbortController()
    const combined = anySignal([first.signal, second.signal])
    assert.equal(getEventListeners(first.signal, "abort").length, 1)
    assert.equal(getEventListeners(second.signal, "abort").length, 1)

    second.abort(new Error("second"))
    assert.equal(combined.aborted, true)
    assert.equal((combined.reason as Error).message, "second")
    assert.equal(getEventListeners(first.signal, "abort").length, 0)
    assert.equal(getEventListeners(second.signal, "abort").length, 0)

    first.abort()
    assert.equal((combined.reason as Error).message, "second")
  } finally {
    Object.defineProperty(AbortSignal, "any", { value: original, configurable: true, writable: true })
  }
})

test("anySignal fallback aborts immediately for an already-aborted source without leaking listeners", () => {
  const original = AbortSignal.any
  Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true, writable: true })
  try {
    const aborted = new AbortController()
    aborted.abort(new Error("already"))
    const live = new AbortController()
    const combined = anySignal([aborted.signal, live.signal])
    assert.equal(combined.aborted, true)
    assert.equal((combined.reason as Error).message, "already")
    assert.equal(getEventListeners(live.signal, "abort").length, 0)
  } finally {
    Object.defineProperty(AbortSignal, "any", { value: original, configurable: true, writable: true })
  }
})

test("capabilities reports the Node version string and platform tar path", () => {
  const caps = capabilities()
  assert.equal(caps.node, process.version)
  assert.equal(caps.node.startsWith("v"), true)
  assert.equal(caps.tar, tarCommand())
  assert.match(caps.tar, /tar(?:\.exe)?$/)
  assert.equal(caps.platform, process.platform)
  assert.equal(caps.abortSignalAny, nodeSupportsAbortSignalAny())
  assert.equal(typeof caps.unzip, "boolean")
  assert.equal(caps.unzip, hasUnzip())
})
