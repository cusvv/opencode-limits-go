import { CodedError } from "./model.ts"

const ENDPOINT = "https://opencode.ai/zen/go/v1/usage"

export class HttpError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

export async function fetchUsage(access: string, timeoutMs = 10_000, parentSignal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(Math.max(200, timeoutMs))
  const signal = parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout
  const res = await fetch(ENDPOINT, {
    headers: { Authorization: `Bearer ${access}` },
    signal,
  })
  if (!res.ok) throw new HttpError(res.status)
  try {
    return await res.json()
  } catch {
    throw new CodedError("INVALID_JSON")
  }
}
