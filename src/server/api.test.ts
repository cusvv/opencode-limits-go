import { test } from "node:test"
import assert from "node:assert/strict"
import { HttpError, fetchUsage, isRetryableFetchError } from "./api.ts"
import { CodedError } from "../core/index.ts"

test("isRetryableFetchError classifies HTTP status codes and error types", () => {
  assert.equal(isRetryableFetchError(new HttpError(500)), true)
  assert.equal(isRetryableFetchError(new HttpError(503)), true)
  assert.equal(isRetryableFetchError(new HttpError(429)), true)
  assert.equal(isRetryableFetchError(new HttpError(401)), false)
  assert.equal(isRetryableFetchError(new HttpError(403)), false)
  assert.equal(isRetryableFetchError(new CodedError("INVALID_JSON")), false)
  const abortErr = new Error("aborted")
  abortErr.name = "AbortError"
  assert.equal(isRetryableFetchError(abortErr), false)
  assert.equal(isRetryableFetchError(new TypeError("fetch failed")), true)
})

test("fetchUsage retries once on 503 and succeeds on second attempt", async () => {
  const origFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 })
    }
    return new Response(JSON.stringify({ usage: { rolling: { percent: 15 } } }), { status: 200 })
  }) as typeof fetch
  try {
    const data = (await fetchUsage("tok_123", 5000)) as { usage: { rolling: { percent: number } } }
    assert.equal(calls, 2)
    assert.equal(data.usage.rolling.percent, 15)
  } finally {
    globalThis.fetch = origFetch
  }
})

test("fetchUsage does not retry on 401 and extracts JSON error detail", async () => {
  const origFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({ error: { message: "Invalid token" } }), { status: 401 })
  }) as typeof fetch
  try {
    await assert.rejects(
      () => fetchUsage("tok_bad", 5000),
      (err: unknown) => err instanceof HttpError && err.status === 401 && err.detail === "Invalid token",
    )
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = origFetch
  }
})

test("fetchUsage ignores HTML error pages and throws INVALID_JSON on malformed 200 body", async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response("<html>502 Bad Gateway</html>", { status: 404 })) as typeof fetch
  try {
    await assert.rejects(
      () => fetchUsage("tok_123", 5000),
      (err: unknown) => err instanceof HttpError && err.status === 404 && err.detail === undefined,
    )
  } finally {
    globalThis.fetch = origFetch
  }

  globalThis.fetch = (async () => new Response("not-json", { status: 200 })) as typeof fetch
  try {
    await assert.rejects(
      () => fetchUsage("tok_123", 5000),
      (err: unknown) => err instanceof CodedError && err.code === "INVALID_JSON",
    )
  } finally {
    globalThis.fetch = origFetch
  }
})

test("parseRetryAfterMs handles seconds and HTTP dates, and fetchUsage respects long Retry-After without retrying", async () => {
  const { parseRetryAfterMs } = await import("./api.ts")
  const now = Date.parse("2026-11-19T12:00:00Z")
  assert.equal(parseRetryAfterMs("45", now), 45_000)
  assert.equal(parseRetryAfterMs("Thu, 19 Nov 2026 12:01:00 GMT", now), 60_000)
  assert.equal(parseRetryAfterMs("invalid", now), undefined)

  const origFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify({ error: "rate limited" }), {
      status: 429,
      headers: { "Retry-After": "120" },
    })
  }) as typeof fetch
  try {
    await assert.rejects(
      () => fetchUsage("tok_123", 3000),
      (err: unknown) => err instanceof HttpError && err.status === 429 && err.retryAfterMs === 120_000,
    )
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = origFetch
  }
})
