import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { errorText } from "../core/index.ts"
import { log } from "./log.ts"

const exec = promisify(execFile)

const INTEGRATION_IDS = ["opencode-go", "opencode"] as const
const DEFAULT_ENV_VARS = ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"] as const

export type IdentitySource =
  | "integration:oauth"
  | "integration:key"
  | "integration:env"
  | "config"
  | "env"
  | "cli"
  | "auth.json"

export type Identity = {
  access: string
  email?: string
  org?: string
  source: IdentitySource
  cached?: boolean
}

export type ConnectionLike = {
  type?: unknown
  id?: unknown
  label?: unknown
  method?: unknown
  name?: unknown
}

// Narrow view of ctx.integration: active/resolve plus optional get/list to inspect all connections.
export type IntegrationLike = {
  connection?: {
    active?(integrationID: string): Promise<ConnectionLike | undefined>
    resolve?(connection: any): Promise<any>
  }
  get?(input: { integrationID: string }): Promise<any>
  list?(): Promise<any>
}

export type ProviderLike = {
  list?(): Promise<any>
}

export type CredentialsDeps = {
  integration?: IntegrationLike
  provider?: ProviderLike
  options?: Record<string, unknown>
  env?: Record<string, string | undefined>
  runCli?: () => Promise<unknown>
  readLegacyAuth?: () => Promise<unknown>
}

type Value = {
  type?: unknown
  access?: unknown
  key?: unknown
  token?: unknown
  metadata?: { email?: unknown; orgName?: unknown; org?: unknown }
}

const text = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined
  const s = v.trim()
  return s || undefined
}

export function cleanToken(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  let s = v.trim()
  if (/^Bearer\s+/i.test(s)) s = s.replace(/^Bearer\s+/i, "").trim()
  if (!s || /\s/.test(s)) return undefined
  if (s.startsWith("{") && s.endsWith("}")) return undefined
  return s
}

