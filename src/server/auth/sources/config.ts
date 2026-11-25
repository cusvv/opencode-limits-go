import { errorText } from "../../../core/index.ts"
import { log } from "../../log.ts"
import { DEFAULT_ENV_VARS, cleanToken, isTargetId, text } from "../identity.ts"
import type { Identity, ProviderLike } from "../types.ts"

function tokenFromObject(obj: unknown): string | undefined {
  if (!obj || typeof obj !== "object") return undefined
  const rec = obj as Record<string, unknown>
  return cleanToken(rec.token ?? rec.apiKey ?? rec.api_key ?? rec.key)
}

function tokenFromHeaders(headers: unknown): string | undefined {
  if (!headers || typeof headers !== "object") return undefined
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    const lower = k.toLowerCase()
    if (lower === "authorization") {
      if (typeof v === "string" && /^\s*Bearer\s+/i.test(v)) {
        const tok = cleanToken(v)
        if (tok) return tok
      }
    } else if (lower === "x-api-key" || lower === "api-key") {
      const tok = cleanToken(v)
      if (tok) return tok
    }
  }
  return undefined
}

function extractProviderList(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>
  if (!res || typeof res !== "object") return []
  const obj = res as { data?: unknown; all?: unknown }
  if (Array.isArray(obj.data)) return obj.data as Array<Record<string, unknown>>
  if (obj.data && typeof obj.data === "object") {
    const nested = (obj.data as { all?: unknown }).all
    if (Array.isArray(nested)) return nested as Array<Record<string, unknown>>
  }
  if (Array.isArray(obj.all)) return obj.all as Array<Record<string, unknown>>
  return []
}

export async function fromConfigAndProvider(
  options: Record<string, unknown> | undefined,
  provider: ProviderLike | undefined,
): Promise<{ identities: Identity[]; envNames: string[] }> {
  const identities: Identity[] = []
  const envNames: string[] = []

  const optToken = tokenFromObject(options)
  if (optToken) {
    identities.push({ access: optToken, org: "OpenCode Go", source: "config" })
  }

  if (typeof provider?.list === "function") {
    try {
      const all = extractProviderList(await provider.list())
      const matching = all
        .filter((p) => isTargetId(p.id) || isTargetId(p.canonical) || isTargetId(p.integrationID))
        .sort((a, b) => Number(b.id === "opencode-go") - Number(a.id === "opencode-go"))

      for (const p of matching) {
        if (Array.isArray(p.env)) {
          for (const name of p.env) {
            if (typeof name === "string" && name.trim()) envNames.push(name.trim())
          }
        }
        const tok =
          tokenFromObject(p.settings) ??
          tokenFromObject(p.options) ??
          tokenFromHeaders(p.headers) ??
          tokenFromObject(p)
        if (tok) {
          identities.push({
            access: tok,
            org: text(p.name) ?? "OpenCode Go",
            source: "config",
          })
        }
      }
    } catch (error) {
      log("provider list failed", { error: errorText(error) })
    }
  }

  return { identities, envNames }
}

export function fromEnv(env: Record<string, string | undefined>, extraNames: string[]): Identity[] {
  const seen = new Set<string>()
  const names = [...DEFAULT_ENV_VARS, ...extraNames].filter((name) => {
    if (seen.has(name)) return false
    seen.add(name)
    return true
  })

  const found: Identity[] = []
  for (const name of names) {
    const tok = cleanToken(env[name])
    if (tok) found.push({ access: tok, org: "OpenCode Go", source: "env" })
  }
  return found
}
