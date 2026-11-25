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

export type Value = {
  type?: unknown
  access?: unknown
  key?: unknown
  token?: unknown
  metadata?: { email?: unknown; orgName?: unknown; org?: unknown }
}
