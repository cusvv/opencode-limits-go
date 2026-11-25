import { test } from "node:test"
import assert from "node:assert/strict"
import { Limits } from "../rpc.ts"
import { Limits as ContractLimits } from "../rpc/contract.ts"
import { HttpError } from "./api.ts"
import { createLimitsService, type LimitsUpdater } from "./service/service.ts"
import type { UpdateStatus } from "./updater.ts"

/**
 * Minimal JSON-schema validator for the shapes this contract uses:
 * type, required, properties, items, enum. No dependency, no $ref, no anyOf.
 */
function validate(schema: unknown, value: unknown, path = "$"): string[] {
  const errors: string[] = []
  if (!schema || typeof schema !== "object") return errors

  if ("enum" in schema && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`)
  }

  const type = "type" in schema && typeof schema.type === "string" ? schema.type : undefined
  if (type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path}: expected object`)
      return errors
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`)
      return errors
    }
    if ("items" in schema) {
      value.forEach((item, index) => errors.push(...validate(schema.items, item, `${path}[${index}]`)))
    }
    return errors
  } else if (type === "string") {
    if (typeof value !== "string") errors.push(`${path}: expected string`)
    return errors
  } else if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${path}: expected number`)
    return errors
  } else if (type === "boolean") {
    if (typeof value !== "boolean") errors.push(`${path}: expected boolean`)
    return errors
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) return errors
  // The value was just checked to be a non-array object, so reading own properties is safe.
  const record = value as Record<string, unknown>

  if ("required" in schema && Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key === "string" && record[key] === undefined) errors.push(`${path}.${key}: required`)
    }
  }
  if ("properties" in schema) {
    const properties: unknown = schema.properties
    if (properties && typeof properties === "object") {
      for (const [key, child] of Object.entries(properties)) {
        if (record[key] !== undefined) errors.push(...validate(child, record[key], `${path}.${key}`))
      }
    }
  }
  return errors
}

function assertConforms(label: string, schema: unknown, value: unknown): void {
  const errors = validate(schema, value)
  assert.deepEqual(errors, [], `${label}: ${errors.join("; ")}`)
}

function memoryStorage(initial: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(initial))
  return {
    map,
    get: async (key: string) => map.get(key),
    set: async (key: string, value: unknown) => {
      map.set(key, value)
    },
    remove: async (key: string) => {
      map.delete(key)
    },
  }
}

function usagePayload(percent: number) {
  return {
    usage: {
      rolling: { percent, resetInSec: 3_600 },
      weekly: { percent: Math.min(100, percent + 5), resetInSec: 86_400 },
      monthly: { percent: Math.min(100, percent + 10), resetInSec: 30 * 86_400 },
    },
  }
}

const UPDATE_STATUS: UpdateStatus = {
  currentVersion: "1.7.1",
  latestVersion: "1.7.2",
  updateAvailable: true,
  autoUpdated: false,
  restartRequired: false,
  managedByPackageManager: false,
  managedByDev: true,
  releaseUrl: "https://github.com/cusvv/opencode-limits-go/releases/tag/v1.7.2",
  checkedAtMs: 1_700_000_000_000,
  error: "",
}

function fakeUpdater(): LimitsUpdater {
  return {
    check: async () => UPDATE_STATUS,
    install: async () => ({ ok: true, version: "1.7.2", restartRequired: true, error: "" }),
    currentVersion: async () => "1.7.1",
  }
}

async function buildService(options: { fetchUsage: () => Promise<unknown>; emits?: Array<{ name: string; data: unknown }> }) {
  const emits = options.emits ?? []
  const service = createLimitsService({
    storage: memoryStorage(),
    credentials: {
      listPrimary: async () => [{ access: "tok_contract", org: "Acme", email: "a@b.c", source: "env" }],
      listFallback: async () => [],
      dropCli: () => {},
    },
    fetchUsage: options.fetchUsage,
    log: () => {},
    updater: fakeUpdater(),
    emit: (name, data) => {
      emits.push({ name, data })
    },
  })
  await service.init()
  return { service, emits }
}

test("rpc.ts is a thin re-export of the contract", () => {
  assert.equal(Limits, ContractLimits)
})

test("success card, prefs, diagnostics, update status, and install result conform", async () => {
  const { service } = await buildService({ fetchUsage: async () => usagePayload(10) })
  const card = await service.status({ force: true, lang: "en" })
  assert.equal(card.ok, true)
  assert.equal(card.tight, "")
  assert.equal(card.error, "")
  assert.deepEqual(card.rows.map((row) => row.label), ["5h", "1w", "1m"])
  assert.ok(card.rows.every((row) => row.resetsIn === ""))
  assert.ok(card.rows.every((row) => /^\d{2}\.\d{2} \d{2}:\d{2}$/.test(row.resetsAt)))
  assertConforms("status success", Limits.methods.status.output, card)

  const prefs = await service.getPrefs()
  assertConforms("getPrefs", Limits.methods.getPrefs.output, prefs)
  const saved = await service.setPrefs({ showRemaining: true })
  assertConforms("setPrefs", Limits.methods.setPrefs.output, saved)

  const diagnostics = await service.diagnostics()
  assertConforms("diagnostics", Limits.methods.diagnostics.output, diagnostics)

  const updateStatus = await service.updateStatus({ check: true })
  assertConforms("updateStatus", Limits.methods.updateStatus.output, updateStatus)

  const installed = await service.installUpdate()
  assertConforms("installUpdate", Limits.methods.installUpdate.output, installed)

  const updateConfig = await service.setUpdateConfig({ autoUpdate: false })
  assertConforms("setUpdateConfig", Limits.methods.setUpdateConfig.output, updateConfig)
  await service.dispose()
})

test("error card conforms and uses the additive errorCode enum", async () => {
  const { service } = await buildService({
    fetchUsage: async () => {
      throw new HttpError(401, "bad token")
    },
  })
  const card = await service.status({ force: true, lang: "en" })
  assert.equal(card.ok, false)
  assert.equal(card.errorCode, "AUTH")
  assert.equal(card.error, "AUTH")
  assert.equal(card.tight, "")
  assert.equal(card.rows.length, 0)
  assertConforms("status error", Limits.methods.status.output, card)
  await service.dispose()
})

test("changed and prefsChanged events conform to their schemas", async () => {
  const emits: Array<{ name: string; data: unknown }> = []
  const { service } = await buildService({
    fetchUsage: async () => usagePayload(10),
    emits,
  })
  await service.status({ force: true, lang: "en" })

  await service.handleEvent({ type: "credential.updated" })
  const changed = emits.find((entry) => entry.name === "changed")
  assert.ok(changed)
  assertConforms("changed", Limits.events.changed.schema, changed.data)
  assert.deepEqual(changed.data, { reason: "credentials", revision: 1 })

  await service.setPrefs({ alerts: false })
  const prefsChanged = emits.find((entry) => entry.name === "prefsChanged")
  assert.ok(prefsChanged)
  assertConforms("prefsChanged", Limits.events.prefsChanged.schema, prefsChanged.data)

  assertConforms("updated", Limits.events.updated.schema, { version: "1.7.2" })
  await service.dispose()
})
