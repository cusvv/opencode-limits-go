import { createEffect, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js"
import { Command, Plugin, SettingsPage, Slot, Store, TitlebarItem } from "@opencode/plugin/gui"
import { Limits } from "./rpc.ts"
import { GUI_I18N } from "./gui/i18n.ts"
import {
  type BarPalette,
  CONSOLE_URL,
  type ConsoleBudget,
  CustomizePrefs,
  DisplayPrefs,
  ExtrasPrefs,
  type LangOverride,
  type Placement,
  Prefs,
  type PresetKey,
  type ResetFormat,
  SAMPLE_CARD,
  type StripDensity,
  type StripMode,
  StripPrefs,
  type StripResetMode,
  type StripStyle,
  type TimeFormat,
  type UpdateStatusInfo,
  type ZenActivityInfo,
} from "./gui/stores.ts"
import { LimitsStrip, MiniBar, SectionDivider, Sparkline, amberText } from "./gui/components.tsx"
import {
  type LimitCard,
  type LimitRow,
  type Locale,
  type VisibleWindows,
  type WindowKey,
  accountKey,
  alertMessage,
  burnSpikeMessage,
  cardText,
  detectBurnSpike,
  displayPercent,
  emptyCard,
  estimateWindowPace,
  formatTokensCompact,
  formatUsd,
  isAuthError,
  newAlerts,
  normalizeLocale,
  paceSummary,
  recoveredAlerts,
  relativeAge,
  resetAlertMessage,
  resetText,
  retry,
  rowWindowKey,
  selectStripRows,
  shortDate,
  shortErrorLabel,
  shouldHideStrip,
  sourceLabel,
  span,
  summarizeStatsByProvider,
  windowElapsedRatio,
  windowLabel,
  windowVerdict,
} from "./core/index.ts"

type I18nKey = keyof (typeof GUI_I18N)["en"]

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? ""))
}

