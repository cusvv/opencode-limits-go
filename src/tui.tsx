import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { Limits } from "./rpc.ts"
import { log } from "./log.ts"
import {
  type LimitCard,
  type Locale,
  type VisibleWindows,
  alertMessage,
  cardDetail,
  emptyCard,
  errorText,
  formatTokensCompact,
  formatTuiSidebar,
  formatUsd,
  newAlerts,
  normalizeLocale,
  retry,
  span,
  summarizeStatsByProvider,
} from "./model.ts"

type TuiPrefs = VisibleWindows & {
  showBars?: boolean
  warnThreshold?: number
}

const COPY = {
  en: {
    title: "OpenCode Go limits",
    windowsTitle: "OpenCode Go limits: sidebar windows",
    settingsTitle: "OpenCode Go limits: TUI settings",
    allWindows: "All windows (5h · 1w · 1m)",
    only5h: "Only 5h",
    only1w: "Only 1w",
    only1m: "Only 1m",
    toggleBars: (on: boolean) => `Sidebar mini-bars: ${on ? "ON" : "OFF"}`,
    pickWindows: "Choose sidebar windows…",
    thresholdItem: (v: number) => `Alert threshold: ${v > 0 ? `${v}% / 100%` : "100% only"}`,
    checkUpdates: "Check for plugin updates…",
    upToDate: (v: string) => `opencode-limits-go v${v} is up to date.`,
    updateAvail: (v: string, pm: boolean) =>
      pm ? `v${v} available — run: opencode plugin update` : `v${v} available — run /reload after update`,
    todayPrefix: "Today",
    budgetPrefix: "Budget",
    fallbackHint: "Go quota reached — switch to OpenCode Zen or a free model until reset.",
    loading: "limits: …",
    noServer: "cannot reach plugin server",
    failed: "Failed to load limits",
    updated: (v: string) => `opencode-limits-go updated to v${v}. Run /reload to apply.`,
  },
  ru: {
    title: "Лимиты OpenCode Go",
    windowsTitle: "Лимиты OpenCode Go: окна в панели",
    settingsTitle: "Лимиты OpenCode Go: настройки TUI",
    allWindows: "Все окна (5ч · 1н · 1м)",
    only5h: "Только 5ч",
    only1w: "Только 1н",
    only1m: "Только 1м",
    toggleBars: (on: boolean) => `Мини-бары в панели: ${on ? "ВКЛ" : "ВЫКЛ"}`,
    pickWindows: "Выбрать окна в панели…",
    thresholdItem: (v: number) => `Порог уведомлений: ${v > 0 ? `${v}% / 100%` : "только 100%"}`,
    checkUpdates: "Проверить обновления плагина…",
    upToDate: (v: string) => `opencode-limits-go v${v} — актуальная версия.`,
    updateAvail: (v: string, pm: boolean) =>
      pm ? `Доступна v${v} — выполните: opencode plugin update` : `Доступна v${v} — выполните /reload после обновления`,
    todayPrefix: "Сегодня",
    budgetPrefix: "Бюджет",
    fallbackHint: "Квота Go исчерпана — до сброса можно переключиться на OpenCode Zen или бесплатные модели.",
    loading: "лимиты: …",
    noServer: "нет связи с сервером плагина",
    failed: "Не удалось получить лимиты",
    updated: (v: string) => `opencode-limits-go обновлён до v${v}. Выполните /reload.`,
  },
} as const

