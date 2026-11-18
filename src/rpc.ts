import { Rpc } from "@opencode/plugin/rpc"

const rowSchema = {
  type: "object",
  properties: {
    key: { type: "string" },
    label: { type: "string" },
    used: { type: "number" },
    status: { type: "string" },
    resetsAt: { type: "string" },
    resetsAtMs: { type: "number" },
    resetsIn: { type: "string" },
  },
  required: ["label", "used", "status", "resetsAt", "resetsIn"],
} as const

export const Limits = Rpc.define({
  id: "opencode-limits-go",
  methods: {
    status: {
      input: {
        type: "object",
        properties: {
          force: { type: "boolean" },
          lang: { type: "string" },
        },
      } as const,
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          org: { type: "string" },
          email: { type: "string" },
          checkedAt: { type: "string" },
          checkedAtMs: { type: "number" },
          source: { type: "string" },
          rows: { type: "array", items: rowSchema },
          tight: { type: "string" },
          error: { type: "string" },
        },
        required: ["ok", "org", "email", "checkedAt", "source", "rows", "tight", "error"],
      } as const,
    },
    updateStatus: {
      input: {
        type: "object",
        properties: {
          check: { type: "boolean" },
          autoInstall: { type: "boolean" },
        },
      } as const,
      output: {
        type: "object",
        properties: {
          currentVersion: { type: "string" },
          latestVersion: { type: "string" },
          updateAvailable: { type: "boolean" },
          autoUpdated: { type: "boolean" },
          restartRequired: { type: "boolean" },
          releaseUrl: { type: "string" },
          checkedAtMs: { type: "number" },
          error: { type: "string" },
        },
        required: [
          "currentVersion",
          "latestVersion",
          "updateAvailable",
          "autoUpdated",
          "restartRequired",
          "releaseUrl",
          "checkedAtMs",
          "error",
        ],
      } as const,
    },
    installUpdate: {
      input: {
        type: "object",
        properties: {},
      } as const,
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          version: { type: "string" },
          restartRequired: { type: "boolean" },
          error: { type: "string" },
        },
        required: ["ok", "version", "restartRequired", "error"],
      } as const,
    },
    setUpdateConfig: {
      input: {
        type: "object",
        properties: {
          autoUpdate: { type: "boolean" },
        },
        required: ["autoUpdate"],
      } as const,
      output: {
        type: "object",
        properties: {
          autoUpdate: { type: "boolean" },
        },
        required: ["autoUpdate"],
      } as const,
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {},
      } as const,
    },
    updated: {
      schema: {
        type: "object",
        properties: {
          version: { type: "string" },
        },
        required: ["version"],
      } as const,
    },
  },
})
