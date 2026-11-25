import { Plugin } from "@opencode/plugin/tui"
import { Show, createSignal } from "solid-js"
import { Limits } from "../rpc.ts"
import { TUI_COPY as COPY } from "./i18n.ts"
import { type AlertNotification, type AlertState, createAlertState, reduceAlerts } from "../ui-state/alerts.ts"
import { createStatusPoller } from "../ui-state/poller.ts"
import { applySharedPrefs, pickSharedPrefs } from "../ui-state/prefs.ts"
import {
  type LimitCard,
  type Locale,
  type VisibleWindows,
  emptyCard,
  filterStripRows,
  normalizeLocale,
  retry,
  summarizeStatsByProvider,
} from "../core/index.ts"
import {
  cardDetail,
  cardErrorText,
  formatTokensCompact,
  formatTuiSidebar,
  formatUsd,
  relativeAge,
  span,
} from "../present/index.ts"

type TuiPrefs = VisibleWindows & {
  showBars?: boolean
  showRemaining?: boolean
  warnThreshold?: number
  burnSpikePct?: number
  langOverride?: string
  alerts?: boolean
  systemNotifications?: boolean
  hidden?: boolean
  plain?: boolean
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
        alerts: true,
        systemNotifications: false,
        hidden: false,
        plain: false,
      },
    })
    const [alertState, setAlertState] = ctx.storage.store<AlertState>("opencode-limits-go.tui.alerts", {
      initial: createAlertState(),
    })

    const lang = (): Locale =>
      tuiPrefs.langOverride === "en" || tuiPrefs.langOverride === "ru" ? tuiPrefs.langOverride : baseLang
    const copy = () => COPY[lang()]

    const showBars = () => tuiPrefs.showBars === true
    const showRemaining = () => tuiPrefs.showRemaining === true
    const warnAt = () => (typeof tuiPrefs.warnThreshold === "number" ? tuiPrefs.warnThreshold : 80)
    const spikeAt = () => (typeof tuiPrefs.burnSpikePct === "number" ? tuiPrefs.burnSpikePct : 20)
    const alertsOn = () => tuiPrefs.alerts !== false

    const [card, setCard] = createSignal<LimitCard | null>(null)
    const [staleError, setStaleError] = createSignal("")
    const stopCtrl = new AbortController()
    const renderer = ctx.renderer
    const [termWidth, setTermWidth] = createSignal(renderer?.terminalWidth ?? 80)
    const onResize = (width: number) => setTermWidth(width)
    renderer?.on("resize", onResize)
    let notifiedVersion = ""

    function showAlert(notification: AlertNotification): void {
      const variant = notification.variant === "error" ? "error" : notification.variant === "success" ? "info" : "warning"
      ctx.ui.toast.show({ message: notification.text, variant })
      // The reducer owns opt-in, 100%-only, and the 10-minute throttle for system notifications.
      if (!notification.attention) return
      const pending = ctx.attention?.notify({
        title: copy().title,
        message: notification.text,
        notification: { when: "blurred" },
        sound: { when: "blurred" },
      })
      void pending?.catch(() => {})
    }

    async function pullSharedPrefs() {
      try {
        const shared = (await ctx.client.rpc(Limits).getPrefs({}, { signal: stopCtrl.signal })) as Record<
          string,
          unknown
        >
        if (!shared || stopCtrl.signal.aborted) return
        await setTuiPrefs((d) => {
          applySharedPrefs(shared, {
            windows: (windows) => {
              if (typeof windows.rolling === "boolean") d.rolling = windows.rolling
              if (typeof windows.weekly === "boolean") d.weekly = windows.weekly
              if (typeof windows.monthly === "boolean") d.monthly = windows.monthly
            },
            showRemaining: (value) => {
              d.showRemaining = value
            },
            warnThreshold: (value) => {
              d.warnThreshold = value
            },
            burnSpikePct: (value) => {
              d.burnSpikePct = value
            },
            alerts: (value) => {
              d.alerts = value
            },
            systemNotifications: (value) => {
              d.systemNotifications = value
            },
            langOverride: (value) => {
              d.langOverride = value
            },
          })
        })
      } catch {}
    }

    function pushSharedPrefs(patch: Partial<TuiPrefs>) {
      void ctx.client.rpc(Limits).setPrefs({ ...pickSharedPrefs({ ...patch }) }, { signal: stopCtrl.signal }).catch(() => {
        ctx.ui.toast.show({ message: copy().noServer, variant: "error" })
        void pullSharedPrefs()
      })
    }

    function applyAlerts(result: LimitCard, now: number): void {
      if (stopCtrl.signal.aborted) return
      const current = createAlertState(alertState)
      const reduced = reduceAlerts(
        current,
        result,
        {
          alerts: alertsOn(),
          warnThreshold: warnAt(),
          burnSpikePct: spikeAt(),
          systemNotifications: tuiPrefs.systemNotifications === true,
          lang: lang(),
        },
        now,
      )
      if (JSON.stringify(reduced.state) !== JSON.stringify(current)) {
        const next = reduced.state
        void setAlertState((draft) => {
          draft.account = next.account
          draft.notified = next.notified
          draft.exhausted = next.exhausted
          draft.risk = next.risk
          draft.spikeAt = next.spikeAt
          draft.systemAt = next.systemAt
        })
      }
      for (const notification of reduced.notifications) showAlert(notification)
    }

    function resetAlerts(): void {
      const cleared = createAlertState()
      void setAlertState((draft) => {
        draft.account = cleared.account
        draft.notified = cleared.notified
        draft.exhausted = cleared.exhausted
        draft.risk = cleared.risk
        draft.spikeAt = cleared.spikeAt
        draft.systemAt = cleared.systemAt
      })
    }

    function handleResult(result: LimitCard): void {
      if (stopCtrl.signal.aborted) return
      if (result.ok) {
        setCard(result)
        setStaleError("")
        applyAlerts(result, Date.now())
        return
      }
      if (card()?.ok) {
        setStaleError(cardErrorText(result, lang()) || copy().failed)
        return
      }
      setCard(result)
      setStaleError("")
    }

    function handleError(): void {
      if (stopCtrl.signal.aborted) return
      if (card()?.ok) {
        setStaleError(copy().noServer)
      } else {
        setCard(emptyCard(copy().noServer))
      }
    }

    const poller = createStatusPoller({
      fetchStatus: ({ force, signal }) =>
        ctx.client.rpc(Limits).status(
          { force, lang: lang() },
          { signal: AbortSignal.any([signal, stopCtrl.signal]) },
        ) as Promise<LimitCard>,
      onResult: handleResult,
      onError: () => handleError(),
    })

    function refresh(force = false): Promise<LimitCard | null> {
      if (stopCtrl.signal.aborted) return Promise.resolve(null)
      return poller.refresh(force)
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
                  model?: { providerID?: string; modelID?: string }
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
        const weekStart = now - 7 * 86_400_000
        const [limitsRes, statsRes, weekRes] = await Promise.all([
          exp?.usage?.limits?.(undefined, { signal: stopCtrl.signal }).catch(() => null),
          exp?.session?.stats?.({ from: start.getTime() }, { signal: stopCtrl.signal }).catch(() => null),
          exp?.session?.stats?.({ from: weekStart }, { signal: stopCtrl.signal }).catch(() => null),
        ])
        const today = summarizeStatsByProvider(statsRes?.models)
        const week = summarizeStatsByProvider(weekRes?.models)
        const c = copy()
        const l = lang()
        const parts: string[] = []
        if (today.goTokens > 0) parts.push(`Go ${formatTokensCompact(today.goTokens)} ${c.tokUnit}`)
        if (today.zenCostUsd > 0 || today.zenTokens > 0) {
          parts.push(`Zen ${formatUsd(today.zenCostUsd)} (${formatTokensCompact(today.zenTokens)})`)
        }
        if (parts.length) lines.push(`${c.todayPrefix}: ${parts.join(" · ")}`)
        if (week.goTokens > 0 || week.zenCostUsd > 0 || week.zenTokens > 0) {
          const weekParts: string[] = []
          if (week.goTokens > 0) weekParts.push(`Go ${formatTokensCompact(week.goTokens)} ${c.tokUnit}`)
          if (week.zenCostUsd > 0 || week.zenTokens > 0) {
            weekParts.push(`Zen ${formatUsd(week.zenCostUsd)} (${formatTokensCompact(week.zenTokens)})`)
          }
          if (week.topModels[0]) weekParts.push(week.topModels[0].modelID)
          lines.push(`${c.weekPrefix}: ${weekParts.join(" · ")}`)
        }
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

    async function checkUpdates(): Promise<void> {
      const c = copy()
      try {
        const res = (await ctx.client.rpc(Limits).updateStatus({ check: true }, { signal: stopCtrl.signal })) as {
          currentVersion: string
          latestVersion: string
          updateAvailable: boolean
          restartRequired?: boolean
          managedByPackageManager?: boolean
          managedByDev?: boolean
          error?: string
        }
        if (stopCtrl.signal.aborted) return
        if (res.error) {
          ctx.ui.toast.show({ message: c.updateCheckFailed(res.error), variant: "error" })
          return
        }
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
        if (res.managedByDev) {
          ctx.ui.toast.show({ message: c.updateDev, variant: "info" })
          return
        }
        const installed = (await ctx.client.rpc(Limits).installUpdate({}, { signal: stopCtrl.signal })) as {
          ok: boolean
          version: string
          error: string
        }
        if (stopCtrl.signal.aborted) return
        if (!installed.ok) {
          ctx.ui.toast.show({ message: c.updateInstallFailed(installed.error), variant: "error" })
        } else if (installed.error) {
          ctx.ui.toast.show({ message: c.updateNeedsInstall(installed.error), variant: "warning" })
        } else {
          ctx.ui.toast.show({ message: c.updated(installed.version || res.latestVersion), variant: "info" })
        }
      } catch {}
    }

    void retry(() => refresh(), (result) => result !== null, 5, undefined, stopCtrl.signal).then(() => {
      if (!stopCtrl.signal.aborted) void pullSharedPrefs()
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (stopCtrl.signal.aborted) return
      const delay = card()?.ok ? 90_000 : 15_000
      timer = setTimeout(() => {
        void refresh().finally(schedule)
      }, delay)
      timer.unref?.()
    }
    schedule()

    const text = () => {
      const current = card()
      if (!current) return copy().loading
      const compact = termWidth() < 76
      const base = formatTuiSidebar(
        current,
        tuiPrefs,
        showBars(),
        lang(),
        Date.now(),
        showRemaining(),
        warnAt(),
        tuiPrefs.plain === true,
        compact,
      )
      const age = relativeAge(current.checkedAtMs, Date.now(), lang())
      return current.ok && (staleError() || current.stale) ? `${base} (${age || copy().stalePrefix})` : base
    }

    const fgColor = () => {
      const current = card()
      if (!current) return ctx.theme.text.muted
      if (!current.ok) return ctx.theme.text.feedback.error.base
      const max = current.rows.reduce((acc, row) => Math.max(acc, row.used), 0)
      if (max >= 100) return ctx.theme.text.feedback.error.base
      const w = warnAt()
      if (w > 0 && max >= w) return ctx.theme.text.feedback.warning.base
      if (staleError() || current.stale) return ctx.theme.text.muted
      return ctx.theme.text.base
    }

    const unslot = ctx.ui.slot({
      append: "sidebar.content",
      render: () => (
        <Show when={tuiPrefs.hidden !== true}>
          <box>
            <text fg={fgColor()}>{text()}</text>
          </box>
        </Show>
      ),
    })

    let stopChanged: (() => void) | undefined
    let stopUpdated: (() => void) | undefined
    let stopPrefsChanged: (() => void) | undefined
    try {
      const rpcClient = ctx.client.rpc(Limits) as {
        events?: {
          on?: (
            name: "changed" | "updated" | "prefsChanged",
            fn: (ev: { data?: { version?: string; reason?: string } }) => void,
            opts?: { signal?: AbortSignal },
          ) => () => void
        }
      }
      stopChanged = rpcClient.events?.on?.(
        "changed",
        (ev) => {
          if (ev?.data?.reason !== "credentials") {
            void refresh()
            return
          }
          poller.invalidate()
          setCard(null)
          setStaleError("")
          resetAlerts()
          void refresh(true)
        },
        { signal: stopCtrl.signal },
      )
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

    // The typed API returns void; keep any runtime disposer the host hands back.
    const disposeKeymap: unknown = ctx.keymap.layer(() => ({
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
            const now = Date.now()
            if (!result || !result.ok) {
              const cached = card()
              if (cached?.ok) {
                ctx.ui.dialog.alert({
                  title: `OpenCode Go · ${cached.org}${cached.email ? ` · ${cached.email}` : ""}`,
                  message: cardDetail(
                    cached,
                    now,
                    l,
                    [result ? cardErrorText(result, l) || c.failed : c.failed],
                    showRemaining(),
                    termWidth() < 76,
                    tuiPrefs.plain === true,
                  ),
                })
                return
              }
              ctx.ui.toast.show({ message: result ? cardErrorText(result, l) || c.failed : c.failed, variant: "error" })
              return
            }
            const extra = await fetchExtraLines(now)
            if (stopCtrl.signal.aborted) return
            if (result.rows.some((r) => r.used >= 100 || r.status === "limited")) {
              extra.push(c.fallbackHint)
            }
            ctx.ui.dialog.alert({
              title: `OpenCode Go · ${result.org}${result.email ? ` · ${result.email}` : ""}`,
              message: cardDetail(
                result,
                now,
                l,
                extra,
                showRemaining(),
                termWidth() < 76,
                tuiPrefs.plain === true,
              ),
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
            for (;;) {
              if (stopCtrl.signal.aborted) return
              const c = copy()
              const action = await ctx.ui.dialog.select<string>({
                title: c.settingsTitle,
                options: [
                  { title: c.toggleBars(!showBars()), value: "bars" },
                  { title: c.toggleRemaining(!showRemaining()), value: "remaining" },
                  { title: c.pickWindows, value: "windows" },
                  { title: c.thresholdItem(warnAt()), value: "threshold" },
                  { title: c.spikeItem(spikeAt()), value: "spike" },
                  { title: c.toggleAlerts(alertsOn()), value: "alerts" },
                  { title: c.toggleSystemNotify(tuiPrefs.systemNotifications === true), value: "system" },
                  { title: c.toggleHidden(tuiPrefs.hidden === true), value: "hidden" },
                  { title: c.togglePlain(tuiPrefs.plain === true), value: "plain" },
                  { title: c.languageItem(tuiPrefs.langOverride ?? "auto"), value: "lang" },
                  { title: c.checkUpdates, value: "update" },
                  { title: c.close, value: "close" },
                ],
              })
              if (!action || action === "close") return
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
                const values = [50, 70, 80, 90, 0]
                const next = values[(values.indexOf(warnAt()) + 1) % values.length] ?? 80
                await setTuiPrefs((d) => {
                  d.warnThreshold = next
                })
                pushSharedPrefs({ warnThreshold: next })
              } else if (action === "spike") {
                const values = [0, 15, 20, 30]
                const next = values[(values.indexOf(spikeAt()) + 1) % values.length] ?? 20
                await setTuiPrefs((d) => {
                  d.burnSpikePct = next
                })
                pushSharedPrefs({ burnSpikePct: next })
              } else if (action === "alerts") {
                const next = !alertsOn()
                await setTuiPrefs((d) => {
                  d.alerts = next
                })
                pushSharedPrefs({ alerts: next })
              } else if (action === "system") {
                const next = tuiPrefs.systemNotifications !== true
                await setTuiPrefs((d) => {
                  d.systemNotifications = next
                })
                pushSharedPrefs({ systemNotifications: next })
              } else if (action === "hidden") {
                await setTuiPrefs((d) => {
                  d.hidden = !tuiPrefs.hidden
                })
              } else if (action === "plain") {
                await setTuiPrefs((d) => {
                  d.plain = !tuiPrefs.plain
                })
              } else if (action === "lang") {
                const values = ["auto", "en", "ru"] as const
                const next = values[(values.indexOf((tuiPrefs.langOverride ?? "auto") as (typeof values)[number]) + 1) % values.length]
                await setTuiPrefs((d) => {
                  d.langOverride = next
                })
                pushSharedPrefs({ langOverride: next })
              } else if (action === "update") {
                await checkUpdates()
                return
              }
            }
          },
        },
      ],
    }))

    return () => {
      poller.dispose()
      stopCtrl.abort()
      renderer?.off("resize", onResize)
      if (timer) clearTimeout(timer)
      stopChanged?.()
      stopPrefsChanged?.()
      stopUpdated?.()
      if (typeof disposeKeymap === "function") disposeKeymap()
      unslot()
    }
  },
})
