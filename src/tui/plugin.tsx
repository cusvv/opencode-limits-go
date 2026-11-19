import { Plugin } from "@opencode/plugin/tui"
import { Show, createSignal } from "solid-js"
import { Limits } from "../rpc.ts"
import { log } from "../server/log.ts"
import { TUI_COPY as COPY } from "./i18n.ts"
import {
  type LimitCard,
  type Locale,
  type VisibleWindows,
  accountKey,
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
  relativeAge,
  resetAlertMessage,
  retry,
  span,
  summarizeStatsByProvider,
  windowVerdict,
} from "../core/index.ts"

type TuiPrefs = VisibleWindows & {
  showBars?: boolean
  showRemaining?: boolean
  warnThreshold?: number
  burnSpikePct?: number
  langOverride?: string
  alerts?: boolean
  hidden?: boolean
  plain?: boolean
}

type TuiAlertState = {
  account: string
  notified: Record<string, number>
  exhausted: string[]
  risk: Record<string, string>
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
        hidden: false,
        plain: false,
      },
    })
    const [alertState, setAlertState] = ctx.storage.store<TuiAlertState>("opencode-limits-go.tui.alerts", {
      initial: { account: "", notified: {}, exhausted: [], risk: {} },
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
    let notifiedVersion = ""
    let lastSpikeAlertAt = 0
    let refreshing = false

    function notify(message: string, variant: "info" | "warning" | "error"): void {
      ctx.ui.toast.show({ message, variant })
      void ctx.attention
        ?.notify({
          title: copy().title,
          message,
          notification: { when: "blurred" },
          sound: { when: "blurred" },
        })
        .catch(() => {})
    }

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
          if (typeof shared.alerts === "boolean") d.alerts = shared.alerts
          if (shared.langOverride === "auto" || shared.langOverride === "en" || shared.langOverride === "ru") {
            d.langOverride = shared.langOverride
          }
        })
      } catch {}
    }

    function pushSharedPrefs(patch: Partial<TuiPrefs>) {
      void ctx.client.rpc(Limits).setPrefs(patch, { signal: stopCtrl.signal }).catch(() => {
        notify(copy().noServer, "error")
        void pullSharedPrefs()
      })
    }

    function applyAlerts(result: LimitCard, now: number): void {
      if (!result.ok || result.stale || !alertsOn() || stopCtrl.signal.aborted) return
      const acct = accountKey(result.org, result.email, result.source)
      const changedAccount = !!alertState.account && alertState.account !== acct
      const notified = new Map<string, number>(changedAccount ? [] : Object.entries(alertState.notified))
      const wasExhausted = new Set<string>(changedAccount ? [] : alertState.exhausted)
      const risk = { ...(changedAccount ? {} : alertState.risk) }
      if (changedAccount) lastSpikeAlertAt = 0

      const triggered = newAlerts(result.rows, notified, warnAt())
      const recovered = recoveredAlerts(result.rows, wasExhausted)
      for (const row of triggered) notify(alertMessage(row, now, lang()), row.used >= 100 ? "error" : "warning")
      for (const row of recovered) notify(resetAlertMessage(row, lang()), "info")

      for (const row of result.rows) {
        const verdict = windowVerdict(row, now, lang(), result.snapshots)
        if (!verdict || verdict.kind === "fits") continue
        const id = row.key ?? row.label
        const signature = String(row.resetsAtMs ?? 0)
        if (risk[id] === signature) continue
        risk[id] = signature
        notify(verdict.text, verdict.kind === "exhausted" ? "error" : "warning")
      }

      if (spikeAt() > 0 && now - lastSpikeAlertAt > 30 * 60_000) {
        const spike = detectBurnSpike(result.rows, result.snapshots, spikeAt(), now)
        if (spike) {
          lastSpikeAlertAt = now
          notify(burnSpikeMessage(spike, lang()), "warning")
        }
      }

      const nextState: TuiAlertState = {
        account: acct,
        notified: Object.fromEntries(notified),
        exhausted: [...wasExhausted],
        risk,
      }
      if (JSON.stringify(nextState) !== JSON.stringify(alertState)) {
        void setAlertState((draft) => {
          draft.account = nextState.account
          draft.notified = nextState.notified
          draft.exhausted = nextState.exhausted
          draft.risk = nextState.risk
        })
      }
    }

    async function refresh(force = false): Promise<LimitCard | null> {
      if (stopCtrl.signal.aborted) return null
      if (refreshing) return card()
      refreshing = true
      try {
        const currentLang = lang()
        const signal = AbortSignal.any([stopCtrl.signal, AbortSignal.timeout(30_000)])
        const result = (await ctx.client.rpc(Limits).status({ force, lang: currentLang }, { signal })) as LimitCard
        if (stopCtrl.signal.aborted) return null
        if (result.ok) {
          setCard(result)
          setStaleError("")
          applyAlerts(result, Date.now())
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
      } finally {
        refreshing = false
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
        }
        if (stopCtrl.signal.aborted) return
        if (res.restartRequired) {
          notify(c.updated(res.latestVersion), "info")
          return
        }
        if (!res.updateAvailable) {
          notify(c.upToDate(res.currentVersion), "info")
          return
        }
        if (res.managedByPackageManager) {
          notify(c.updateManaged(res.latestVersion), "info")
          return
        }
        if (res.managedByDev) {
          notify(c.updateDev, "info")
          return
        }
        const installed = (await ctx.client.rpc(Limits).installUpdate({}, { signal: stopCtrl.signal })) as {
          ok: boolean
          version: string
          error: string
        }
        if (stopCtrl.signal.aborted) return
        notify(
          installed.ok ? c.updated(installed.version || res.latestVersion) : c.updateInstallFailed(installed.error),
          installed.ok ? "info" : "error",
        )
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
      const compact = (ctx.renderer?.terminalWidth ?? 80) < 76
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
          notify(copy().updated(v), "info")
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
            const now = Date.now()
            if (!result || !result.ok) {
              const cached = card()
              if (cached?.ok) {
                ctx.ui.dialog.alert({
                  title: `OpenCode Go · ${cached.org}${cached.email ? ` · ${cached.email}` : ""}`,
                  message: cardDetail(cached, now, l, [result?.error ?? c.failed], showRemaining()),
                })
                return
              }
              ctx.ui.toast.show({ message: result?.error ?? c.failed, variant: "error" })
              return
            }
            const extra = await fetchExtraLines(now)
            if (stopCtrl.signal.aborted) return
            if (result.rows.some((r) => r.used >= 100 || r.status === "limited")) {
              extra.push(c.fallbackHint)
            }
            ctx.ui.dialog.alert({
              title: `OpenCode Go · ${result.org}${result.email ? ` · ${result.email}` : ""}`,
              message: cardDetail(result, now, l, extra, showRemaining()),
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
      stopCtrl.abort()
      if (timer) clearTimeout(timer)
      stopChanged?.()
      stopPrefsChanged?.()
      stopUpdated?.()
      stopUsage()
      unslot()
    }
  },
})
