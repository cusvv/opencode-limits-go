import { Rpc } from "@opencode/plugin/rpc"

const rowSchema = {
  type: "object",
  properties: {
    key: { type: "string", enum: ["rolling", "weekly", "monthly"] },
    label: { type: "string" },
    used: { type: "number" },
    status: { type: "string" },
    resetsAt: { type: "string" },
    resetsAtMs: { type: "number" },
    resetsIn: { type: "string" },
    delta1h: { type: "number" },
    deltaSpanMs: { type: "number" },
  },
  required: ["label", "used", "status", "resetsAt", "resetsIn"],
} as const

const snapshotSchema = {
  type: "object",
  properties: {
    at: { type: "number" },
    rolling: { type: "number" },
    weekly: { type: "number" },
    monthly: { type: "number" },
    resets: {
      type: "object",
      properties: {
        rolling: { type: "number" },
        weekly: { type: "number" },
        monthly: { type: "number" },
      },
    },
  },
  required: ["at"],
} as const

const cardErrorCode = {
  type: "string",
  enum: ["NO_TOKEN", "AUTH", "RATE_LIMIT", "OFFLINE", "BAD_RESPONSE", "CREDENTIALS_CHANGED", "INTERNAL"],
} as const

const cardSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    org: { type: "string" },
    email: { type: "string" },
    checkedAt: { type: "string" },
    checkedAtMs: { type: "number" },
    source: { type: "string" },
    rows: { type: "array", items: rowSchema },
    tight: { type: "string", description: "Deprecated: always empty; UI computes the risk line." },
    error: { type: "string", description: "Deprecated machine code; use errorCode." },
    stale: { type: "boolean" },
    snapshots: { type: "array", items: snapshotSchema },
    accountId: { type: "string" },
    revision: { type: "number" },
    errorCode: { ...cardErrorCode, description: "Authoritative machine-readable error code." },
    errorDetail: { type: "string", description: "Technical, unlocalized failure cause." },
  },
  required: ["ok", "org", "email", "checkedAt", "checkedAtMs", "source", "rows", "tight", "error", "stale"],
} as const

const prefsProperties = {
  rolling: { type: "boolean" },
  weekly: { type: "boolean" },
  monthly: { type: "boolean" },
  showRemaining: { type: "boolean" },
  alerts: { type: "boolean" },
  systemNotifications: { type: "boolean" },
  warnThreshold: { type: "number" },
  burnSpikePct: { type: "number" },
  langOverride: { type: "string", enum: ["auto", "en", "ru"] },
} as const

const prefsRequired = [
  "rolling",
  "weekly",
  "monthly",
  "showRemaining",
  "alerts",
  "systemNotifications",
  "warnThreshold",
  "burnSpikePct",
  "langOverride",
] as const

const prefsOutputSchema = {
  type: "object",
  properties: { ...prefsProperties, autoUpdate: { type: "boolean" } },
  required: [...prefsRequired, "autoUpdate"],
} as const

export const Limits = Rpc.define({
  id: "opencode-limits-go",
  methods: {
    status: {
      input: {
        type: "object",
        properties: {
          force: { type: "boolean" },
          lang: {
            type: "string",
            deprecated: true,
            description: "Deprecated: ignored. Cards are language-neutral; UIs localize on render.",
          },
          maxAgeMs: { type: "number" },
        },
      } as const,
      output: cardSchema,
    },
    getPrefs: {
      input: {
        type: "object",
        properties: {},
      } as const,
      output: prefsOutputSchema,
    },
    setPrefs: {
      input: {
        type: "object",
        properties: prefsProperties,
      } as const,
      output: prefsOutputSchema,
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
          managedByPackageManager: { type: "boolean" },
          managedByDev: { type: "boolean" },
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
    diagnostics: {
      input: {
        type: "object",
        properties: {},
      } as const,
      output: {
        type: "object",
        properties: {
          version: { type: "string" },
          cache: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              ageMs: { type: "number" },
              source: { type: "string" },
              accountId: { type: "string" },
              revision: { type: "number" },
            },
            required: ["ok", "ageMs", "source"],
          },
          history: {
            type: "object",
            properties: {
              count: { type: "number" },
              accountId: { type: "string" },
            },
            required: ["count"],
          },
          prefs: {
            type: "object",
            properties: {
              keys: { type: "array", items: { type: "string" } },
            },
            required: ["keys"],
          },
          updater: {
            type: "object",
            properties: {
              currentVersion: { type: "string" },
              latestVersion: { type: "string" },
              updateAvailable: { type: "boolean" },
              managedByDev: { type: "boolean" },
              managedByPackageManager: { type: "boolean" },
              error: { type: "string" },
            },
            required: [
              "currentVersion",
              "latestVersion",
              "updateAvailable",
              "managedByDev",
              "managedByPackageManager",
              "error",
            ],
          },
          resetInMs: { type: "number" },
        },
        required: ["version", "cache", "history", "prefs", "updater"],
      } as const,
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          reason: { type: "string", enum: ["credentials", "reset", "usage"] },
          accountId: { type: "string" },
          revision: { type: "number" },
        },
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
    prefsChanged: {
      schema: {
        type: "object",
        properties: {
          prefs: {
            type: "object",
            properties: prefsProperties,
            required: prefsRequired,
          },
          autoUpdate: { type: "boolean" },
        },
        required: ["prefs", "autoUpdate"],
      } as const,
    },
  },
})
