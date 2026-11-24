import { CodedError, type Locale, formatError } from "./types.ts"

export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[^\s"'`]+/gi, "Bearer [REDACTED]")
    .replace(/\bBasic\s+[A-Za-z0-9+/]{4,}={0,2}/g, "Basic [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[REDACTED]")
    .replace(/\b(?:st|rt|sk|oc|pat|gho|ghp|gsk|xai)_[A-Za-z0-9._-]{6,}/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/gi, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16,}/g, "[REDACTED]")
    // JSON: keep the key, redact the string value.
    .replace(
      /("(?:token|access_token|refresh_token|api_key|apikey|key|authorization)"\s*:\s*)"[^"\r\n]*"/gi,
      '$1"[REDACTED]"',
    )
    // Header forms (may be embedded in a log line): x-api-key: ..., api-key: ..., Authorization: ...
    .replace(
      /(\b(?:x-api-key|api-key|authorization)[ \t]*:[ \t]*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n"]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(token|access_token|refresh_token|api_key|apikey|key)=([^&\s"'`]+)/gi, "$1=[REDACTED]")
}

export function errorText(error: unknown, lang: Locale = "en"): string {
  if (error instanceof CodedError) {
    return redactSecrets(formatError(error.code, error.detail, lang))
  }
  const raw = error instanceof Error ? error.message : String(error)
  return redactSecrets(raw)
}

export function defaultPause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export async function retry<T>(
  attempt: () => Promise<T | null>,
  ok: (value: T | null) => boolean,
  attempts = 5,
  pause: (ms: number, signal?: AbortSignal) => Promise<void> = defaultPause,
  signal?: AbortSignal,
): Promise<T | null> {
  let last: T | null = null
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return last
    last = await attempt()
    if (ok(last) || signal?.aborted || i === attempts - 1) return last
    await pause(500 * (i + 1), signal)
  }
  return last
}

function parseSemverParts(raw: string): [number, number, number] | null {
  const match = raw.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemverParts(a)
  const pb = parseSemverParts(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

export function isNewerVersion(latest: string, current: string): boolean {
  if (!parseSemverParts(latest) || !parseSemverParts(current)) return false
  return compareSemver(latest, current) > 0
}
