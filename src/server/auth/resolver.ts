import { errorText } from "../../core/index.ts"
import { log } from "../log.ts"
import { parseCliExport, parseLegacyAuth } from "./identity.ts"
import { fromConfigAndProvider, fromEnv } from "./sources/config.ts"
import { defaultRunCli } from "./sources/cli.ts"
import { fromIntegration } from "./sources/integration.ts"
import { defaultReadLegacyAuth } from "./sources/legacy.ts"
import type { CredentialsDeps, Identity } from "./types.ts"

function dedupe(list: Identity[]): Identity[] {
  const seen = new Set<string>()
  return list.filter((id) => {
    if (seen.has(id.access)) return false
    seen.add(id.access)
    return true
  })
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const CLI_TTL_MS = 10 * 60_000
const HOST_HOOK_TIMEOUT_MS = 8_000

export function createCredentials(deps: CredentialsDeps = {}) {
  const env = deps.env ?? process.env
  const runCli = deps.runCli ?? defaultRunCli
  const readLegacy = deps.readLegacyAuth ?? (() => defaultReadLegacyAuth(env))
  let cli: Identity[] | null = null
  let cliAt = 0
  // A completed CLI probe (even an empty or failed one) is cached for CLI_TTL_MS.
  let cliProbed = false
  let cliInflight: Promise<Identity[]> | null = null
  let cliGeneration = 0

  async function listPrimary(): Promise<Identity[]> {
    const [fromInt, fromCfg] = await Promise.all([
      withTimeout(fromIntegration(deps.integration), HOST_HOOK_TIMEOUT_MS, [] as Identity[]),
      withTimeout(fromConfigAndProvider(deps.options, deps.provider), HOST_HOOK_TIMEOUT_MS, {
        identities: [] as Identity[],
        envNames: [] as string[],
      }),
    ])
    const envList = fromEnv(env, fromCfg.envNames)
    return dedupe([...fromInt, ...fromCfg.identities, ...envList])
  }

  function loadCli(): Promise<Identity[]> {
    if (cliInflight) return cliInflight
    const generation = cliGeneration
    const run = (async (): Promise<Identity[]> => {
      let parsed: Identity[] = []
      try {
        parsed = parseCliExport(await withTimeout(runCli(), 8_000, null))
      } catch (error) {
        log("cli export failed", { error: errorText(error) })
        parsed = []
      }
      // Cache empty and failed results too: a broken CLI must not be spawned on every poll.
      if (generation === cliGeneration) {
        cli = parsed.length ? parsed : null
        cliAt = Date.now()
        cliProbed = true
        cliInflight = null
      }
      return parsed
    })()
    cliInflight = run
    return run
  }

  async function listFallback(opts: { freshCli?: boolean } = {}): Promise<Identity[]> {
    const cliExpired = Date.now() - cliAt > CLI_TTL_MS
    const cliCached = cliProbed && !cliExpired
    const cliWasCached = !opts.freshCli && cliCached && (cli?.length ?? 0) > 0
    if (opts.freshCli || !cliCached) {
      await loadCli()
    }
    const cliEntries = (cli ?? []).map((id) => ({ ...id, cached: cliWasCached }))

    let legacy: Identity[] = []
    try {
      legacy = parseLegacyAuth(await readLegacy())
    } catch (error) {
      log("legacy auth.json failed", { error: errorText(error) })
    }

    return dedupe([...cliEntries, ...legacy])
  }

  return {
    listPrimary,
    listFallback,
    async list(): Promise<Identity[]> {
      return dedupe([...(await listPrimary()), ...(await listFallback())])
    },
    dropCli() {
      cliGeneration++
      cli = null
      cliAt = 0
      cliProbed = false
      cliInflight = null
    },
  }
}
