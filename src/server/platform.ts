import { existsSync } from "node:fs"
import path from "node:path"

export function nodeSupportsAbortSignalAny(): boolean {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function"
}

export function tarCommand(): string {
  return process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar"
}

let unzipCache: boolean | undefined

export function hasUnzip(): boolean {
  if (unzipCache !== undefined) return unzipCache
  const names = process.platform === "win32" ? ["unzip.exe", "unzip.cmd", "unzip"] : ["unzip"]
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  unzipCache = dirs.some((dir) => names.some((name) => existsSync(path.join(dir, name))))
  return unzipCache
}

export type Capabilities = {
  node: string
  platform: NodeJS.Platform
  arch: string
  tar: string
  unzip: boolean
  abortSignalAny: boolean
}

export function capabilities(): Capabilities {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    tar: tarCommand(),
    unzip: hasUnzip(),
    abortSignalAny: nodeSupportsAbortSignalAny(),
  }
}

/**
 * Abort when any of `signals` aborts. Uses the native implementation when available; otherwise links
 * with `{ once: true }` listeners and removes every listener as soon as the result aborts.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (nodeSupportsAbortSignalAny()) return AbortSignal.any(signals)

  const controller = new AbortController()
  const cleanups: Array<() => void> = []
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason)
    for (const cleanup of cleanups) cleanup()
    cleanups.length = 0
  }

  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal.reason)
      break
    }
    const onAbort = (): void => abort(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    cleanups.push(() => signal.removeEventListener("abort", onAbort))
  }

  return controller.signal
}
