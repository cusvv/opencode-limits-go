import {
  mergeSharedPrefs,
  sanitizeSharedPrefs,
  type SharedPrefs,
  type SharedPrefsPatch,
} from "../../settings/index.ts"
import { readStorage, writeStorage, type StorageLike } from "./storage.ts"

export {
  LANG_OVERRIDES,
  SHARED_PREFS_DEFAULTS,
  isLangOverride,
  mergeSharedPrefs,
  sanitizeSharedPrefs,
  type LangOverride,
  type SharedPrefs,
  type SharedPrefsPatch,
} from "../../settings/index.ts"

export const SHARED_PREFS_KEY = "sharedPrefs:v1"

export type PrefsStore = {
  init(): Promise<SharedPrefs>
  get(): SharedPrefs
  set(raw: unknown): Promise<SharedPrefs>
}

export function createPrefsStore(deps: { storage: StorageLike; options?: Record<string, unknown> }): PrefsStore {
  const { storage, options } = deps
  let value: SharedPrefs = mergeSharedPrefs()

  async function init(): Promise<SharedPrefs> {
    const saved = sanitizeSharedPrefs(await readStorage(storage, SHARED_PREFS_KEY))
    const fromOptions = sanitizeSharedPrefs(options)
    // Priority: storage > plugin options > defaults.
    value = mergeSharedPrefs(fromOptions, saved)
    return value
  }

  function get(): SharedPrefs {
    return { ...value }
  }

  async function set(raw: unknown): Promise<SharedPrefs> {
    const patch: SharedPrefsPatch = sanitizeSharedPrefs(raw)
    if (Object.keys(patch).length > 0) {
      value = mergeSharedPrefs(value, patch)
      await writeStorage(storage, SHARED_PREFS_KEY, value)
    }
    return { ...value }
  }

  return { init, get, set }
}
