import { errorText } from "../../../core/index.ts"
import { log } from "../../log.ts"
import { identityFromValue, INTEGRATION_IDS } from "../identity.ts"
import type { ConnectionLike, Identity, IntegrationLike, Value } from "../types.ts"

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

export async function fromIntegration(integration: IntegrationLike | undefined): Promise<Identity[]> {
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
