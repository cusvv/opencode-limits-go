import { CodedError } from "./model.ts"

const ENDPOINT = "https://opencode.ai/zen/go/v1/usage"

export class HttpError extends Error {
  readonly status: number
  readonly detail?: string
  readonly retryable: boolean

  constructor(status: number, detail?: string) {
    super(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`)
    this.status = status
    this.detail = detail
    this.retryable = status === 429 || status >= 500
  }
}

async function readErrorDetail(res: Response): Promise<string | undefined> {
  try {
    const raw = (await res.text()).trim()
    if (!raw) return undefined
    try {
      const json = JSON.parse(raw) as { error?: unknown; message?: unknown }
      const msg =
        (json.error && typeof json.error === "object" && typeof (json.error as { message?: unknown }).message === "string"
          ? (json.error as { message: string }).message
          : undefined) ??
        (typeof json.message === "string" ? json.message : undefined) ??
        (typeof json.error === "string" ? json.error : undefined)
      if (msg && msg.trim()) return msg.trim().slice(0, 200)
    } catch {}
    if (!raw.startsWith("<")) return raw.slice(0, 200)
  } catch {}
  return undefined
}

export function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof HttpError) return error.retryable
  if (error instanceof CodedError) return false
  if (error instanceof Error && error.name === "AbortError") return false
  return true
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export async function fetchUsageOnce(access: string, timeoutMs = 10_000, parentSignal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(Math.max(200, timeoutMs))
  const signal = parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout
  const res = await fetch(ENDPOINT, {
    headers: { Authorization: `Bearer ${access}` },
    signal,
  })
  if (!res.ok) {
    const detail = await readErrorDetail(res)
    throw new HttpError(res.status, detail)
  }
  try {
    return await res.json()
  } catch {
    throw new CodedError("INVALID_JSON")
  }
}

export async function fetchUsage(access: string, timeoutMs = 10_000, parentSignal?: AbortSignal): Promise<unknown> {
  const deadline = Date.now() + Math.max(200, timeoutMs)
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now()
    if (remaining <= 200 || parentSignal?.aborted) break
    try {
      return await fetchUsageOnce(access, Math.min(timeoutMs, remaining), parentSignal)
    } catch (error) {
      lastError = error
      if (attempt === 0 && !parentSignal?.aborted && isRetryableFetchError(error) && deadline - Date.now() > 1500) {
        await pause(600, parentSignal)
        continue
      }
      throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Request aborted")
}
