import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export async function defaultReadLegacyAuth(env: Record<string, string | undefined>): Promise<unknown> {
  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  const file = path.join(dataHome, "opencode", "auth.json")
  let content: string
  try {
    content = await readFile(file, "utf8")
  } catch {
    return null
  }
  try {
    return JSON.parse(content)
  } catch {
    throw new Error("auth.json contains invalid JSON")
  }
}
