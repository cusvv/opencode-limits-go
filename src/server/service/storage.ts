export type StorageLike = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  /** Optional: fall back to a sentinel value when the host has no delete. */
  remove?(key: string): Promise<void>
}

export async function readStorage(storage: StorageLike, key: string): Promise<unknown> {
  try {
    return await storage.get(key)
  } catch {
    return undefined
  }
}

export async function writeStorage(storage: StorageLike, key: string, value: unknown): Promise<void> {
  try {
    await storage.set(key, value)
  } catch {}
}

/**
 * Removes a key, or overwrites it with a sentinel when the storage backend has no
 * delete. Readers must validate the sentinel and ignore it.
 */
export async function clearStorage(storage: StorageLike, key: string, sentinel: unknown): Promise<void> {
  if (typeof storage.remove === "function") {
    try {
      await storage.remove(key)
      return
    } catch {}
  }
  try {
    await storage.set(key, sentinel)
  } catch {}
}
