import os from "node:os"
import path from "node:path"
import { appendFileSync, renameSync, statSync } from "node:fs"

const FILE = path.join(os.tmpdir(), "zen-limits.log")
const MAX = 256 * 1024

export function log(message: string, data: Record<string, unknown> = {}): void {
  try {
    try {
      if (statSync(FILE).size > MAX) renameSync(FILE, `${FILE}.1`)
    } catch {}
    const line = JSON.stringify({ at: new Date().toISOString(), message, ...data })
    appendFileSync(FILE, `${line}\n`)
  } catch {}
}
