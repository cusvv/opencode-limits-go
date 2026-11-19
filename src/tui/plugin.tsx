import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { Limits } from "../rpc.ts"
import { log } from "../server/log.ts"
import { TUI_COPY as COPY } from "./i18n.ts"
import {
  type LimitCard,
  type Locale,
  type VisibleWindows,
  alertMessage,
  burnSpikeMessage,
  cardDetail,
  detectBurnSpike,
  emptyCard,
  errorText,
  filterStripRows,
  formatTokensCompact,
  formatTuiSidebar,
  formatUsd,
  newAlerts,
  normalizeLocale,
  recoveredAlerts,
  resetAlertMessage,
  retry,
  span,
  summarizeStatsByProvider,
} from "../core/index.ts"

type TuiPrefs = VisibleWindows & {
  showBars?: boolean
  showRemaining?: boolean
  warnThreshold?: number
  burnSpikePct?: number
  langOverride?: string
}

export default Plugin.define({
  id: "opencode-limits-go.tui",
  setup(ctx) {
    const baseLang: Locale = normalizeLocale(
      typeof ctx.options.lang === "string"
        ? ctx.options.lang
        : process.env.OPENCODE_LANG || process.env.LC_ALL || process.env.LANG,
    )

    const [tuiPrefs, setTuiPrefs] = ctx.storage.store<TuiPrefs>("opencode-limits-go.tui", {
      initial: {
        rolling: true,
        weekly: true,
        monthly: true,
        showBars: false,
        showRemaining: false,
        warnThreshold: 80,
        burnSpikePct: 20,
        langOverride: "auto",
      },
    })

    const lang = (): Locale =>
      tuiPrefs.langOverride === "en" || tuiPrefs.langOverride === "ru" ? tuiPrefs.langOverride : baseLang
    const copy = () => COPY[lang()]

    const showBars = () => tuiPrefs.showBars === true
    const showRemaining = () => tuiPrefs.showRemaining === true
    const warnAt = () => (typeof tuiPrefs.warnThreshold === "number" ? tuiPrefs.warnThreshold : 80)
    const spikeAt = () => (typeof tuiPrefs.burnSpikePct === "number" ? tuiPrefs.burnSpikePct : 20)

    const [card, setCard] = createSignal<LimitCard | null>(null)
    const [staleError, setStaleError] = createSignal("")
    const notified = new Map<string, number>()
    const wasExhausted = new Set<string>()
    const stopCtrl = new AbortController()
    let notifiedVersion = ""
    let lastSpikeAlertAt = 0

    async function pullSharedPrefs() {
      try {
        const shared = (await ctx.client.rpc(Limits).getPrefs({}, { signal: stopCtrl.signal })) as Partial<TuiPrefs>
        if (!shared || stopCtrl.signal.aborted) return
        await setTuiPrefs((d) => {
          if (typeof shared.rolling === "boolean") d.rolling = shared.rolling
          if (typeof shared.weekly === "boolean") d.weekly = shared.weekly
          if (typeof shared.monthly === "boolean") d.monthly = shared.monthly
          if (typeof shared.showRemaining === "boolean") d.showRemaining = shared.showRemaining
          if (typeof shared.warnThreshold === "number") d.warnThreshold = shared.warnThreshold
          if (typeof shared.burnSpikePct === "number") d.burnSpikePct = shared.burnSpikePct
          if (shared.langOverride === "auto" || shared.langOverride === "en" || shared.langOverride === "ru") {
            d.langOverride = shared.langOverride
          }
        })
      } catch {}
    }

    function pushSharedPrefs(patch: Partial<TuiPrefs>) {
      void ctx.client.rpc(Limits).setPrefs(patch, { signal: stopCtrl.signal }).catch(() => {})
    }

    async function refresh(force = false): Promise<LimitCard | null> {
      if (stopCtrl.signal.aborted) return null
      try {
        const currentLang = lang()
        const result = (await ctx.client.rpc(Limits).status({ force, lang: currentLang }, { signal: stopCtrl.signal })) as LimitCard
        if (stopCtrl.signal.aborted) return null
        if (result.ok) {
          setCard(result)
          setStaleError("")
          const now = Date.now()
          for (const row of newAlerts(result.rows, notified, warnAt())) {
            ctx.ui.toast.show({
              message: alertMessage(row, now, currentLang),
              variant: row.used >= 100 ? "error" : "warning",
            })
          }
          for (const row of recoveredAlerts(result.rows, wasExhausted)) {
            ctx.ui.toast.show({
              message: resetAlertMessage(row, currentLang),
              variant: "info",
            })
          }
          if (now - lastSpikeAlertAt > 30 * 60_000) {
            const spike = detectBurnSpike(result.rows, result.snapshots, spikeAt(), now)
            if (spike) {
              lastSpikeAlertAt = now
              ctx.ui.toast.show({
                message: burnSpikeMessage(spike, currentLang),
                variant: "warning",
              })
            }
          }
        } else if (card()?.ok) {
          setStaleError(result.error || copy().failed)
        } else {
          setCard(result)
          setStaleError("")
        }
        return result
      } catch (error) {
        if (stopCtrl.signal.aborted) return null
        log("tui status failed", { error: errorText(error, "en") })
        if (card()?.ok) {
          setStaleError(copy().noServer)
        } else {
          setCard(emptyCard(copy().noServer))
        }
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
        const c = copy()
        const l = lang()
        const parts: string[] = []
        if (today.goTokens > 0) parts.push(`Go ${formatTokensCompact(today.goTokens)} ${c.tokUnit}`)
        if (today.zenCostUsd > 0 || today.zenTokens > 0) {
          parts.push(`Zen ${formatUsd(today.zenCostUsd)} (${formatTokensCompact(today.zenTokens)})`)
        }
        if (parts.length) lines.push(`${c.todayPrefix}: ${parts.join(" · ")}`)
        if (today.topModels.length) {
          const modelsLine = today.topModels
            .map((m) => `${m.modelID} (${formatTokensCompact(m.tokens)})`)
            .join(" · ")
          lines.push(`${c.modelsPrefix}: ${modelsLine}`)
        }

        const budgets = Array.isArray(limitsRes?.data?.budgets) ? limitsRes.data.budgets : []
        for (const b of budgets) {
          if (typeof b?.limit === "number" && b.limit > 0 && typeof b?.spent === "number") {
            const reset = typeof b.resetsAt === "number" && b.resetsAt > 0 ? ` (${span(b.resetsAt - now, l)})` : ""
            lines.push(`${c.budgetPrefix}: ${formatUsd(b.spent)} / ${formatUsd(b.limit)}${reset}`)
          }
        }
      } catch {}
      return lines
    }

    async function pickWindows() {
      const c = copy()
      const picked = await ctx.ui.dialog.select<VisibleWindows>({
        title: c.windowsTitle,
        options: [
          { title: c.allWindows, value: { rolling: true, weekly: true, monthly: true } },
          { title: c.win5h1w, value: { rolling: true, weekly: true, monthly: false } },
          { title: c.win5h1m, value: { rolling: true, weekly: false, monthly: true } },
          { title: c.win1w1m, value: { rolling: false, weekly: true, monthly: true } },
          { title: c.only5h, value: { rolling: true, weekly: false, monthly: false } },
          { title: c.only1w, value: { rolling: false, weekly: true, monthly: false } },
          { title: c.only1m, value: { rolling: false, weekly: false, monthly: true } },
        ],
      })
      if (!picked) return
      await setTuiPrefs((draft) => {
        draft.rolling = picked.rolling
        draft.weekly = picked.weekly
        draft.monthly = picked.monthly
      })
      pushSharedPrefs({ rolling: picked.rolling, weekly: picked.weekly, monthly: picked.monthly })
    }

    void retry(() => refresh(), (result) => result !== null, 5, undefined, stopCtrl.signal).then(() => {
      if (!stopCtrl.signal.aborted) void pullSharedPrefs()
    })

    const timer = setInterval(() => void refresh(), 90_000)

    const text = () => {
      const current = card()
      if (!current) return copy().loading
      const base = formatTuiSidebar(current, tuiPrefs, showBars(), lang(), Date.now(), showRemaining())
      return current.ok && (staleError() || current.stale) ? `${base} (${copy().stalePrefix})` : base
    }

    const fgColor = () => {
      const current = card()
      if (!current) return ctx.theme.text.muted
      if (!current.ok) return ctx.theme.text.feedback.error.base
      const visibleRows = filterStripRows(current.rows, tuiPrefs)
      const max = visibleRows.reduce((acc, row) => Math.max(acc, row.used), 0)
      if (max >= 100) return ctx.theme.text.feedback.error.base
      const w = warnAt()
      if (w > 0 && max >= w) return ctx.theme.text.feedback.warning.base
      if (staleError()) return ctx.theme.text.muted
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
    let stopPrefsChanged: (() => void) | undefined
    try {
      const rpcClient = ctx.client.rpc(Limits) as {
        events?: {
          on?: (
            name: "changed" | "updated" | "prefsChanged",
            fn: (ev: { data?: { version?: string } }) => void,
            opts?: { signal?: AbortSignal },
          ) => () => void
        }
      }
      stopChanged = rpcClient.events?.on?.("changed", () => void refresh(), { signal: stopCtrl.signal })
      stopPrefsChanged = rpcClient.events?.on?.("prefsChanged", () => void pullSharedPrefs(), { signal: stopCtrl.signal })
      stopUpdated = rpcClient.events?.on?.(
        "updated",
        (ev) => {
          const v = ev?.data?.version
          if (!v || v === notifiedVersion || stopCtrl.signal.aborted) return
          notifiedVersion = v
          ctx.ui.toast.show({ message: copy().updated(v), variant: "info" })
        },
        { signal: stopCtrl.signal },
      )
    } catch {}

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-limits-go.show",
          title: copy().title,
          bind: "ctrl+shift+l",
          palette: true,
          slash: { name: "limits" },
          run: async () => {
            const c = copy()
            const l = lang()
            const result = await refresh(true)
            if (stopCtrl.signal.aborted) return
            if (!result || !result.ok) {
              ctx.ui.toast.show({
                message: result?.error ?? c.failed,
                variant: "error",
              })
              return
            }
            const now = Date.now()
            const extra = await fetchExtraLines(now)
            if (stopCtrl.signal.aborted) return
            if (result.rows.some((r) => r.used >= 100 || r.status === "limited")) {
              extra.push(c.fallbackHint)
            }
            ctx.ui.dialog.alert({
              title: `OpenCode Go · ${result.org}${result.email ? ` · ${result.email}` : ""}`,
              message: cardDetail(result, now, l, extra),
            })
          },
        },
        {
          id: "opencode-limits-go.windows",
          title: copy().windowsTitle,
          palette: true,
          slash: { name: "limits-windows" },
          run: pickWindows,
        },
        {
          id: "opencode-limits-go.tuiSettings",
          title: copy().settingsTitle,
          palette: true,
          slash: { name: "limits-settings" },
          run: async () => {
            const c = copy()
            const action = await ctx.ui.dialog.select<string>({
              title: c.settingsTitle,
              options: [
                { title: c.toggleBars(!showBars()), value: "bars" },
                { title: c.toggleRemaining(!showRemaining()), value: "remaining" },
                { title: c.pickWindows, value: "windows" },
                { title: c.thresholdItem(warnAt()), value: "threshold" },
                { title: c.checkUpdates, value: "update" },
              ],
            })
            if (!action || stopCtrl.signal.aborted) return
            if (action === "bars") {
              await setTuiPrefs((d) => {
                d.showBars = !showBars()
              })
            } else if (action === "remaining") {
              const next = !showRemaining()
              await setTuiPrefs((d) => {
                d.showRemaining = next
              })
              pushSharedPrefs({ showRemaining: next })
            } else if (action === "windows") {
              await pickWindows()
            } else if (action === "threshold") {
              const next = warnAt() === 70 ? 80 : warnAt() === 80 ? 90 : warnAt() === 90 ? 0 : 70
              await setTuiPrefs((d) => {
                d.warnThreshold = next
              })
              pushSharedPrefs({ warnThreshold: next })
            } else if (action === "update") {
              try {
                const res = (await ctx.client.rpc(Limits).updateStatus({ check: true }, { signal: stopCtrl.signal })) as {
                  currentVersion: string
                  latestVersion: string
                  updateAvailable: boolean
                  restartRequired?: boolean
                  managedByPackageManager?: boolean
                }
                if (stopCtrl.signal.aborted) return
                if (res.restartRequired) {
                  ctx.ui.toast.show({ message: c.updated(res.latestVersion), variant: "info" })
                  return
                }
                if (!res.updateAvailable) {
                  ctx.ui.toast.show({ message: c.upToDate(res.currentVersion), variant: "info" })
                  return
                }
                if (res.managedByPackageManager) {
                  ctx.ui.toast.show({ message: c.updateManaged(res.latestVersion), variant: "info" })
                  return
                }
                const installed = (await ctx.client.rpc(Limits).installUpdate({}, { signal: stopCtrl.signal })) as {
                  ok: boolean
                  version: string
                  error: string
                }
                if (stopCtrl.signal.aborted) return
                ctx.ui.toast.show({
                  message: installed.ok
                    ? c.updated(installed.version || res.latestVersion)
                    : c.updateInstallFailed(installed.error),
                  variant: installed.ok ? "info" : "error",
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
      stopPrefsChanged?.()
      stopUpdated?.()
      stopUsage()
      unslot()
    }
  },
})
