import { test } from "node:test"
import assert from "node:assert/strict"
import { cleanToken, createCredentials, parseCliExport, parseLegacyAuth } from "./auth.ts"

test("cleanToken trims, strips Bearer prefix, and rejects placeholders or whitespace", () => {
  assert.equal(cleanToken("  Bearer sk-abc123  "), "sk-abc123")
  assert.equal(cleanToken("st_token_1"), "st_token_1")
  assert.equal(cleanToken("{env:OPENCODE_API_KEY}"), undefined)
  assert.equal(cleanToken("bad token with spaces"), undefined)
  assert.equal(cleanToken(""), undefined)
})

test("createCredentials supports API-key-only in opencode-go integration without invoking CLI", async () => {
  let cliCalls = 0
  const creds = createCredentials({
    integration: {
      connection: {
        active: async (id) =>
          id === "opencode-go" ? { type: "credential", id: "c1", label: "Go Key", method: "key" } : undefined,
        resolve: async () => ({ type: "key", key: "sk-go-only" }),
      },
    },
    env: {},
    runCli: async () => {
      cliCalls++
      return []
    },
    readLegacyAuth: async () => null,
  })

  const primary = await creds.listPrimary()
  assert.equal(primary.length, 1)
  assert.equal(primary[0].access, "sk-go-only")
  assert.equal(primary[0].source, "integration:key")
  assert.equal(primary[0].org, "Go Key")
  assert.equal(cliCalls, 0)
})

test("createCredentials prioritizes active credentials over env and inspects non-active connections", async () => {
  const creds = createCredentials({
    integration: {
      connection: {
        active: async (id) => {
          if (id === "opencode-go") return { type: "env", name: "OPENCODE_API_KEY" }
          if (id === "opencode") return { type: "credential", id: "c_oauth", label: "Personal", method: "oauth" }
          return undefined
        },
        resolve: async (conn: { id?: string; name?: string }) => {
          if (conn.id === "c_oauth") {
            return { type: "oauth", access: "st_active_oauth", metadata: { email: "a@b.c", orgName: "Personal" } }
          }
          if (conn.name === "OPENCODE_API_KEY") {
            return { type: "key", key: "sk-env-key" }
          }
          if (conn.id === "c_backup") {
            return { type: "key", key: "sk-backup-key" }
          }
          return undefined
        },
      },
      get: async ({ integrationID }) => {
        if (integrationID === "opencode-go") {
          return {
            data: {
              connections: [
                { type: "env", name: "OPENCODE_API_KEY" },
                { type: "credential", id: "c_backup", label: "Backup", method: "key" },
              ],
            },
          }
        }
        return { data: { connections: [] } }
      },
    },
    env: { OPENCODE_API_KEY: "sk-env-key" },
    readLegacyAuth: async () => null,
  })

  const primary = await creds.listPrimary()
  assert.deepEqual(
    primary.map((c) => [c.access, c.source]),
    [
      ["st_active_oauth", "integration:oauth"],
      ["sk-env-key", "integration:env"],
      ["sk-backup-key", "integration:key"],
    ],
  )
})

test("createCredentials supports env, plugin options, and provider config tokens", async () => {
  const creds = createCredentials({
    options: { token: "sk-plugin-opt" },
    provider: {
      list: async () => ({
        data: [
          {
            id: "opencode-go",
            name: "OpenCode Go",
            env: ["CUSTOM_GO_KEY"],
            settings: { apiKey: "sk-provider-settings" },
          },
          {
            id: "opencode",
            name: "OpenCode",
            headers: { Authorization: "Bearer sk-provider-header" },
          },
        ],
      }),
    },
    env: {
      OPENCODE_API_KEY: "sk-env-default",
      CUSTOM_GO_KEY: "sk-env-custom",
    },
    readLegacyAuth: async () => null,
  })

  const primary = await creds.listPrimary()
  assert.deepEqual(
    primary.map((c) => [c.access, c.source]),
    [
      ["sk-plugin-opt", "config"],
      ["sk-provider-settings", "config"],
      ["sk-provider-header", "config"],
      ["sk-env-default", "env"],
      ["sk-env-custom", "env"],
    ],
  )
})

