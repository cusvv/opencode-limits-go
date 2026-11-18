import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { Limits } from "./rpc.ts"
import { log } from "./log.ts"
import {
  type LimitCard,
  type Locale,
  alertMessage,
  cardDetail,
  cardText,
  emptyCard,
  errorText,
  newAlerts,
  normalizeLocale,
  retry,
} from "./model.ts"

const COPY = {
  en: {
    title: "OpenCode Go limits",
    loading: "limits: …",
    noServer: "cannot reach plugin server",
    failed: "Failed to load limits",
    updated: (v: string) => `zen-limits updated to v${v}. Run /reload to apply.`,
  },
  ru: {
    title: "Лимиты OpenCode Go",
    loading: "лимиты: …",
    noServer: "нет связи с сервером плагина",
    failed: "Не удалось получить лимиты",
    updated: (v: string) => `zen-limits обновлён до v${v}. Выполните /reload.`,
  },
} as const

export default Plugin.define({
  id: "zen-limits.tui",
  setup(ctx) {
    const lang: Locale = normalizeLocale(
      typeof ctx.options.lang === "string"
        ? ctx.options.lang
        : process.env.OPENCODE_LANG || process.env.LC_ALL || process.env.LANG,
    )
    const copy = COPY[lang]

    const [card, setCard] = createSignal<LimitCard | null>(null)
    const notified = new Map<string, number>()
    const stopCtrl = new AbortController()
    let notifiedVersion = ""

    async function refresh(force = false): Promise<LimitCard | null> {
      if (stopCtrl.signal.aborted) return null
      try {
        const result = (await ctx.client.rpc(Limits).status({ force, lang }, { signal: stopCtrl.signal })) as LimitCard
        if (stopCtrl.signal.aborted) return null
        setCard(result)
        if (result.ok) {
          const now = Date.now()
          for (const row of newAlerts(result.rows, notified)) {
            ctx.ui.toast.show({
              message: alertMessage(row, now, lang),
              variant: row.used >= 100 ? "error" : "warning",
            })
          }
        }
        return result
      } catch (error) {
        if (stopCtrl.signal.aborted) return null
        log("tui status failed", { error: errorText(error, "en") })
        setCard(emptyCard(copy.noServer))
        return null
      }
    }

    void retry(() => refresh(), (result) => result !== null, 5, undefined, stopCtrl.signal)

    const timer = setInterval(() => void refresh(), 90_000)

    const text = () => {
      const current = card()
      return current ? cardText(current, lang) : copy.loading
    }

    const fgColor = () => {
      const current = card()
      if (!current) return ctx.theme.text.muted
      if (!current.ok) return ctx.theme.text.feedback.error.base
      const max = current.rows.reduce((acc, row) => Math.max(acc, row.used), 0)
      if (max >= 100) return ctx.theme.text.feedback.error.base
      if (max >= 80) return ctx.theme.text.feedback.warning.base
      return ctx.theme.text.base
    }

    const unslot = ctx.ui.slot({
      append: "sidebar.content",
      render: () => (
        <box>
          <text fg={fgColor()}>{text()}</text>
        </box>
      ),
    })

    const stopUsage = ctx.data.on("session.usage.updated", () => {
      void refresh()
    })

    let stopChanged: (() => void) | undefined
    let stopUpdated: (() => void) | undefined
    try {
      const rpcClient = ctx.client.rpc(Limits) as {
        events?: {
          on?: (
            name: "changed" | "updated",
            fn: (ev: { data?: { version?: string } }) => void,
            opts?: { signal?: AbortSignal },
          ) => () => void
        }
      }
      stopChanged = rpcClient.events?.on?.("changed", () => void refresh(), { signal: stopCtrl.signal })
      stopUpdated = rpcClient.events?.on?.(
        "updated",
        (ev) => {
          const v = ev?.data?.version
          if (!v || v === notifiedVersion || stopCtrl.signal.aborted) return
          notifiedVersion = v
          ctx.ui.toast.show({ message: copy.updated(v), variant: "info" })
        },
        { signal: stopCtrl.signal },
      )
    } catch {}

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "zen-limits.show",
          title: copy.title,
          bind: "ctrl+shift+l",
          palette: true,
          slash: { name: "limits" },
          run: async () => {
            const result = await refresh(true)
            if (stopCtrl.signal.aborted) return
            if (!result || !result.ok) {
              ctx.ui.toast.show({
                message: result?.error ?? copy.failed,
                variant: "error",
              })
              return
            }
            ctx.ui.dialog.alert({
              title: `OpenCode Go · ${result.org}${result.email ? ` · ${result.email}` : ""}`,
              message: cardDetail(result, Date.now(), lang),
            })
          },
        },
      ],
    }))

    return () => {
      stopCtrl.abort()
      clearInterval(timer)
      stopChanged?.()
      stopUpdated?.()
      stopUsage()
      unslot()
    }
  },
})
