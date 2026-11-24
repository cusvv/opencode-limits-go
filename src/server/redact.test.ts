import { test } from "node:test"
import assert from "node:assert/strict"
import { redactSecrets } from "../core/index.ts"

test("redactSecrets hides JSON secret values but keeps the key", () => {
  const redacted = redactSecrets('{"api_key":"supersecret123"}')
  assert.equal(redacted.includes("supersecret123"), false)
  assert.match(redacted, /"api_key"\s*:\s*"\[REDACTED\]"/)

  for (const key of ["token", "access_token", "refresh_token", "apikey", "key", "authorization"]) {
    const line = `{"${key}": "sensitive-value-123"}`
    assert.equal(redactSecrets(line).includes("sensitive-value-123"), false, key)
    assert.match(redactSecrets(line), new RegExp(`"${key}"\\s*:\\s*"\\[REDACTED\\]"`), key)
  }
})

test("redactSecrets hides header-form credentials", () => {
  const apiKey = redactSecrets("x-api-key: abcdef123456")
  assert.equal(apiKey.includes("abcdef123456"), false)
  assert.match(apiKey, /x-api-key:\s*\[REDACTED\]/)

  const apiKeyAlt = redactSecrets("api-key: abcdef123456")
  assert.equal(apiKeyAlt.includes("abcdef123456"), false)

  const authorization = redactSecrets("Authorization: Basic dXNlcjpwYXNz")
  assert.equal(authorization.includes("dXNlcjpwYXNz"), false)
  assert.match(authorization, /Authorization:\s*\[REDACTED\]/)
})

test("redactSecrets still hides Bearer, JWT, prefixed keys, and token=", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl"
  const text = `Authorization: Bearer sk-live-123456789\ntoken=${jwt} ${jwt}`
  const redacted = redactSecrets(text)
  assert.equal(redacted.includes("sk-live-123456789"), false)
  assert.equal(redacted.includes(jwt), false)
  assert.match(redacted, /token=\[REDACTED\]/)
})

test("redactSecrets leaves ordinary text without secrets unchanged", () => {
  const plain = "GET /api/usage returned HTTP 429 after 3 attempts; retrying in 5s"
  assert.equal(redactSecrets(plain), plain)
  assert.equal(redactSecrets("the key was not found in the config file"), "the key was not found in the config file")
})
