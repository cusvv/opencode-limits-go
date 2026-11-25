import type { Identity, IdentitySource, Value } from "./types.ts"

export const INTEGRATION_IDS = ["opencode-go", "opencode"] as const
export const DEFAULT_ENV_VARS = ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"] as const

export const text = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined
  const s = v.trim()
  return s || undefined
}

export function isTargetId(id: unknown): id is (typeof INTEGRATION_IDS)[number] {
  return id === "opencode-go" || id === "opencode"
}

export function cleanToken(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  let s = v.trim()
  if (/^Bearer\s+/i.test(s)) s = s.replace(/^Bearer\s+/i, "").trim()
  if (!s || /\s/.test(s)) return undefined
  if (s.startsWith("{") && s.endsWith("}")) return undefined
  return s
}

export function identityFromValue(
  value: Value | undefined | null,
  sourceBase: "integration" | "cli" | "auth.json",
  meta?: { connType?: unknown; method?: unknown; label?: unknown },
): Identity | null {
  if (!value || typeof value !== "object") return null

  let access: string | undefined
  if (value.type === "oauth") {
    access = cleanToken(value.access)
  } else if (value.type === "key" || value.type === "api" || value.type === undefined) {
    access = cleanToken(value.key ?? value.access ?? value.token)
  } else {
    access = cleanToken(value.access ?? value.key)
  }
  if (!access) return null

  let source: IdentitySource
  if (sourceBase === "integration") {
    if (meta?.connType === "env") source = "integration:env"
    else if (value.type === "oauth" || meta?.method === "oauth") source = "integration:oauth"
    else source = "integration:key"
  } else {
    source = sourceBase
  }

  return {
    access,
    email: text(value.metadata?.email),
    org: text(value.metadata?.orgName) ?? text(value.metadata?.org) ?? text(meta?.label),
    source,
  }
}

export function parseCliExport(raw: unknown): Identity[] {
  if (!Array.isArray(raw)) throw new Error("opencode auth export did not return a list")
  return (raw as Array<{ integrationID?: unknown; active?: unknown; label?: unknown; value?: Value }>)
    .filter((c) => isTargetId(c.integrationID))
    .sort((a, b) => {
      const goDiff = Number(b.integrationID === "opencode-go") - Number(a.integrationID === "opencode-go")
      if (goDiff !== 0) return goDiff
      return Number(!!b.active) - Number(!!a.active)
    })
    .map((c) => identityFromValue(c.value, "cli", { label: c.label }))
    .filter((id): id is Identity => id !== null)
}

export function parseLegacyAuth(raw: unknown): Identity[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
  const rec = raw as Record<string, Value | undefined>
  const found: Identity[] = []
  for (const key of INTEGRATION_IDS) {
    const id = identityFromValue(rec[key], "auth.json")
    if (id) found.push(id)
  }
  return found
}