test("createCredentials caches CLI export until dropCli and supports key + oauth in fallback", async () => {
  let cliCalls = 0
  const creds = createCredentials({
    env: {},
    runCli: async () => {
      cliCalls++
      return [
        { integrationID: "google", active: true, value: { type: "key", key: "google-key" } },
        { integrationID: "opencode", active: true, value: { type: "oauth", access: "st_cli_oauth" } },
        { integrationID: "opencode-go", active: false, label: "Go CLI", value: { type: "key", key: "sk-cli-go" } },
      ]
    },
    readLegacyAuth: async () => ({
      opencode: { type: "api", key: "sk-legacy-api" },
    }),
  })

  const first = await creds.listFallback()
  assert.equal(cliCalls, 1)
  assert.deepEqual(
    first.map((c) => [c.access, c.source, c.cached]),
    [
      ["sk-cli-go", "cli", false],
      ["st_cli_oauth", "cli", false],
      ["sk-legacy-api", "auth.json", undefined],
    ],
  )

  const second = await creds.listFallback()
  assert.equal(cliCalls, 1)
  assert.equal(second[0].cached, true)

  creds.dropCli()
  const third = await creds.listFallback()
  assert.equal(cliCalls, 2)
  assert.equal(third[0].cached, false)
})

test("parseCliExport and parseLegacyAuth ignore invalid entries", () => {
  assert.deepEqual(parseCliExport([{ integrationID: "opencode", value: { type: "external" } }]), [])
  assert.deepEqual(
    parseLegacyAuth({ "opencode-go": { type: "key", key: "sk-1" }, opencode: { type: "oauth", access: "st_2" } }).map(
      (i) => i.access,
    ),
    ["sk-1", "st_2"],
  )
})

test("createCredentials caches an empty CLI export instead of probing on every call", async () => {
  let cliCalls = 0
  const creds = createCredentials({
    env: {},
    runCli: async () => {
      cliCalls++
      return []
    },
    readLegacyAuth: async () => null,
  })

  await creds.listFallback()
  await creds.listFallback()
  await creds.listFallback()
  assert.equal(cliCalls, 1)
})

test("createCredentials shares one in-flight CLI probe between concurrent fallback calls", async () => {
  let cliCalls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const creds = createCredentials({
    env: {},
    runCli: async () => {
      cliCalls++
      await gate
      return [{ integrationID: "opencode-go", active: true, value: { type: "key", key: "sk-parallel" } }]
    },
    readLegacyAuth: async () => null,
  })

  const first = creds.listFallback()
  const second = creds.listFallback()
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(cliCalls, 1)
  assert.deepEqual(a.map((c) => c.access), ["sk-parallel"])
  assert.deepEqual(b.map((c) => c.access), ["sk-parallel"])
})

test("createCredentials does not retry a failed CLI probe within the cache TTL", async () => {
  let cliCalls = 0
  const creds = createCredentials({
    env: {},
    runCli: async () => {
      cliCalls++
      throw new Error("opencode auth export failed")
    },
    readLegacyAuth: async () => null,
  })

  await creds.listFallback()
  await creds.listFallback()
  await creds.listFallback()
  assert.equal(cliCalls, 1)
})

test("createCredentials dropCli forces a fresh probe after a cached empty result", async () => {
  let cliCalls = 0
  const creds = createCredentials({
    env: {},
    runCli: async () => {
      cliCalls++
      return []
    },
    readLegacyAuth: async () => null,
  })

  await creds.listFallback()
  await creds.listFallback()
  assert.equal(cliCalls, 1)
  creds.dropCli()
  await creds.listFallback()
  assert.equal(cliCalls, 2)
})