function isTargetId(id: unknown): id is (typeof INTEGRATION_IDS)[number] {
  return id === "opencode-go" || id === "opencode"
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

function connKey(integrationID: string, conn: ConnectionLike, fallbackIndex: number): string {
  if (conn.type === "credential" && typeof conn.id === "string" && conn.id) return `cred:${conn.id}`
  if (conn.type === "env" && typeof conn.name === "string" && conn.name) return `env:${conn.name}`
  return `other:${integrationID}:${fallbackIndex}`
}

function extractConnections(res: unknown): ConnectionLike[] {
  if (!res || typeof res !== "object") return []
  const obj = res as { data?: { connections?: unknown }; connections?: unknown }
  const list = obj.data?.connections ?? obj.connections
  return Array.isArray(list) ? (list as ConnectionLike[]) : []
}

function extractIntegrationList(res: unknown): Array<{ id?: unknown; connections?: unknown }> {
  if (Array.isArray(res)) return res as Array<{ id?: unknown; connections?: unknown }>
  if (res && typeof res === "object") {
    const data = (res as { data?: unknown }).data
    if (Array.isArray(data)) return data as Array<{ id?: unknown; connections?: unknown }>
  }
  return []
}

async function fromIntegration(integration: IntegrationLike | undefined): Promise<Identity[]> {
  const resolve = integration?.connection?.resolve
  if (!integration?.connection || typeof resolve !== "function") return []

  const found: Identity[] = []
  const seenConns = new Set<string>()

  // 1. Resolve active connections first, preferring explicit credentials over env, and opencode-go over opencode.
  const actives: Array<{ integrationID: string; conn: ConnectionLike; rank: number }> = []
  if (typeof integration.connection.active === "function") {
    for (const integrationID of INTEGRATION_IDS) {
      try {
        const conn = await integration.connection.active(integrationID)
        if (!conn) continue
        const rank = (conn.type === "env" ? 2 : 0) + (integrationID === "opencode-go" ? 0 : 1)
        actives.push({ integrationID, conn, rank })
      } catch (error) {
        log("integration active unavailable", { integrationID, error: errorText(error) })
      }
    }
    actives.sort((a, b) => a.rank - b.rank)
    for (const [idx, item] of actives.entries()) {
      const key = connKey(item.integrationID, item.conn, idx)
      if (seenConns.has(key)) continue
      seenConns.add(key)
      try {
        const value = (await resolve(item.conn)) as Value | undefined
        const id = identityFromValue(value, "integration", {
          connType: item.conn.type,
          method: item.conn.method,
          label: item.conn.label,
        })
        if (id) found.push(id)
      } catch (error) {
        log("integration resolve unavailable", { integrationID: item.integrationID, error: errorText(error) })
      }
    }
  }

  // 2. Also inspect all listed connections in case the active one is missing or lacks Go access.
  let cachedList: Array<{ id?: unknown; connections?: unknown }> | null = null
  for (const integrationID of INTEGRATION_IDS) {
    let connections: ConnectionLike[] = []
    if (typeof integration.get === "function") {
      try {
        connections = extractConnections(await integration.get({ integrationID }))
      } catch (error) {
        log("integration get failed", { integrationID, error: errorText(error) })
      }
    }
    if (!connections.length && typeof integration.list === "function") {
      try {
        if (!cachedList) cachedList = extractIntegrationList(await integration.list())
        const entry = cachedList.find((item) => item.id === integrationID)
        connections = extractConnections(entry)
      } catch (error) {
        log("integration list failed", { integrationID, error: errorText(error) })
      }
    }
    for (const [idx, conn] of connections.entries()) {
      const key = connKey(integrationID, conn, idx)
      if (seenConns.has(key)) continue
      seenConns.add(key)
      try {
        const value = (await resolve(conn)) as Value | undefined
        const id = identityFromValue(value, "integration", {
          connType: conn.type,
          method: conn.method,
          label: conn.label,
        })
        if (id) found.push(id)
      } catch (error) {
        log("integration connection resolve failed", { integrationID, error: errorText(error) })
      }
    }
  }

  return found
}

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

async function fromConfigAndProvider(
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

function fromEnv(env: Record<string, string | undefined>, extraNames: string[]): Identity[] {
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

async function defaultRunCli(): Promise<unknown> {
  const win = process.platform === "win32"
  const command = win ? "cmd.exe" : "sh"
  const args = win ? ["/d", "/c", "opencode auth export"] : ["-c", "opencode auth export"]
  const { stdout } = await exec(command, args, {
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  // JSON.parse errors can quote a fragment of stdout containing tokens: do not rethrow the original error.
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error("opencode auth export did not return JSON")
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

async function defaultReadLegacyAuth(env: Record<string, string | undefined>): Promise<unknown> {
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

function dedupe(list: Identity[]): Identity[] {
  const seen = new Set<string>()
  return list.filter((id) => {
    if (seen.has(id.access)) return false
    seen.add(id.access)
    return true
  })
}

export function createCredentials(deps: CredentialsDeps = {}) {
  const env = deps.env ?? process.env
  const runCli = deps.runCli ?? defaultRunCli
  const readLegacy = deps.readLegacyAuth ?? (() => defaultReadLegacyAuth(env))
  let cli: Identity[] | null = null

  async function listPrimary(): Promise<Identity[]> {
    const [fromInt, fromCfg] = await Promise.all([
      fromIntegration(deps.integration),
      fromConfigAndProvider(deps.options, deps.provider),
    ])
    const envList = fromEnv(env, fromCfg.envNames)
    return dedupe([...fromInt, ...fromCfg.identities, ...envList])
  }

  async function listFallback(opts: { freshCli?: boolean } = {}): Promise<Identity[]> {
    const cliWasCached = !opts.freshCli && cli !== null
    if (opts.freshCli || cli === null) {
      try {
        const parsed = parseCliExport(await runCli())
        cli = parsed.length ? parsed : null
      } catch (error) {
        log("cli export failed", { error: errorText(error) })
        cli = null
      }
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
      cli = null
    },
  }
}