export default Plugin.define({
  stores: {
    prefs: Store.global(Prefs, {
      placement: "bottom",
      showBars: true,
      alerts: true,
      autoUpdate: true,
    }),
    strip: Store.global(StripPrefs, {
      show5h: true,
      show1w: true,
      show1m: true,
      showPercent: true,
      showLabels: true,
    }),
    extras: Store.global(ExtrasPrefs, {
      monoBars: false,
      showZenStats: true,
      warnThreshold: 80,
      pollSeconds: 90,
    }),
    display: Store.global(DisplayPrefs, {
      showRemaining: false,
    }),
    custom: Store.global(CustomizePrefs, {
      stripMode: "selected",
      autoHideBelow: 0,
      palette: "traffic",
      density: "normal",
      stripReset: "exhausted",
      showPaceIcon: true,
      showElapsedTick: false,
      langOverride: "auto",
      timeFormat: "24h",
      resetFormat: "both",
      dialogPace: true,
      dialogSparkline: true,
      dialogSource: true,
      burnSpikePct: 20,
    }),
  },
  i18n: GUI_I18N,
  setup(ctx) {
    const ui = ctx.ui
    const prefs = ctx.stores.prefs
    const strip = ctx.stores.strip
    const extras = ctx.stores.extras
    const display = ctx.stores.display
    const custom = ctx.stores.custom

    const [card, setCard] = createSignal<LimitCard | null>(null)
    const [staleError, setStaleError] = createSignal("")
    const [zenActivity, setZenActivity] = createSignal<ZenActivityInfo | null>(null)
    const [ready, setReady] = createSignal(false)
    const [refreshing, setRefreshing] = createSignal(false)
    const [updateInfo, setUpdateInfo] = createSignal<UpdateStatusInfo | null>(null)
    const [updateBusy, setUpdateBusy] = createSignal(false)
    const notified = new Map<string, number>()
    const wasExhausted = new Set<string>()
    const riskNotified = new Map<string, string>()
    let notifiedUpdateVersion = ""
    let lastFocusRefreshAt = 0
    let lastSpikeAlertAt = 0
    let hiddenPollSkip = 0
    let currentAccount = ""
    let statusInflight = false

    const lang = (): Locale => {
      const ov = custom.value.langOverride
      if (ov === "en" || ov === "ru") return ov
      return normalizeLocale(ctx.locale.locale())
    }
    const light = () => ctx.appearance.mode() === "light"

    const t = (key: I18nKey, vars?: Record<string, string | number>): string => {
      if (custom.value.langOverride === "auto") {
        return ctx.t(key, vars)
      }
      return interpolate(GUI_I18N[lang()][key], vars)
    }

    const effectivePalette = (): BarPalette =>
      custom.value.palette === "traffic" && extras.value.monoBars ? "mono" : custom.value.palette

    function setPalette(next: BarPalette) {
      custom.update((d) => {
        d.palette = next
      })
      extras.update((d) => {
        d.monoBars = next === "mono"
      })
    }

    const visibleWindows = (): VisibleWindows => ({
      rolling: strip.value.show5h,
      weekly: strip.value.show1w,
      monthly: strip.value.show1m,
    })

    const activeWindowCount = () =>
      Number(strip.value.show5h) + Number(strip.value.show1w) + Number(strip.value.show1m)

    function pushSharedPrefs(patch: Record<string, unknown>) {
      void ctx.client.rpc(Limits).setPrefs(patch, { signal: ctx.signal }).catch(() => {
        if (ctx.signal.aborted) return
        ctx.toast.show({ variant: "error", title: t("settings.sharedFailed") })
        void pullSharedPrefs()
      })
    }

    async function pullSharedPrefs() {
      try {
        const shared = (await ctx.client.rpc(Limits).getPrefs({}, { signal: ctx.signal })) as {
          rolling?: boolean
          weekly?: boolean
          monthly?: boolean
          showRemaining?: boolean
          alerts?: boolean
          warnThreshold?: number
          burnSpikePct?: number
          langOverride?: string
        }
        if (!shared || ctx.signal.aborted) return
        if (
          typeof shared.rolling === "boolean" ||
          typeof shared.weekly === "boolean" ||
          typeof shared.monthly === "boolean"
        ) {
          strip.update((d) => {
            if (typeof shared.rolling === "boolean") d.show5h = shared.rolling
            if (typeof shared.weekly === "boolean") d.show1w = shared.weekly
            if (typeof shared.monthly === "boolean") d.show1m = shared.monthly
          })
        }
        if (typeof shared.showRemaining === "boolean") {
          display.update((d) => {
            d.showRemaining = shared.showRemaining!
          })
        }
        if (typeof shared.alerts === "boolean") {
          prefs.update((d) => {
            d.alerts = shared.alerts!
          })
        }
        if (typeof shared.warnThreshold === "number") {
          extras.update((d) => {
            d.warnThreshold = shared.warnThreshold!
          })
        }
        if (typeof shared.burnSpikePct === "number") {
          custom.update((d) => {
            d.burnSpikePct = shared.burnSpikePct!
          })
        }
        if (shared.langOverride === "auto" || shared.langOverride === "en" || shared.langOverride === "ru") {
          custom.update((d) => {
            d.langOverride = shared.langOverride as LangOverride
          })
        }
      } catch {}
    }

    function toggleWindow(key: WindowKey) {
      const v = visibleWindows()
      if (v[key] && activeWindowCount() <= 1) {
        ctx.toast.show({ variant: "default", title: t("settings.windows.last") })
        return
      }
      const next = { ...v, [key]: !v[key] }
      strip.update((draft) => {
        draft.show5h = next.rolling
        draft.show1w = next.weekly
        draft.show1m = next.monthly
      })
      pushSharedPrefs({ rolling: next.rolling, weekly: next.weekly, monthly: next.monthly })
    }

    function showAllWindows() {
      strip.update((draft) => {
        draft.show5h = true
        draft.show1w = true
        draft.show1m = true
      })
      pushSharedPrefs({ rolling: true, weekly: true, monthly: true })
    }

    const stripStyle = (): StripStyle => {
      if (!prefs.value.showBars) return "text"
      return strip.value.showPercent ? "bars_pct" : "bars"
    }

    function setStripStyle(next: StripStyle) {
      prefs.update((draft) => {
        draft.showBars = next !== "text"
      })
      strip.update((draft) => {
        draft.showPercent = next !== "bars"
      })
    }

    const activePreset = (): PresetKey | null => {
      if (custom.value.stripMode !== "selected") return null
      const s = strip.value
      const bars = prefs.value.showBars
      if (bars && s.show5h && s.show1w && s.show1m && s.showPercent && s.showLabels) return "standard"
      if (bars && s.show5h && !s.show1w && !s.show1m && s.showPercent && s.showLabels) return "only5h"
      if (!bars && s.show5h && s.show1w && s.show1m && s.showPercent && s.showLabels) return "text"
      if (!bars && s.show5h && !s.show1w && !s.show1m && s.showPercent && !s.showLabels) return "minimal"
      return null
    }

    function applyPreset(preset: PresetKey) {
      custom.update((d) => {
        d.stripMode = "selected"
      })
      if (preset === "standard") {
        strip.set({ show5h: true, show1w: true, show1m: true, showPercent: true, showLabels: true })
        prefs.update((d) => {
          d.showBars = true
        })
        pushSharedPrefs({ rolling: true, weekly: true, monthly: true })
      } else if (preset === "only5h") {
        strip.set({ show5h: true, show1w: false, show1m: false, showPercent: true, showLabels: true })
        prefs.update((d) => {
          d.showBars = true
        })
        pushSharedPrefs({ rolling: true, weekly: false, monthly: false })
      } else if (preset === "text") {
        strip.set({ show5h: true, show1w: true, show1m: true, showPercent: true, showLabels: true })
        prefs.update((d) => {
          d.showBars = false
        })
        pushSharedPrefs({ rolling: true, weekly: true, monthly: true })
      } else {
        strip.set({ show5h: true, show1w: false, show1m: false, showPercent: true, showLabels: false })
        prefs.update((d) => {
          d.showBars = false
        })
        pushSharedPrefs({ rolling: true, weekly: false, monthly: false })
      }
    }

    async function resetSettings() {
      const confirmed = await ctx.dialogs.confirm({
        title: t("settings.resetConfirm.title"),
        description: t("settings.resetConfirm.description"),
        confirm: t("settings.reset"),
        danger: true,
      })
      if (!confirmed || ctx.signal.aborted) return
      prefs.set({ placement: "bottom", showBars: true, alerts: true, autoUpdate: true })
      strip.set({ show5h: true, show1w: true, show1m: true, showPercent: true, showLabels: true })
      extras.set({ monoBars: false, showZenStats: true, warnThreshold: 80, pollSeconds: 90 })
      display.set({ showRemaining: false })
      custom.set({
        stripMode: "selected",
        autoHideBelow: 0,
        palette: "traffic",
        density: "normal",
        stripReset: "exhausted",
        showPaceIcon: true,
        showElapsedTick: false,
        langOverride: "auto",
        timeFormat: "24h",
        resetFormat: "both",
        dialogPace: true,
        dialogSparkline: true,
        dialogSource: true,
        burnSpikePct: 20,
      })
      void syncAutoUpdate(true)
      pushSharedPrefs({
        rolling: true,
        weekly: true,
        monthly: true,
        showRemaining: false,
        warnThreshold: 80,
        burnSpikePct: 20,
        langOverride: "auto",
      })
      pushSharedPrefs({ alerts: true })
      ctx.toast.show({ variant: "success", title: t("settings.resetDone") })
    }

    async function copyText(value: string) {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value)
          ctx.toast.show({ variant: "success", title: t("limits.copied") })
        }
      } catch {}
    }

    function copyDiagnostics() {
      const c = card()
      const info = updateInfo()
      const lines = [
        `opencode-limits-go v${info?.currentVersion ?? "unknown"}`,
        `managedByPackageManager: ${info?.managedByPackageManager ? "yes" : "no"}`,
        `status: ${c?.ok ? "ok" : "error"}`,
        c?.ok ? `source: ${c.source || "unknown"}` : `error: ${c?.error || "none"}`,
        c?.ok ? `usage: ${c.rows.map((r) => `${r.key ?? r.label}=${r.used}%`).join(", ")}` : "",
        `placement: ${prefs.value.placement} · mode: ${custom.value.stripMode} · palette: ${effectivePalette()}`,
      ].filter(Boolean)
      void copyText(lines.join("\n"))
    }

    const consoleUrl = () => zenActivity()?.usageUrl || CONSOLE_URL

    const stripTooltip = () => {
      const c = card()
      const l = lang()
      const base = t("command.limits")
      if (!c?.ok) {
        return c?.error ? `${base}\n${c.error}` : base
      }
      const now = Date.now()
      const rem = display.value.showRemaining
      const rowsText = c.rows
        .map((r) => {
          const rs = resetText(r.resetsAtMs, r.resetsIn, now, l)
          const pct = displayPercent(r.used, rem)
          return `${windowLabel(r, l)} ${pct}%${rem ? ` ${t("limits.left")}` : ""} (${rs.text})`
        })
        .join(" · ")
      const pace = paceSummary(c.rows, now, l, c.snapshots)
      const risk = c.rows
        .map((row) => windowVerdict(row, now, l, c.snapshots))
        .filter((v): v is NonNullable<typeof v> => v !== null && v.kind !== "fits")
        .map((v) => v.text)
      const z = extras.value.showZenStats ? zenActivity() : null
      const zenLine =
        z && z.today.zenCostUsd > 0
          ? `Zen: ${formatUsd(z.today.zenCostUsd)}`
          : z && z.today.goTokens > 0
            ? `${t("limits.todayGo")}: ${formatTokensCompact(z.today.goTokens)}`
            : ""
      const stale = staleError() ? t("limits.stale", { error: staleError() }) : ""
      return [base, rowsText, ...risk, pace?.text, zenLine, stale].filter(Boolean).join("\n")
    }

    const placementOptions = () => [
      { value: "bottom" as const, label: t("settings.placement.bottom") },
      { value: "top" as const, label: t("settings.placement.top") },
      { value: "both" as const, label: t("settings.placement.both") },
      { value: "titlebar" as const, label: t("settings.placement.titlebar") },
      { value: "hidden" as const, label: t("settings.placement.hidden") },
    ]

    function notifyUpdated(version: string) {
      if (!version || version === notifiedUpdateVersion || ctx.signal.aborted) return
      notifiedUpdateVersion = version
      ctx.toast.show({
        variant: "success",
        title: t("settings.update.installedToast", { version }),
      })
    }

    async function loadZenActivity() {
      if (!extras.value.showZenStats || ctx.signal.aborted) return
      try {
        const exp = (ctx.client as unknown as {
          experimental?: {
            usage?: {
              limits?: (input?: unknown, opts?: { signal?: AbortSignal }) => Promise<{
                data?: {
                  workspace?: { usageURL?: string }
                  budgets?: Array<{ id?: string; limit?: number; spent?: number; resetsAt?: number }>
                } | null
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

        const start = new Date()
        start.setHours(0, 0, 0, 0)
        const weekStart = Date.now() - 7 * 86_400_000
        const [limitsRes, statsRes, weekRes] = await Promise.all([
          exp?.usage?.limits?.(undefined, { signal: ctx.signal }).catch(() => null),
          exp?.session?.stats?.({ from: start.getTime() }, { signal: ctx.signal }).catch(() => null),
          exp?.session?.stats?.({ from: weekStart }, { signal: ctx.signal }).catch(() => null),
        ])
        if (ctx.signal.aborted) return
        const budgets: ConsoleBudget[] = Array.isArray(limitsRes?.data?.budgets)
          ? limitsRes.data.budgets
              .filter(
                (b): b is { id: string; limit: number; spent: number; resetsAt: number } =>
                  typeof b?.limit === "number" && b.limit > 0 && typeof b?.spent === "number",
              )
              .map((b) => ({
                id: typeof b.id === "string" ? b.id : "budget",
                limit: b.limit,
                spent: b.spent,
                resetsAt: typeof b.resetsAt === "number" ? b.resetsAt : 0,
              }))
          : []
        const today = summarizeStatsByProvider(statsRes?.models)
        const week = summarizeStatsByProvider(weekRes?.models)
        const usageUrl =
          typeof limitsRes?.data?.workspace?.usageURL === "string" &&
          limitsRes.data.workspace.usageURL.startsWith("https://")
            ? limitsRes.data.workspace.usageURL
            : undefined
        setZenActivity({ usageUrl, budgets, today, week })
      } catch {}
    }

    function notify(title: string, variant: "default" | "success" | "error"): void {
      ctx.toast.show({ variant, title })
      void ctx.attention
        ?.notify({ title, variant: variant === "error" ? "error" : "default" })
        .catch(() => {})
    }

    async function refresh(force = false): Promise<LimitCard | null> {
      if (ctx.signal.aborted) return null
      if (statusInflight) return card()
      statusInflight = true
      if (force) setRefreshing(true)
      try {
        const currentLang = lang()
        const maxAgeMs = extras.value.pollSeconds * 1000
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)])
        const result = (await ctx.client
          .rpc(Limits)
          .status({ force, lang: currentLang, maxAgeMs }, { signal })) as LimitCard
        if (ctx.signal.aborted) return null
        setReady(true)
        if (result.ok) {
          setCard(result)
          if (!result.stale) setStaleError("")
          void loadZenActivity()
          const now = Date.now()
          const acct = accountKey(result.org, result.email, result.source)
          const changedAccount = !!currentAccount && currentAccount !== acct
          if (changedAccount) {
            notified.clear()
            wasExhausted.clear()
            riskNotified.clear()
            lastSpikeAlertAt = 0
          }
          currentAccount = acct
          const triggered = newAlerts(result.rows, notified, extras.value.warnThreshold)
          const recovered = recoveredAlerts(result.rows, wasExhausted)
          if (prefs.value.alerts && !result.stale) {
            for (const row of triggered) {
              notify(alertMessage(row, now, currentLang), row.used >= 100 ? "error" : "default")
            }
            for (const row of recovered) {
              notify(resetAlertMessage(row, currentLang), "success")
            }
            for (const row of result.rows) {
              const verdict = windowVerdict(row, now, currentLang, result.snapshots)
              if (!verdict || verdict.kind === "fits") continue
              const id = row.key ?? row.label
              const signature = String(row.resetsAtMs ?? 0)
              if (riskNotified.get(id) === signature) continue
              riskNotified.set(id, signature)
              notify(verdict.text, verdict.kind === "exhausted" ? "error" : "default")
            }
            if (custom.value.burnSpikePct > 0 && now - lastSpikeAlertAt > 30 * 60_000) {
              const spike = detectBurnSpike(result.rows, result.snapshots, custom.value.burnSpikePct, now)
              if (spike) {
                lastSpikeAlertAt = now
                notify(burnSpikeMessage(spike, currentLang), "default")
              }
            }
          }
        } else if (card()?.ok) {
          setStaleError(result.error || t("limits.failed"))
        } else {
          setCard(result)
          setStaleError("")
        }
        return result
      } catch {
        if (ctx.signal.aborted) return null
        setReady(true)
        if (card()?.ok) {
          setStaleError(t("limits.noServer"))
        } else {
          setCard(emptyCard(t("limits.noServer")))
        }
        return null
      } finally {
        statusInflight = false
        if (force && !ctx.signal.aborted) setRefreshing(false)
      }
    }

    async function syncAutoUpdate(enabled: boolean) {
      try {
        await ctx.client.rpc(Limits).setUpdateConfig({ autoUpdate: enabled }, { signal: ctx.signal })
      } catch {}
    }

    async function checkUpdates(checkNow = false) {
      if (ctx.signal.aborted) return
      if (checkNow) setUpdateBusy(true)
      try {
        const res = (await ctx.client
          .rpc(Limits)
          .updateStatus(
            { check: checkNow, autoInstall: prefs.value.autoUpdate },
            { signal: ctx.signal },
          )) as UpdateStatusInfo
        if (ctx.signal.aborted) return
        setUpdateInfo(res)
        if (res.autoUpdated || res.restartRequired) {
          notifyUpdated(res.latestVersion)
        }
      } catch {
      } finally {
        if (checkNow && !ctx.signal.aborted) setUpdateBusy(false)
      }
    }

    async function runManualInstall() {
      if (ctx.signal.aborted) return
      setUpdateBusy(true)
      try {
        const res = (await ctx.client.rpc(Limits).installUpdate({}, { signal: ctx.signal })) as {
          ok: boolean
          version: string
          restartRequired: boolean
          error: string
        }
        if (ctx.signal.aborted) return
        if (!res.ok) {
          ctx.toast.show({ variant: "error", title: t("settings.update.failedToast", { error: res.error }) })
          return
        }
        if (res.restartRequired) notifyUpdated(res.version)
        await checkUpdates(false)
      } catch (error) {
        if (!ctx.signal.aborted) {
          ctx.toast.show({
            variant: "error",
            title: t("settings.update.failedToast", { error: String(error) }),
          })
        }
      } finally {
        if (!ctx.signal.aborted) setUpdateBusy(false)
      }
    }

    void retry(() => refresh(), (r) => r !== null, 5, undefined, ctx.signal).then(() => {
      if (ctx.signal.aborted) return
      void pullSharedPrefs()
      void syncAutoUpdate(prefs.value.autoUpdate)
      void checkUpdates(false)
    })

    createEffect(
      on(
        lang,
        () => {
          if (ready()) void refresh(false)
        },
        { defer: true },
      ),
    )

    // Idle-aware polling: slow down 3x when window is hidden/minimized.
    createEffect(() => {
      const ms = Math.max(30, extras.value.pollSeconds) * 1000
      const timer = setInterval(() => {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") {
          hiddenPollSkip += 1
          if (hiddenPollSkip < 3) return
          hiddenPollSkip = 0
        }
        void refresh()
      }, ms)
      onCleanup(() => clearInterval(timer))
    })

    if (typeof document !== "undefined") {
      const onVisible = () => {
        if (document.visibilityState !== "visible") return
        hiddenPollSkip = 0
        const now = Date.now()
        if (now - lastFocusRefreshAt < 15_000) return
        lastFocusRefreshAt = now
        void refresh(false)
      }
      document.addEventListener("visibilitychange", onVisible)
      onCleanup(() => document.removeEventListener("visibilitychange", onVisible))
    }

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
      const stopChanged = rpcClient.events?.on?.("changed", () => void refresh(), { signal: ctx.signal })
      if (stopChanged) onCleanup(stopChanged)
      const stopPrefsChanged = rpcClient.events?.on?.("prefsChanged", () => void pullSharedPrefs(), {
        signal: ctx.signal,
      })
      if (stopPrefsChanged) onCleanup(stopPrefsChanged)
      const stopUpdated = rpcClient.events?.on?.(
        "updated",
        (ev) => {
          const v = ev?.data?.version
          if (v) {
            notifyUpdated(v)
            void checkUpdates(false)
          }
        },
        { signal: ctx.signal },
      )
      if (stopUpdated) onCleanup(stopUpdated)
    } catch {}

    function SettingField(props: {
      page?: boolean
      id: string
      title: string
      description: string
      children: JSX.Element
    }) {
      return (
        <Show
          when={props.page}
          fallback={
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;box-sizing:border-box;">
              <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;">
                <div style="font-size:13px;font-weight:500;">{props.title}</div>
                <div style="font-size:11px;opacity:.65;">{props.description}</div>
              </div>
              <div style="flex-shrink:0;display:flex;align-items:center;">{props.children}</div>
            </div>
          }
        >
          <ui.SettingsRow id={props.id} title={props.title} description={props.description}>
            {props.children}
          </ui.SettingsRow>
        </Show>
      )
    }

    function StripFields(props: { page?: boolean; compact?: boolean }) {
      const previewCard = () => (card()?.ok ? card()! : SAMPLE_CARD)
      const previewBannerStyle = () => {
        const border = light() ? "rgba(0,0,0,.1)" : "rgba(255,255,255,.1)"
        const bg = light() ? "rgba(0,0,0,.03)" : "rgba(255,255,255,.03)"
        return `width:100%;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;border-radius:8px;border:1px solid ${border};background:${bg};`
      }
      const winItems: Array<{ key: WindowKey; active: () => boolean }> = [
        { key: "rolling", active: () => strip.value.show5h },
        { key: "weekly", active: () => strip.value.show1w },
        { key: "monthly", active: () => strip.value.show1m },
      ]
      const styleOptions = () => [
        { value: "bars_pct" as const, label: t("settings.style.bars_pct") },
        { value: "text" as const, label: t("settings.style.text") },
        { value: "bars" as const, label: t("settings.style.bars") },
      ]
      const stripModeOptions = () => [
        { value: "selected" as const, label: t("settings.stripMode.selected") },
        { value: "tightest" as const, label: t("settings.stripMode.tightest") },
      ]
      const autoHideOptions = () => [
        { value: "0" as const, label: t("settings.autoHide.0") },
        { value: "50" as const, label: t("settings.autoHide.50") },
        { value: "70" as const, label: t("settings.autoHide.70") },
        { value: "80" as const, label: t("settings.autoHide.80") },
      ]
      const paletteOptions = () => [
        { value: "traffic" as const, label: t("settings.palette.traffic") },
        { value: "mono" as const, label: t("settings.palette.mono") },
        { value: "calm" as const, label: t("settings.palette.calm") },
        { value: "stealth" as const, label: t("settings.palette.stealth") },
      ]
      const densityOptions = () => [
        { value: "compact" as const, label: t("settings.density.compact") },
        { value: "normal" as const, label: t("settings.density.normal") },
        { value: "wide" as const, label: t("settings.density.wide") },
      ]
      const stripResetOptions = () => [
        { value: "never" as const, label: t("settings.stripReset.never") },
        { value: "exhausted" as const, label: t("settings.stripReset.exhausted") },
        { value: "warn" as const, label: t("settings.stripReset.warn") },
        { value: "always" as const, label: t("settings.stripReset.always") },
      ]
      const presetItems: Array<{ key: PresetKey; label: () => string }> = [
        { key: "standard", label: () => t("settings.presets.standard") },
        { key: "only5h", label: () => t("settings.presets.only5h") },
        { key: "text", label: () => t("settings.presets.text") },
        { key: "minimal", label: () => t("settings.presets.minimal") },
      ]

      const previewStrip = () => (
        <LimitsStrip
          card={previewCard()}
          ready={true}
          lang={lang()}
          light={light()}
          showBars={prefs.value.showBars}
          showPercent={strip.value.showPercent}
          showLabels={strip.value.showLabels}
          showRemaining={display.value.showRemaining}
          palette={effectivePalette()}
          density={custom.value.density}
          stripMode={custom.value.stripMode}
          stripReset={custom.value.stripReset}
          showPaceIcon={custom.value.showPaceIcon}
          showElapsedTick={custom.value.showElapsedTick}
          warnAt={extras.value.warnThreshold}
          visible={visibleWindows()}
          variant={prefs.value.placement === "top" ? "top" : "bottom"}
          preview
          onOpen={() => {}}
        />
      )

      const presetButtons = () => (
        <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:flex-end;">
          <For each={presetItems}>
            {(item) => (
              <ui.Button
                size="small"
                variant={activePreset() === item.key ? "contrast" : "neutral"}
                onClick={() => applyPreset(item.key)}
              >
                {item.label()}
              </ui.Button>
            )}
          </For>
        </div>
      )

      return (
        <>
          <Show
            when={props.page}
            fallback={
              <div style={previewBannerStyle()}>
                <span style="font-size:11px;opacity:.65;flex-shrink:0;">{t("settings.preview.label")}</span>
                <div style="min-width:0;overflow:hidden;display:flex;justify-content:flex-end;">
                  {previewStrip()}
                </div>
              </div>
            }
          >
            <ui.SettingsRow
              id="opencode-limits-go-preview"
              title={t("settings.preview.label")}
              description={t(`settings.placement.${prefs.value.placement}` as I18nKey)}
            >
              {previewStrip()}
            </ui.SettingsRow>
          </Show>
          <Show
            when={props.page}
            fallback={
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;box-sizing:border-box;">
                <span style="font-size:12px;opacity:.75;flex-shrink:0;">{t("settings.presets.title")}</span>
                {presetButtons()}
              </div>
            }
          >
            <ui.SettingsRow id="opencode-limits-go-presets" title={t("settings.presets.title")}>
              {presetButtons()}
            </ui.SettingsRow>
          </Show>
          <SettingField
            page={props.page}
            id="opencode-limits-go-placement"
            title={t("settings.placement.title")}
            description={t("settings.placement.description")}
          >
            <ui.Select<Placement>
              label={t("settings.placement.title")}
              options={placementOptions()}
              value={prefs.value.placement}
              onChange={(value) =>
                prefs.update((draft) => {
                  draft.placement = value
                })
              }
            />
          </SettingField>
          <Show when={!props.compact}>
            <SettingField
              page={props.page}
              id="opencode-limits-go-stripmode"
              title={t("settings.stripMode.title")}
              description={t("settings.stripMode.description")}
            >
              <ui.Select<StripMode>
                label={t("settings.stripMode.title")}
                options={stripModeOptions()}
                value={custom.value.stripMode}
                onChange={(value) =>
                  custom.update((d) => {
                    d.stripMode = value
                  })
                }
              />
            </SettingField>
          </Show>
          <Show when={custom.value.stripMode === "selected" || props.compact}>
            <SettingField
              page={props.page}
              id="opencode-limits-go-windows"
              title={t("settings.windows.title")}
              description={t("settings.windows.description")}
            >
              <div style="display:flex;align-items:center;gap:4px;flex-wrap:nowrap;">
                <For each={winItems}>
                  {(item) => (
                    <ui.Button
                      size="small"
                      variant={item.active() ? "contrast" : "neutral"}
                      onClick={() => toggleWindow(item.key)}
                    >
                      {windowLabel({ key: item.key, label: item.key }, lang())}
                    </ui.Button>
                  )}
                </For>
                <Show when={activeWindowCount() < 3}>
                  <ui.Button size="small" variant="ghost" onClick={showAllWindows}>
                    {t("settings.windows.all")}
                  </ui.Button>
                </Show>
              </div>
            </SettingField>
          </Show>
          <SettingField
            page={props.page}
            id="opencode-limits-go-style"
            title={t("settings.style.title")}
            description={t("settings.style.description")}
          >
            <ui.Select<StripStyle>
              label={t("settings.style.title")}
              options={styleOptions()}
              value={stripStyle()}
              onChange={setStripStyle}
            />
          </SettingField>
          <SettingField
            page={props.page}
            id="opencode-limits-go-remaining"
            title={t("settings.remaining.title")}
            description={t("settings.remaining.description")}
          >
            <ui.Switch
              label={t("settings.remaining.title")}
              hideLabel
              checked={display.value.showRemaining}
              onChange={(checked) => {
                display.update((draft) => {
                  draft.showRemaining = checked
                })
                pushSharedPrefs({ showRemaining: checked })
              }}
            />
          </SettingField>
          <Show when={props.compact}>
            <SettingField
              page={props.page}
              id="opencode-limits-go-palette"
              title={t("settings.palette.title")}
              description={t("settings.palette.description")}
            >
              <ui.Select<BarPalette>
                label={t("settings.palette.title")}
                options={paletteOptions()}
                value={effectivePalette()}
                onChange={setPalette}
              />
            </SettingField>
          </Show>
          <Show when={!props.compact}>
            <SettingField
              page={props.page}
              id="opencode-limits-go-palette"
              title={t("settings.palette.title")}
              description={t("settings.palette.description")}
            >
              <ui.Select<BarPalette>
                label={t("settings.palette.title")}
                options={paletteOptions()}
                value={effectivePalette()}
                onChange={setPalette}
              />
            </SettingField>
            <SettingField
              page={props.page}
              id="opencode-limits-go-density"
              title={t("settings.density.title")}
              description={t("settings.density.description")}
            >
              <ui.Select<StripDensity>
                label={t("settings.density.title")}
                options={densityOptions()}
                value={custom.value.density}
                onChange={(value) =>
                  custom.update((d) => {
                    d.density = value
                  })
                }
              />
            </SettingField>
            <SettingField
              page={props.page}
              id="opencode-limits-go-autohide"
              title={t("settings.autoHide.title")}
              description={t("settings.autoHide.description")}
            >
              <ui.Select<string>
                label={t("settings.autoHide.title")}
                options={autoHideOptions()}
                value={String(custom.value.autoHideBelow)}
                onChange={(value) =>
                  custom.update((d) => {
                    d.autoHideBelow = Number(value)
                  })
                }
              />
            </SettingField>
            <SettingField
              page={props.page}
              id="opencode-limits-go-stripreset"
              title={t("settings.stripReset.title")}
              description={t("settings.stripReset.description")}
            >
              <ui.Select<StripResetMode>
                label={t("settings.stripReset.title")}
                options={stripResetOptions()}
                value={custom.value.stripReset}
                onChange={(value) =>
                  custom.update((d) => {
                    d.stripReset = value
                  })
                }
              />
            </SettingField>
            <SettingField
              page={props.page}
              id="opencode-limits-go-labels"
              title={t("settings.labels.title")}
              description={t("settings.labels.description")}
            >
              <ui.Switch
                label={t("settings.labels.title")}
                hideLabel
                checked={strip.value.showLabels}
                onChange={(checked) =>
                  strip.update((draft) => {
                    draft.showLabels = checked
                  })
                }
              />
            </SettingField>
            <SettingField
              page={props.page}
              id="opencode-limits-go-paceicon"
              title={t("settings.paceIcon.title")}
              description={t("settings.paceIcon.description")}
            >
              <ui.Switch
                label={t("settings.paceIcon.title")}
                hideLabel
                checked={custom.value.showPaceIcon}
                onChange={(checked) =>
                  custom.update((d) => {
                    d.showPaceIcon = checked
                  })
                }
              />
            </SettingField>
            <SettingField
              page={props.page}
              id="opencode-limits-go-elapsedtick"
              title={t("settings.elapsedTick.title")}
              description={t("settings.elapsedTick.description")}
            >
              <ui.Switch
                label={t("settings.elapsedTick.title")}
                hideLabel
                checked={custom.value.showElapsedTick}
                onChange={(checked) =>
                  custom.update((d) => {
                    d.showElapsedTick = checked
                  })
                }
              />
            </SettingField>
          </Show>
        </>
      )
    }

    function DialogFields(props: { page?: boolean }) {
      const timeOptions = () => [
        { value: "24h" as const, label: t("settings.timeFormat.24h") },
        { value: "12h" as const, label: t("settings.timeFormat.12h") },
      ]
      const resetOptions = () => [
        { value: "both" as const, label: t("settings.resetFormat.both") },
        { value: "relative" as const, label: t("settings.resetFormat.relative") },
        { value: "absolute" as const, label: t("settings.resetFormat.absolute") },
      ]
      return (
        <>
          <SettingField
            page={props.page}
            id="opencode-limits-go-timeformat"
            title={t("settings.timeFormat.title")}
            description={t("settings.timeFormat.description")}
          >
            <ui.Select<TimeFormat>
              label={t("settings.timeFormat.title")}
              options={timeOptions()}
              value={custom.value.timeFormat}
              onChange={(value) =>
                custom.update((d) => {
                  d.timeFormat = value
                })
              }
            />
          </SettingField>
          <SettingField
            page={props.page}
            id="opencode-limits-go-resetformat"
            title={t("settings.resetFormat.title")}
            description={t("settings.resetFormat.description")}
          >
            <ui.Select<ResetFormat>
              label={t("settings.resetFormat.title")}
              options={resetOptions()}
              value={custom.value.resetFormat}
              onChange={(value) =>
                custom.update((d) => {
                  d.resetFormat = value
                })
              }
            />
          </SettingField>
          <SettingField
            page={props.page}
            id="opencode-limits-go-dialogpace"
            title={t("settings.dialogPace.title")}
            description={t("settings.dialogPace.description")}
          >
            <ui.Switch
              label={t("settings.dialogPace.title")}
              hideLabel
              checked={custom.value.dialogPace}
              onChange={(checked) =>
                custom.update((d) => {
                  d.dialogPace = checked
                })
              }
            />
          </SettingField>
          <SettingField
            page={props.page}
            id="opencode-limits-go-sparkline"
            title={t("settings.dialogSparkline.title")}
            description={t("settings.dialogSparkline.description")}
          >
            <ui.Switch
              label={t("settings.dialogSparkline.title")}
              hideLabel
              checked={custom.value.dialogSparkline}
              onChange={(checked) =>
                custom.update((d) => {
                  d.dialogSparkline = checked
                })
              }
            />
          </SettingField>
          <SettingField
            page={props.page}
            id="opencode-limits-go-zenstats"
            title={t("settings.zenStats.title")}
            description={t("settings.zenStats.description")}
          >
            <ui.Switch
              label={t("settings.zenStats.title")}
              hideLabel
              checked={extras.value.showZenStats}
              onChange={(checked) => {
                extras.update((draft) => {
                  draft.showZenStats = checked
                })
                if (checked) void loadZenActivity()
              }}
            />
          </SettingField>
          <SettingField
            page={props.page}
            id="opencode-limits-go-dialogsource"
            title={t("settings.dialogSource.title")}
            description={t("settings.dialogSource.description")}
          >
            <ui.Switch
              label={t("settings.dialogSource.title")}
              hideLabel
              checked={custom.value.dialogSource}
              onChange={(checked) =>
                custom.update((d) => {
                  d.dialogSource = checked
                })
              }
            />
          </SettingField>
        </>
      )
    }

    function NotificationFields(props: { page?: boolean; compact?: boolean }) {
      const thresholdOptions = () => [
        { value: "70" as const, label: t("settings.threshold.70") },
        { value: "80" as const, label: t("settings.threshold.80") },
        { value: "90" as const, label: t("settings.threshold.90") },
        { value: "0" as const, label: t("settings.threshold.0") },
      ]
      const spikeOptions = () => [
        { value: "0" as const, label: t("settings.burnSpike.0") },
        { value: "15" as const, label: t("settings.burnSpike.15") },
        { value: "20" as const, label: t("settings.burnSpike.20") },
        { value: "30" as const, label: t("settings.burnSpike.30") },
      ]
      return (
        <>
          <SettingField
            page={props.page}
            id="opencode-limits-go-alerts"
            title={t("settings.alerts.title")}
            description={t("settings.alerts.description")}
          >
            <ui.Switch
              label={t("settings.alerts.title")}
              hideLabel
              checked={prefs.value.alerts}
              onChange={(checked) => {
                prefs.update((draft) => {
                  draft.alerts = checked
                })
                pushSharedPrefs({ alerts: checked })
              }}
            />
          </SettingField>
          <SettingField
            page={props.page}
            id="opencode-limits-go-threshold"
            title={t("settings.threshold.title")}
            description={t("settings.threshold.description")}
          >
            <ui.Select<string>
              label={t("settings.threshold.title")}
              options={thresholdOptions()}
              value={String(extras.value.warnThreshold)}
              onChange={(value) => {
                const next = Number(value)
                extras.update((draft) => {
                  draft.warnThreshold = next
                })
                pushSharedPrefs({ warnThreshold: next })
              }}
            />
          </SettingField>
          <Show when={!props.compact}>
            <SettingField
              page={props.page}
              id="opencode-limits-go-burnspike"
              title={t("settings.burnSpike.title")}
              description={t("settings.burnSpike.description")}
            >
              <ui.Select<string>
                label={t("settings.burnSpike.title")}
                options={spikeOptions()}
                value={String(custom.value.burnSpikePct)}
                onChange={(value) => {
                  const next = Number(value)
                  custom.update((d) => {
                    d.burnSpikePct = next
                  })
                  pushSharedPrefs({ burnSpikePct: next })
                }}
              />
            </SettingField>
          </Show>
        </>
      )
    }

    function BehaviorFields(props: { page?: boolean; compact?: boolean }) {
      const langOptions = () => [
        { value: "auto" as const, label: t("settings.lang.auto") },
        { value: "en" as const, label: t("settings.lang.en") },
        { value: "ru" as const, label: t("settings.lang.ru") },
      ]
      const pollOptions = () => [
        { value: "30" as const, label: t("settings.poll.30") },
        { value: "90" as const, label: t("settings.poll.90") },
        { value: "300" as const, label: t("settings.poll.300") },
      ]
      return (
        <>
          <SettingField
            page={props.page}
            id="opencode-limits-go-lang"
            title={t("settings.lang.title")}
            description={t("settings.lang.description")}
          >
            <ui.Select<LangOverride>
              label={t("settings.lang.title")}
              options={langOptions()}
              value={custom.value.langOverride}
              onChange={(value) => {
                custom.update((d) => {
                  d.langOverride = value
                })
                pushSharedPrefs({ langOverride: value })
              }}
            />
          </SettingField>
          <Show when={!props.compact}>
            <SettingField
              page={props.page}
              id="opencode-limits-go-poll"
              title={t("settings.poll.title")}
              description={t("settings.poll.description")}
            >
              <ui.Select<string>
                label={t("settings.poll.title")}
                options={pollOptions()}
                value={String(extras.value.pollSeconds)}
                onChange={(value) =>
                  extras.update((draft) => {
                    draft.pollSeconds = Number(value)
                  })
                }
              />
            </SettingField>
            <SettingField
              page={props.page}
              id="opencode-limits-go-diagnostics"
              title={t("settings.diagnostics.title")}
              description={t("settings.diagnostics.description")}
            >
              <ui.Button variant="neutral" size="small" icon="copy" onClick={copyDiagnostics}>
                {t("settings.diagnostics.copy")}
              </ui.Button>
            </SettingField>
          </Show>
        </>
      )
    }

    function updateDescription(): string {
      const info = updateInfo()
      if (!info) return t("settings.version.checking")
      if (info.restartRequired) return t("settings.version.restart", { version: info.latestVersion })
      if (info.error) return t("settings.version.error", { version: info.currentVersion, error: info.error })
      if (info.updateAvailable) {
        if (info.managedByDev) {
          return t("settings.version.dev", { current: info.currentVersion, latest: info.latestVersion })
        }
        if (info.managedByPackageManager) {
          return t("settings.version.managed", { current: info.currentVersion, latest: info.latestVersion })
        }
        return t("settings.version.available", { current: info.currentVersion, latest: info.latestVersion })
      }
      return t("settings.version.upToDate", { version: info.currentVersion })
    }

    function UpdateFields(props: { page?: boolean }) {
      const isManaged = () => !!updateInfo()?.managedByPackageManager || !!updateInfo()?.managedByDev
      const canInstall = () =>
        !!updateInfo()?.updateAvailable && !updateInfo()?.restartRequired && !isManaged()
      return (
        <>
          <Show
            when={!isManaged()}
            fallback={
              <SettingField
                page={props.page}
                id="opencode-limits-go-autoupdate"
                title={t("settings.autoUpdate.title")}
                description={
                  updateInfo()?.managedByDev ? t("settings.autoUpdate.dev") : t("settings.autoUpdate.managed")
                }
              >
                <span style="font-size:11px;opacity:.55;">{updateInfo()?.managedByDev ? "git" : "CLI"}</span>
              </SettingField>
            }
          >
            <SettingField
              page={props.page}
              id="opencode-limits-go-autoupdate"
              title={t("settings.autoUpdate.title")}
              description={t("settings.autoUpdate.description")}
            >
              <ui.Switch
                label={t("settings.autoUpdate.title")}
                hideLabel
                checked={prefs.value.autoUpdate}
                onChange={(checked) => {
                  prefs.update((draft) => {
                    draft.autoUpdate = checked
                  })
                  void syncAutoUpdate(checked)
                }}
              />
            </SettingField>
          </Show>
          <SettingField
            page={props.page}
            id="opencode-limits-go-version"
            title={t("settings.version.title")}
            description={updateDescription()}
          >
            <Show
              when={canInstall()}
              fallback={
                <ui.Button
                  variant="neutral"
                  size="small"
                  icon="refresh"
                  busy={updateBusy()}
                  onClick={() => void checkUpdates(true)}
                >
                  {t("settings.update.check")}
                </ui.Button>
              }
            >
              <ui.Button
                variant="contrast"
                size="small"
                icon="download"
                busy={updateBusy()}
                onClick={() => void runManualInstall()}
              >
                {t("settings.update.install")}
              </ui.Button>
            </Show>
          </SettingField>
        </>
      )
    }

    function openSettingsDialog() {
      void checkUpdates(false)
      ctx.dialogs.open((dialog) => (
        <ui.Dialog
          title={t("settings.title")}
          description={t("settings.description")}
          size="fit"
          footer={
            <div style="display:flex;align-items:center;justify-content:space-between;width:100%;gap:8px;">
              <div style="display:flex;align-items:center;gap:4px;">
                <ui.Button
                  variant="ghost"
                  icon="sliders"
                  onClick={() => {
                    dialog.close()
                    ctx.layout.settings(ctx.id)
                  }}
                >
                  {t("settings.openAll")}
                </ui.Button>
                <ui.Button variant="ghost-muted" size="small" onClick={() => void resetSettings()}>
                  {t("settings.reset")}
                </ui.Button>
              </div>
              <ui.Button variant="contrast" onClick={dialog.close}>
                {t("settings.done")}
              </ui.Button>
            </div>
          }
        >
          <div style="display:flex;flex-direction:column;gap:10px;width:100%;box-sizing:border-box;">
            <StripFields compact />
            <SectionDivider label={t("settings.section.behavior")} light={light()} />
            <BehaviorFields compact />
            <SectionDivider label={t("settings.section.notifications")} light={light()} />
            <NotificationFields compact />
          </div>
        </ui.Dialog>
      ))
    }

    function openErrorDialog(errorMsg: string) {
      ctx.dialogs.open((dialog) => {
        const [err, setErr] = createSignal(errorMsg)
        const handleRetry = async () => {
          const next = await refresh(true)
          if (ctx.signal.aborted) return
          if (next?.ok) {
            dialog.close()
            openCard(next)
          } else {
            setErr(next?.error || t("limits.failed"))
          }
        }
        const showAuthHint = () => {
          const raw = err().toLowerCase()
          return isAuthError(raw) || raw.includes("no_token") || raw.includes("no token") || raw.includes("нет токена")
        }
        return (
          <ui.Dialog
            title={t("limits.errorTitle")}
            size="fit"
            footer={
              <div style="display:flex;align-items:center;justify-content:space-between;width:100%;gap:8px;">
                <div style="display:flex;align-items:center;gap:6px;">
                  <ui.Tooltip value={t("limits.settings")}>
                    <ui.IconButton
                      icon="settings-gear"
                      label={t("limits.settings")}
                      variant="neutral"
                      onClick={() => {
                        dialog.close()
                        openSettingsDialog()
                      }}
                    />
                  </ui.Tooltip>
                  <ui.Button
                    variant="neutral"
                    size="small"
                    icon="copy"
                    onClick={() => void copyText("opencode auth login")}
                  >
                    {t("limits.copyLogin")}
                  </ui.Button>
                  <ui.Button
                    variant="neutral"
                    size="small"
                    icon="square-arrow-top-right"
                    onClick={() => ctx.system.openExternal(consoleUrl())}
                  >
                    {t("limits.console")}
                  </ui.Button>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                  <ui.Button variant="contrast" icon="refresh" busy={refreshing()} onClick={() => void handleRetry()}>
                    {t("limits.retry")}
                  </ui.Button>
                  <ui.Button variant="neutral" onClick={dialog.close}>
                    {t("limits.close")}
                  </ui.Button>
                </div>
              </div>
            }
          >
            <div style="display:flex;flex-direction:column;gap:8px;max-width:460px;font-size:12px;">
              <div style={`padding:8px 10px;border-radius:8px;border:1px solid rgba(239,68,68,.35);background:rgba(239,68,68,.08);color:${light() ? "#dc2626" : "#ef4444"};word-break:break-word;`}>
                {err()}
              </div>
              <Show when={showAuthHint()}>
                <div style="font-size:11px;opacity:.75;">{t("limits.errorAuthHint")}</div>
              </Show>
            </div>
          </ui.Dialog>
        )
      })
    }

    function openCard(initial: LimitCard) {
      void loadZenActivity()
      ctx.dialogs.open((dialog) => {
        const [now, setNow] = createSignal(Date.now())
        const tick = setInterval(() => setNow(Date.now()), 30_000)
        onCleanup(() => clearInterval(tick))

        const current = () => {
          const latest = card()
          return latest?.ok ? latest : initial
        }

        const description = () => {
          const c = current()
          const age = relativeAge(c.checkedAtMs, now(), lang())
          const updatedPart = age ? t("limits.updated", { age }) : c.checkedAt
          return [c.org, c.email, updatedPart].filter(Boolean).join(" · ")
        }

        const handleRefresh = async () => {
          await refresh(true)
          if (ctx.signal.aborted) return
          setNow(Date.now())
          // A failed refresh is shown by the stale banner; a second toast would duplicate it.
        }

        const pace = () => paceSummary(current().rows, now(), lang(), current().snapshots)
        const hasExhausted = () => current().rows.some((r) => r.used >= 100 || r.status === "limited")
        const paceCardStyle = () => {
          const k = pace()?.kind
          if (k === "exhausted") {
            return "font-size:11px;padding:7px 10px;border-radius:8px;border:1px solid rgba(239,68,68,.35);background:rgba(239,68,68,.08);color:#ef4444;"
          }
          if (k === "hot") {
            return `font-size:11px;padding:7px 10px;border-radius:8px;border:1px solid rgba(245,158,11,.35);background:rgba(245,158,11,.08);color:${amberText(light())};`
          }
          const border = light() ? "rgba(0,0,0,.1)" : "rgba(255,255,255,.1)"
          const bg = light() ? "rgba(0,0,0,.03)" : "rgba(255,255,255,.03)"
          return `font-size:11px;padding:7px 10px;border-radius:8px;border:1px solid ${border};background:${bg};opacity:.85;`
        }
        const zenBoxStyle = () => {
          const border = light() ? "rgba(0,0,0,.1)" : "rgba(255,255,255,.1)"
          const bg = light() ? "rgba(0,0,0,.025)" : "rgba(255,255,255,.025)"
          return `display:flex;flex-direction:column;gap:5px;padding:8px 10px;border-radius:8px;border:1px solid ${border};background:${bg};font-size:11px;`
        }
        const zenLeft = () => {
          const z = zenActivity()
          if (!z?.budgets.length) return ""
          const left = z.budgets.reduce((sum, budget) => sum + Math.max(0, budget.limit - budget.spent), 0)
          return left > 0 ? t("limits.zenLeft", { amount: formatUsd(left) }) : ""
        }
        const showZenLeft = () => !!zenLeft() && (hasExhausted() || pace()?.kind === "hot")
        const hasZenDetails = () => {
          if (!extras.value.showZenStats) return false
          const z = zenActivity()
          if (!z) return false
          return (
            z.budgets.length > 0 ||
            z.today.goTokens > 0 ||
            z.today.zenTokens > 0 ||
            z.today.zenCostUsd > 0 ||
            z.today.topModels.length > 0 ||
            z.week.goTokens > 0 ||
            z.week.zenTokens > 0 ||
            z.week.zenCostUsd > 0
          )
        }

        return (
          <ui.Dialog
            title={t("command.limits")}
            description={description()}
            size="fit"
            footer={
              <div style="display:flex;align-items:center;justify-content:space-between;width:100%;gap:8px;">
                <div style="display:flex;align-items:center;gap:6px;">
                  <ui.Tooltip value={t("limits.settings")}>
                    <ui.IconButton
                      icon="settings-gear"
                      label={t("limits.settings")}
                      variant="neutral"
                      onClick={() => {
                        dialog.close()
                        openSettingsDialog()
                      }}
                    />
                  </ui.Tooltip>
                  <ui.Tooltip value={t("limits.consoleHint")}>
                    <ui.Button
                      variant="neutral"
                      size="small"
                      icon="square-arrow-top-right"
                      onClick={() => ctx.system.openExternal(consoleUrl())}
                    >
                      {t("limits.console")}
                    </ui.Button>
                  </ui.Tooltip>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                  <ui.Button
                    variant="neutral"
                    icon="refresh"
                    busy={refreshing()}
                    onClick={() => void handleRefresh()}
                  >
                    {t("limits.refresh")}
                  </ui.Button>
                  <ui.Button variant="contrast" autofocus onClick={dialog.close}>
                    {t("limits.close")}
                  </ui.Button>
                </div>
              </div>
            }
          >
            <div style="display:flex;flex-direction:column;gap:9px;width:100%;box-sizing:border-box;">
              <Show when={staleError()}>
                <div
                  style={`font-size:11px;padding:6px 9px;border-radius:6px;border:1px solid rgba(245,158,11,.35);background:rgba(245,158,11,.08);color:${amberText(light())};`}
                >
                  {t("limits.stale", { error: staleError() })}
                </div>
              </Show>
              <For each={current().rows}>
                {(row: LimitRow) => {
                  const key = () => rowWindowKey(row)
                  const isVisibleOnStrip = () => {
                    const k = key()
                    return k ? visibleWindows()[k] : true
                  }
                  const resetLine = () => {
                    const r = resetText(row.resetsAtMs, row.resetsIn, now(), lang())
                    const dateStr = row.resetsAtMs ? shortDate(row.resetsAtMs, custom.value.timeFormat) : row.resetsAt
                    const fmt = custom.value.resetFormat
                    if (fmt === "absolute") return `${t("limits.reset")} ${dateStr}`
                    if (fmt === "relative") return r.passed ? r.text : `${t("limits.reset")} ${t("limits.in")} ${r.text}`
                    return r.passed
                      ? `${t("limits.reset")} ${dateStr} · ${r.text}`
                      : `${t("limits.reset")} ${dateStr} · ${t("limits.in")} ${r.text}`
                  }
                  const rowPace = () => estimateWindowPace(row, now(), lang(), current().snapshots)
                  const verdict = () => windowVerdict(row, now(), lang(), current().snapshots)
                  const elapsed = () => windowElapsedRatio(row, now())
                  const deltaTooltip = () =>
                    row.deltaSpanMs && row.deltaSpanMs > 0
                      ? t("limits.deltaSpan", { span: span(row.deltaSpanMs, lang()) })
                      : t("limits.deltaHint")
                  return (
                    <div style="display:flex;align-items:center;gap:8px;font-size:12px;">
                      <ui.Tooltip value={t("limits.toggleRowHint")}>
                        <button
                          type="button"
                          aria-pressed={isVisibleOnStrip()}
                          aria-label={`${windowLabel(row, lang())}: ${isVisibleOnStrip() ? t("limits.hideOnStrip") : t("limits.showOnStrip")}`}
                          onClick={() => {
                            const k = key()
                            if (k) toggleWindow(k)
                          }}
                          style={`min-width:32px;min-height:24px;padding:0 2px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;flex-shrink:0;opacity:${isVisibleOnStrip() ? ".85" : ".35"};`}
                        >
                          {windowLabel(row, lang())}
                        </button>
                      </ui.Tooltip>
                      <ui.Tooltip value={t("limits.elapsedLegend")}>
                        <span style="display:inline-flex;align-items:center;">
                          <MiniBar
                            used={row.used}
                            width={72}
                            light={light()}
                            palette={effectivePalette()}
                            warnAt={extras.value.warnThreshold}
                            elapsedRatio={elapsed()}
                          />
                        </span>
                      </ui.Tooltip>
                      <span style="width:42px;text-align:right;font-variant-numeric:tabular-nums;flex-shrink:0;">
                        {displayPercent(row.used, display.value.showRemaining)}%
                      </span>
                      <span style="opacity:.7;font-size:11px;min-width:0;flex:1;">
                        {resetLine()}
                        {row.status === "limited" ? ` · ${t("limits.limited")}` : row.status !== "ok" ? ` · ${row.status}` : ""}
                        {verdict() && verdict()!.kind !== "fits" ? ` · ${verdict()!.text}` : ""}
                      </span>
                      <Show when={row.delta1h && row.delta1h > 0}>
                        <ui.Tooltip value={deltaTooltip()}>
                          <span style="font-size:10px;opacity:.6;font-variant-numeric:tabular-nums;flex-shrink:0;">
                            +{row.delta1h}%
                          </span>
                        </ui.Tooltip>
                      </Show>
                      <Show when={rowPace()?.kind === "hot"}>
                        <ui.Tooltip value={t("limits.paceHint")}>
                          <span
                            tabIndex={0}
                            aria-label={t("limits.paceHint")}
                            style={`font-size:11px;color:${amberText(light())};font-variant-numeric:tabular-nums;flex-shrink:0;`}
                          >
                            ⚡
                          </span>
                        </ui.Tooltip>
                      </Show>
                    </div>
                  )
                }}
              </For>
              <Show when={custom.value.dialogPace && pace()}>
                <div style={paceCardStyle()}>
                  {pace()!.text}
                  <Show when={showZenLeft()}> · {zenLeft()}</Show>
                  <div style="opacity:.7;margin-top:3px;">{t("limits.paceExplain")}</div>
                </div>
              </Show>
              <Show when={custom.value.dialogSparkline}>
                <Sparkline
                  snapshots={current().snapshots}
                  light={light()}
                  label={t("limits.sparklineTitle")}
                  palette={effectivePalette()}
                  warnAt={extras.value.warnThreshold}
                />
              </Show>
              <Show when={hasExhausted()}>
                <div style="font-size:11px;opacity:.75;">{t("limits.fallbackHint")}</div>
              </Show>
              <Show when={hasZenDetails()}>
                <div style={zenBoxStyle()}>
                  <div style="font-weight:500;opacity:.85;">{t("limits.zenTitle")}</div>
                  <Show
                    when={
                      (zenActivity()?.today.goTokens ?? 0) > 0 ||
                      (zenActivity()?.today.zenTokens ?? 0) > 0 ||
                      (zenActivity()?.today.zenCostUsd ?? 0) > 0
                    }
                  >
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;opacity:.75;font-variant-numeric:tabular-nums;">
                      <Show when={(zenActivity()?.today.goTokens ?? 0) > 0}>
                        <span>
                          {t("limits.todayGo")}: {formatTokensCompact(zenActivity()!.today.goTokens)} ·{" "}
                          {zenActivity()!.today.goSteps} {t("limits.steps")}
                        </span>
                      </Show>
                      <Show
                        when={
                          (zenActivity()?.today.zenTokens ?? 0) > 0 ||
                          (zenActivity()?.today.zenCostUsd ?? 0) > 0
                        }
                      >
                        <span>
                          {t("limits.todayZen")}: {formatUsd(zenActivity()!.today.zenCostUsd)} (
                          {formatTokensCompact(zenActivity()!.today.zenTokens)})
                        </span>
                      </Show>
                    </div>
                  </Show>
                  <Show
                    when={
                      (zenActivity()?.week.goTokens ?? 0) > 0 ||
                      (zenActivity()?.week.zenTokens ?? 0) > 0 ||
                      (zenActivity()?.week.zenCostUsd ?? 0) > 0
                    }
                  >
                    <div style="opacity:.75;font-variant-numeric:tabular-nums;">
                      {t("limits.week")}:
                      <Show when={(zenActivity()?.week.goTokens ?? 0) > 0}>
                        {" "}
                        Go {formatTokensCompact(zenActivity()!.week.goTokens)}
                      </Show>
                      <Show when={(zenActivity()?.week.zenTokens ?? 0) > 0 || (zenActivity()?.week.zenCostUsd ?? 0) > 0}>
                        {" "}
                        · Zen {formatUsd(zenActivity()!.week.zenCostUsd)} ({formatTokensCompact(zenActivity()!.week.zenTokens)})
                      </Show>
                      <Show when={zenActivity()?.week.topModels[0]}>
                        {" "}
                        · {zenActivity()!.week.topModels[0].modelID}
                      </Show>
                    </div>
                  </Show>
                  <Show when={(zenActivity()?.today.topModels.length ?? 0) > 0}>
                    <div style="opacity:.7;font-size:10px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;">
                      {t("limits.models")}:{" "}
                      {zenActivity()!
                        .today.topModels.map((m) => `${m.modelID} (${formatTokensCompact(m.tokens)})`)
                        .join(" · ")}
                    </div>
                  </Show>
                  <For each={zenActivity()?.budgets ?? []}>
                    {(budget) => {
                      const pct = () => Math.min(100, Math.round((budget.spent / budget.limit) * 100))
                      return (
                        <div style="display:flex;align-items:center;gap:8px;opacity:.8;font-variant-numeric:tabular-nums;">
                          <span style="opacity:.7;">{t("limits.budget")}</span>
                          <MiniBar
                            used={pct()}
                            width={60}
                            light={light()}
                            palette={effectivePalette()}
                            warnAt={extras.value.warnThreshold}
                          />
                          <span>
                            {formatUsd(budget.spent)} / {formatUsd(budget.limit)}
                          </span>
                          <Show when={budget.resetsAt > 0}>
                            <span style="margin-left:auto;opacity:.6;">
                              {t("limits.reset")} {span(budget.resetsAt - now(), lang())}
                            </span>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
              <Show when={custom.value.dialogSource && sourceLabel(current().source, lang())}>
                <div style="font-size:11px;opacity:.62;">
                  <span>{sourceLabel(current().source, lang())}</span>
                </div>
              </Show>
            </div>
          </ui.Dialog>
        )
      })
    }

    async function showLimits(instantIfCached = false) {
      const cached = card()
      if (instantIfCached && cached?.ok) {
        openCard(cached)
        void refresh(true)
        return
      }
      const result = await refresh(true)
      if (ctx.signal.aborted) return
      if (!result || !result.ok) {
        if (card()?.ok) {
          openCard(card()!)
          return
        }
        openErrorDialog(result?.error ?? t("limits.failed"))
        return
      }
      openCard(result)
    }

    ctx.add(Command, (): Command => ({
      id: "limits",
      title: t("command.limits"),
      bind: "ctrl+shift+l",
      slash: { name: "limits" },
      run: () => showLimits(true),
    }))

    ctx.add(Command, (): Command => ({
      id: "settings",
      title: t("command.settings"),
      slash: { name: "limits-settings" },
      run: () => openSettingsDialog(),
    }))

    ctx.add(SettingsPage, (): SettingsPage => ({
      id: ctx.id,
      title: t("settings.title"),
      icon: "sliders",
      entries: [
        {
          id: ctx.id,
          title: t("settings.title"),
          description: t("settings.description"),
          keywords: "opencode go limits quota usage zen",
        },
        {
          id: "opencode-limits-go-placement",
          title: t("settings.placement.title"),
          description: t("settings.placement.description"),
          keywords: "position bottom top header titlebar sidebar",
        },
        {
          id: "opencode-limits-go-stripmode",
          title: t("settings.stripMode.title"),
          description: t("settings.stripMode.description"),
          keywords: "tightest auto focus window mode",
        },
        {
          id: "opencode-limits-go-palette",
          title: t("settings.palette.title"),
          description: t("settings.palette.description"),
          keywords: "color theme palette traffic mono calm stealth",
        },
        {
          id: "opencode-limits-go-density",
          title: t("settings.density.title"),
          description: t("settings.density.description"),
          keywords: "density compact normal wide size",
        },
        {
          id: "opencode-limits-go-autohide",
          title: t("settings.autoHide.title"),
          description: t("settings.autoHide.description"),
          keywords: "auto hide zen threshold",
        },
        {
          id: "opencode-limits-go-remaining",
          title: t("settings.remaining.title"),
          description: t("settings.remaining.description"),
          keywords: "remaining left battery used percent",
        },
        {
          id: "opencode-limits-go-sparkline",
          title: t("settings.dialogSparkline.title"),
          description: t("settings.dialogSparkline.description"),
          keywords: "sparkline chart graph trend 5h",
        },
        {
          id: "opencode-limits-go-burnspike",
          title: t("settings.burnSpike.title"),
          description: t("settings.burnSpike.description"),
          keywords: "burn spike fast alert notification",
        },
        {
          id: "opencode-limits-go-lang",
          title: t("settings.lang.title"),
          description: t("settings.lang.description"),
          keywords: "language locale english russian override",
        },
        {
          id: "opencode-limits-go-windows",
          title: t("settings.windows.title"),
          description: t("settings.windows.description"),
          keywords: "windows 5h 1w 1m strip show hide",
        },
        {
          id: "opencode-limits-go-style",
          title: t("settings.style.title"),
          description: t("settings.style.description"),
          keywords: "style bars text percent indicator",
        },
        {
          id: "opencode-limits-go-stripreset",
          title: t("settings.stripReset.title"),
          description: t("settings.stripReset.description"),
          keywords: "reset countdown timer strip",
        },
        {
          id: "opencode-limits-go-labels",
          title: t("settings.labels.title"),
          description: t("settings.labels.description"),
          keywords: "labels prefixes window names",
        },
        {
          id: "opencode-limits-go-paceicon",
          title: t("settings.paceIcon.title"),
          description: t("settings.paceIcon.description"),
          keywords: "pace icon lightning burn",
        },
        {
          id: "opencode-limits-go-elapsedtick",
          title: t("settings.elapsedTick.title"),
          description: t("settings.elapsedTick.description"),
          keywords: "elapsed marker tick time",
        },
        {
          id: "opencode-limits-go-timeformat",
          title: t("settings.timeFormat.title"),
          description: t("settings.timeFormat.description"),
          keywords: "time format 24h 12h clock",
        },
        {
          id: "opencode-limits-go-resetformat",
          title: t("settings.resetFormat.title"),
          description: t("settings.resetFormat.description"),
          keywords: "reset date countdown format",
        },
        {
          id: "opencode-limits-go-dialogpace",
          title: t("settings.dialogPace.title"),
          description: t("settings.dialogPace.description"),
          keywords: "pace banner dialog projection",
        },
        {
          id: "opencode-limits-go-zenstats",
          title: t("settings.zenStats.title"),
          description: t("settings.zenStats.description"),
          keywords: "zen stats spend models budgets",
        },
        {
          id: "opencode-limits-go-dialogsource",
          title: t("settings.dialogSource.title"),
          description: t("settings.dialogSource.description"),
          keywords: "source auth footer credential",
        },
        {
          id: "opencode-limits-go-alerts",
          title: t("settings.alerts.title"),
          description: t("settings.alerts.description"),
          keywords: "alerts notifications toast mute",
        },
        {
          id: "opencode-limits-go-threshold",
          title: t("settings.threshold.title"),
          description: t("settings.threshold.description"),
          keywords: "warning threshold alert percent",
        },
        {
          id: "opencode-limits-go-poll",
          title: t("settings.poll.title"),
          description: t("settings.poll.description"),
          keywords: "poll interval refresh background",
        },
        {
          id: "opencode-limits-go-autoupdate",
          title: t("settings.autoUpdate.title"),
          description: t("settings.autoUpdate.description"),
          keywords: "auto update github release",
        },
        {
          id: "opencode-limits-go-diagnostics",
          title: t("settings.diagnostics.title"),
          description: t("settings.diagnostics.description"),
          keywords: "diagnostics copy info support",
        },
        {
          id: "opencode-limits-go-version",
          title: t("settings.version.title"),
          keywords: "version check update",
        },
      ],
      render: () => (
        <ui.SettingsLayout
          title={t("settings.title")}
          description={t("settings.description")}
          actions={
            <div style="display:flex;align-items:center;gap:8px;">
              <ui.Button variant="ghost-muted" onClick={() => void resetSettings()}>
                {t("settings.reset")}
              </ui.Button>
              <ui.Button
                variant="ghost"
                icon="square-arrow-top-right"
                onClick={() => ctx.system.openExternal(consoleUrl())}
              >
                {t("limits.console")}
              </ui.Button>
              <ui.Button variant="neutral" icon="refresh" busy={refreshing()} onClick={() => void refresh(true)}>
                {t("limits.refresh")}
              </ui.Button>
            </div>
          }
        >
          <ui.SettingsSection title={t("settings.section.strip")}>
            <StripFields page />
          </ui.SettingsSection>

          <ui.SettingsSection title={t("settings.section.dialog")}>
            <DialogFields page />
          </ui.SettingsSection>

          <ui.SettingsSection title={t("settings.section.notifications")}>
            <NotificationFields page />
          </ui.SettingsSection>

          <ui.SettingsSection title={t("settings.section.behavior")}>
            <BehaviorFields page />
          </ui.SettingsSection>

          <ui.SettingsSection title={t("settings.section.updates")}>
            <UpdateFields page />
          </ui.SettingsSection>
        </ui.SettingsLayout>
      ),
    }))

    const isAutoHidden = () => {
      const c = card()
      if (!c?.ok) return false
      return shouldHideStrip(c.rows, custom.value.autoHideBelow)
    }

    const showBottom = () => (prefs.value.placement === "bottom" || prefs.value.placement === "both") && !isAutoHidden()
    const showTop = () => (prefs.value.placement === "top" || prefs.value.placement === "both") && !isAutoHidden()

    ctx.add(Slot, {
      at: "window.bottom",
      render: () => (
        <Show when={showBottom()}>
          <ui.Tooltip value={stripTooltip()} keys={ctx.keybinds.keybind(`${ctx.id}.limits`)}>
            <LimitsStrip
              card={card()}
              ready={ready()}
              stale={!!staleError() || !!card()?.stale}
              lang={lang()}
              light={light()}
              showBars={prefs.value.showBars}
              showPercent={strip.value.showPercent}
              showLabels={strip.value.showLabels}
              showRemaining={display.value.showRemaining}
              palette={effectivePalette()}
              density={custom.value.density}
              stripMode={custom.value.stripMode}
              stripReset={custom.value.stripReset}
              showPaceIcon={custom.value.showPaceIcon}
              showElapsedTick={custom.value.showElapsedTick}
              warnAt={extras.value.warnThreshold}
              visible={visibleWindows()}
              variant="bottom"
              onOpen={() => void showLimits(true)}
            />
          </ui.Tooltip>
        </Show>
      ),
    })

    ctx.add(Slot, {
      at: "session.header",
      order: 20,
      render: (input) => (
        <Show when={showTop() && input.active}>
          <ui.Tooltip value={stripTooltip()} keys={ctx.keybinds.keybind(`${ctx.id}.limits`)}>
            <LimitsStrip
              card={card()}
              ready={ready()}
              stale={!!staleError() || !!card()?.stale}
              lang={lang()}
              light={light()}
              showBars={prefs.value.showBars && !input.compact}
              showPercent={strip.value.showPercent || input.compact}
              showLabels={strip.value.showLabels}
              showRemaining={display.value.showRemaining}
              palette={effectivePalette()}
              density={custom.value.density}
              stripMode={custom.value.stripMode}
              stripReset={custom.value.stripReset}
              showPaceIcon={custom.value.showPaceIcon}
              showElapsedTick={custom.value.showElapsedTick}
              warnAt={extras.value.warnThreshold}
              visible={visibleWindows()}
              variant="top"
              onOpen={() => void showLimits(true)}
            />
          </ui.Tooltip>
        </Show>
      ),
    })

    ctx.add(TitlebarItem, (): TitlebarItem | undefined => {
      if (prefs.value.placement !== "titlebar" || isAutoHidden()) return undefined
      const current = card()
      const l = lang()
      const rem = display.value.showRemaining
      const rows = current?.ok ? selectStripRows(current.rows, visibleWindows(), custom.value.stripMode) : []
      const label = current?.ok
        ? rows
            .map((r) => {
              const pct = displayPercent(r.used, rem)
              return strip.value.showLabels ? `${windowLabel(r, l)} ${pct}%` : `${pct}%`
            })
            .join(" · ")
        : `${l === "ru" ? "лимиты" : "limits"}: ${ready() ? shortErrorLabel(current?.error, l) : "…"}`
      const fullTitle = current?.ok
        ? `${t("command.limits")}: ${cardText(current, l)}`
        : `${t("command.limits")}: ${current?.error || label}`
      return {
        id: "limits",
        label,
        title: fullTitle,
        icon: "status",
        run: () => void showLimits(true),
      }
    })
  },
})
