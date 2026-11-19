import os from "node:os"
import path from "node:path"
import { appendFile, rename, stat } from "node:fs/promises"
import { redactSecrets } from "./model.ts"

const FILE = path.join(os.tmpdir(), "opencode-limits-go.log")
const MAX = 256 * 1024

let writeChain: Promise<void> = Promise.resolve()

export function log(message: string, data: Record<string, unknown> = {}): void {
  const raw = JSON.stringify({ at: new Date().toISOString(), message, ...data })
  const line = `${redactSecrets(raw)}\n`
  writeChain = writeChain
    .then(async () => {
      try {
        const info = await stat(FILE)
        if (info.size > MAX) await rename(FILE, `${FILE}.1`)
      } catch {}
      await appendFile(FILE, line)
    })
    .catch(() => {})
}