export default Plugin.define({
  id: "opencode-limits-go.tui",
  setup(ctx) {
    const lang: Locale = normalizeLocale(
      typeof ctx.options.lang === "string"
        ? ctx.options.lang
        : process.env.OPENCODE_LANG || process.env.LC_ALL || process.env.LANG,
    )
    const copy = COPY[lang]

    const [tuiPrefs, setTuiPrefs] = ctx.storage.store<TuiPrefs>("opencode-limits-go.tui", {
      initial: { rolling: true, weekly: true, monthly: true, showBars: false, warnThreshold: 80 },
    })

    const showBars = () => tuiPrefs.showBars === true
    const warnAt = () => (typeof tuiPrefs.warnThreshold === "number" ? tuiPrefs.warnThreshold : 80)

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
          for (const row of newAlerts(result.rows, notified, warnAt())) {
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

    async function fetchExtraLines(now: number): Promise<string[]> {
      const lines: string[] = []
      try {
        const exp = (ctx.client as unknown as {
          experimental?: {
            usage?: {
              limits?: (input?: unknown, opts?: { signal?: AbortSignal }) => Promise<{
                data?: { budgets?: Array<{ limit?: number; spent?: number; resetsAt?: number }> } | null
              }>
            }
            session?: {
              stats?: (input?: { from?: number }, opts?: { signal?: AbortSignal }) => Promise<{
                models?: Array<{
                  model?: { providerID?: string }
                  steps?: number
                  cost?: number
                  tokens?: { input?: number; output?: number; reasoning?: number }
                }>
              }>
            }
          }
        }).experimental
        const start = new Date(now)
        start.setHours(0, 0, 0, 0)
        const [limitsRes, statsRes] = await Promise.all([
          exp?.usage?.limits?.(undefined, { signal: stopCtrl.signal }).catch(() => null),
          exp?.session?.stats?.({ from: start.getTime() }, { signal: stopCtrl.signal }).catch(() => null),
        ])
        const today = summarizeStatsByProvider(statsRes?.models)
        const parts: string[] = []
        if (today.goTokens > 0) parts.push(`Go ${formatTokensCompact(today.goTokens)} tok`)
        if (today.zenCostUsd > 0 || today.zenTokens > 0) {
          parts.push(`Zen ${formatUsd(today.zenCostUsd)} (${formatTokensCompact(today.zenTokens)})`)
        }
        if (parts.length) lines.push(`${copy.todayPrefix}: ${parts.join(" · ")}`)

        const budgets = Array.isArray(limitsRes?.data?.budgets) ? limitsRes.data.budgets : []
        for (const b of budgets) {
          if (typeof b?.limit === "number" && b.limit > 0 && typeof b?.spent === "number") {
            const reset = typeof b.resetsAt === "number" && b.resetsAt > 0 ? ` (${span(b.resetsAt - now, lang)})` : ""
            lines.push(`${copy.budgetPrefix}: ${formatUsd(b.spent)} / ${formatUsd(b.limit)}${reset}`)
          }
        }
      } catch {}
      return lines
    }

    async function pickWindows() {
      const picked = await ctx.ui.dialog.select<VisibleWindows>({
        title: copy.windowsTitle,
        options: [
          { title: copy.allWindows, value: { rolling: true, weekly: true, monthly: true } },
          { title: copy.only5h, value: { rolling: true, weekly: false, monthly: false } },
          { title: copy.only1w, value: { rolling: false, weekly: true, monthly: false } },
          { title: copy.only1m, value: { rolling: false, weekly: false, monthly: true } },
        ],
      })
      if (!picked) return
      await setTuiPrefs((draft) => {
        draft.rolling = picked.rolling
        draft.weekly = picked.weekly
        draft.monthly = picked.monthly
      })
    }

    void retry(() => refresh(), (result) => result !== null, 5, undefined, stopCtrl.signal)

    const timer = setInterval(() => void refresh(), 90_000)

    const text = () => {
      const current = card()
      return current ? formatTuiSidebar(current, tuiPrefs, showBars(), lang) : copy.loading
    }

    const fgColor = () => {
      const current = card()
      if (!current) return ctx.theme.text.muted
      if (!current.ok) return ctx.theme.text.feedback.error.base
      const max = current.rows.reduce((acc, row) => Math.max(acc, row.used), 0)
      if (max >= 100) return ctx.theme.text.feedback.error.base
      const w = warnAt()
      if (w > 0 && max >= w) return ctx.theme.text.feedback.warning.base
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
          id: "opencode-limits-go.show",
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
            const now = Date.now()
            const extra = await fetchExtraLines(now)
            if (stopCtrl.signal.aborted) return
            if (result.rows.some((r) => r.used >= 100 || r.status === "limited")) {
              extra.push(copy.fallbackHint)
            }
            ctx.ui.dialog.alert({
              title: `OpenCode Go · ${result.org}${result.email ? ` · ${result.email}` : ""}`,
              message: cardDetail(result, now, lang, extra),
            })
          },
        },
        {
          id: "opencode-limits-go.windows",
          title: copy.windowsTitle,
          palette: true,
          slash: { name: "limits-windows" },
          run: pickWindows,
        },
        {
          id: "opencode-limits-go.tuiSettings",
          title: copy.settingsTitle,
          palette: true,
          slash: { name: "limits-settings" },
          run: async () => {
            const action = await ctx.ui.dialog.select<string>({
              title: copy.settingsTitle,
              options: [
                { title: copy.toggleBars(!showBars()), value: "bars" },
                { title: copy.pickWindows, value: "windows" },
                { title: copy.thresholdItem(warnAt()), value: "threshold" },
                { title: copy.checkUpdates, value: "update" },
              ],
            })
            if (!action || stopCtrl.signal.aborted) return
            if (action === "bars") {
              await setTuiPrefs((d) => {
                d.showBars = !showBars()
              })
            } else if (action === "windows") {
              await pickWindows()
            } else if (action === "threshold") {
              const next = warnAt() === 70 ? 80 : warnAt() === 80 ? 90 : warnAt() === 90 ? 0 : 70
              await setTuiPrefs((d) => {
                d.warnThreshold = next
              })
            } else if (action === "update") {
              try {
                const res = (await ctx.client.rpc(Limits).updateStatus({ check: true }, { signal: stopCtrl.signal })) as {
                  currentVersion: string
                  latestVersion: string
                  updateAvailable: boolean
                  managedByPackageManager?: boolean
                }
                ctx.ui.toast.show({
                  message: res.updateAvailable
                    ? copy.updateAvail(res.latestVersion, !!res.managedByPackageManager)
                    : copy.upToDate(res.currentVersion),
                  variant: "info",
                })
              } catch {}
            }
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
