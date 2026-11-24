import os from "node:os"
import path from "node:path"
import { constants } from "node:fs"
import { chmod, mkdir, open, rename, stat } from "node:fs/promises"
import { redactSecrets } from "../core/index.ts"

const DIR = path.join(os.tmpdir(), "opencode-limits-go")
const FILE = path.join(DIR, "limits.log")
const MAX = 256 * 1024
const DIR_MODE = 0o700
const FILE_MODE = 0o600
const POSIX = process.platform !== "win32"

let writeChain: Promise<void> = Promise.resolve()

export { FILE as logFile }

async function writeLine(line: string): Promise<void> {
  await mkdir(DIR, { recursive: true, mode: DIR_MODE })
  // mkdir only applies the mode when it creates the directory: tighten a pre-existing one.
  if (POSIX) await chmod(DIR, DIR_MODE).catch(() => {})
  try {
    const info = await stat(FILE)
    if (info.size > MAX) await rename(FILE, `${FILE}.1`)
  } catch {}
  const noFollow: number = constants.O_NOFOLLOW ?? 0
  const handle = await open(
    FILE,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
    FILE_MODE,
  )
  try {
    if (POSIX) await handle.chmod(FILE_MODE).catch(() => {})
    await handle.write(line)
  } finally {
    await handle.close()
  }
}

export function log(message: string, data: Record<string, unknown> = {}): void {
  const raw = JSON.stringify({ at: new Date().toISOString(), message, ...data })
  const line = `${redactSecrets(raw)}\n`
  writeChain = writeChain.then(() => writeLine(line)).catch(() => {})
}
