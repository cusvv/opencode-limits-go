import { createHmac, randomBytes } from "node:crypto"
import type { LimitRow, UsageSnapshot } from "../../core/index.ts"
import { clearStorage, readStorage, writeStorage, type StorageLike } from "./storage.ts"

export const HISTORY_KEY = "history:v2"
export const ACCOUNT_SALT_KEY = "accountSalt:v1"

const SALT_BYTES = 32
const ACCOUNT_ID_HEX_CHARS = 32

export type HistoryState = {
  account: string
  snapshots: UsageSnapshot[]
}

export function isValidRow(raw: unknown): raw is LimitRow {
  if (!raw || typeof raw !== "object") return false
  const row = raw as Record<string, unknown>
  return (
    typeof row.label === "string" &&
    typeof row.used === "number" &&
    Number.isFinite(row.used) &&
    typeof row.status === "string" &&
    (row.key === undefined || row.key === "rolling" || row.key === "weekly" || row.key === "monthly") &&
    (row.resetsAtMs === undefined ||
      (typeof row.resetsAtMs === "number" && Number.isFinite(row.resetsAtMs) && row.resetsAtMs >= 0)) &&
    typeof row.resetsAt === "string" &&
    typeof row.resetsIn === "string"
  )
}

export function sanitizeSnapshots(raw: unknown): UsageSnapshot[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is UsageSnapshot => {
    if (!item || typeof item !== "object") return false
    const snap = item as Record<string, unknown>
    if (typeof snap.at !== "number" || !Number.isFinite(snap.at)) return false
    if (!["rolling", "weekly", "monthly"].every((key) => snap[key] === undefined || typeof snap[key] === "number")) {
      return false
    }
    if (snap.resets !== undefined) {
      if (!snap.resets || typeof snap.resets !== "object") return false
      const resets = snap.resets as Record<string, unknown>
      const valid = ["rolling", "weekly", "monthly"].every(
        (key) => resets[key] === undefined || (typeof resets[key] === "number" && Number.isFinite(resets[key])),
      )
      if (!valid) return false
    }
    return true
  })
}

function decodeSalt(raw: unknown): Buffer | null {
  if (typeof raw !== "string") return null
  try {
    const bytes = Buffer.from(raw, "base64")
    return bytes.length === SALT_BYTES ? bytes : null
  } catch {
    return null
  }
}

/**
 * Stable account identity derived from the credential, never the credential itself.
 * The HMAC salt is local, random, and persisted only in plugin storage.
 */
export function createAccountIdentity(deps: { storage: StorageLike }): AccountIdentity {
  const { storage } = deps
  let salt: Buffer | null = null
  let saltInflight: Promise<Buffer> | null = null

  async function ensureSalt(): Promise<Buffer> {
    if (salt) return salt
    if (saltInflight) return saltInflight
    saltInflight = (async () => {
      const saved = decodeSalt(await readStorage(storage, ACCOUNT_SALT_KEY))
      if (saved) {
        salt = saved
        return saved
      }
      const fresh = randomBytes(SALT_BYTES)
      // A failed write must not prevent identity: keep a process-local salt instead.
      await writeStorage(storage, ACCOUNT_SALT_KEY, fresh.toString("base64"))
      salt = fresh
      return fresh
    })().finally(() => {
      saltInflight = null
    })
    return saltInflight
  }

  return {
    async accountId(access: string): Promise<string> {
      if (!access) return ""
      const key = await ensureSalt()
      return createHmac("sha256", key).update(access).digest("hex").slice(0, ACCOUNT_ID_HEX_CHARS)
    },
  }
}

export type AccountIdentity = {
  accountId(access: string): Promise<string>
}

export type HistoryStore = {
  load(): Promise<HistoryState>
  get(): HistoryState
  save(account: string, snapshots: UsageSnapshot[]): Promise<void>
  clear(): Promise<void>
}

export function createHistoryStore(deps: { storage: StorageLike }): HistoryStore {
  const { storage } = deps
  let state: HistoryState = { account: "", snapshots: [] }

  async function load(): Promise<HistoryState> {
    const raw = await readStorage(storage, HISTORY_KEY)
    let account = ""
    let snapshots: UsageSnapshot[] = []
    if (Array.isArray(raw)) {
      // Legacy layout: a bare snapshot list with no account tag.
      snapshots = sanitizeSnapshots(raw)
    } else if (raw && typeof raw === "object") {
      const rec = raw as { account?: unknown; snapshots?: unknown }
      if (typeof rec.account === "string") account = rec.account
      snapshots = sanitizeSnapshots(rec.snapshots)
    }
    state = { account, snapshots }
    return state
  }

  function get(): HistoryState {
    return state
  }

  async function save(account: string, snapshots: UsageSnapshot[]): Promise<void> {
    state = { account, snapshots }
    await writeStorage(storage, HISTORY_KEY, { account, snapshots })
  }

  async function clear(): Promise<void> {
    state = { account: "", snapshots: [] }
    await clearStorage(storage, HISTORY_KEY, { account: "", snapshots: [] })
  }

  return { load, get, save, clear }
}
