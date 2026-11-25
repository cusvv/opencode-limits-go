export const EVENT_TYPES = [
  "credential.updated",
  "credential.switched",
  "integration.updated",
  "config.updated",
  "provider.updated",
  "session.usage.updated",
  "session.idle",
] as const

export type LimitsEventKind = "usage" | "credentials" | "ignore"

export function eventIntegrationId(ev: unknown): unknown {
  if (!ev || typeof ev !== "object" || !("data" in ev)) return undefined
  const data = ev.data
  if (!data || typeof data !== "object") return undefined
  if ("integrationID" in data) return data.integrationID
  if ("integrationId" in data) return data.integrationId
  if ("id" in data) return data.id
  return undefined
}

function isCredentialLike(type: string): boolean {
  return type === "credential.updated" || type === "credential.switched" || type === "integration.updated"
}

/** True when an event belongs to a different integration and must not touch our cache. */
export function isForeignIntegrationEvent(ev: unknown, type: string): boolean {
  if (!isCredentialLike(type)) return false
  const integrationId = eventIntegrationId(ev)
  return (
    typeof integrationId === "string" &&
    integrationId !== "" &&
    integrationId !== "opencode" &&
    integrationId !== "opencode-go"
  )
}

export function classifyEvent(ev: unknown): LimitsEventKind {
  const type = ev && typeof ev === "object" && "type" in ev ? ev.type : undefined
  if (typeof type !== "string") return "ignore"
  if (type === "session.usage.updated" || type === "session.idle") return "usage"
  if (isForeignIntegrationEvent(ev, type)) return "ignore"
  if (isCredentialLike(type) || type === "config.updated" || type === "provider.updated") return "credentials"
  return "ignore"
}
