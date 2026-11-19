import { createEffect, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js"
import { Command, Plugin, SettingsPage, Slot, Store, TitlebarItem } from "@opencode/plugin/gui"
import { Limits } from "./rpc.ts"
import { GUI_I18N } from "./gui/i18n.ts"
import {
  CONSOLE_URL,
  type ConsoleBudget,
  DisplayPrefs,
  ExtrasPrefs,
  type Placement,
  Prefs,
  type PresetKey,
  SAMPLE_CARD,
  StripPrefs,
  type StripStyle,
  type UpdateStatusInfo,
  type ZenActivityInfo,
} from "./gui/stores.ts"
import { LimitsStrip, MiniBar, SectionDivider, amberText } from "./gui/components.tsx"
import {
  type LimitCard,
  type LimitRow,
  type Locale,
  type VisibleWindows,
  type WindowKey,
  alertMessage,
  cardText,
  displayPercent,
  emptyCard,
  estimateWindowPace,
  filterStripRows,
  formatTokensCompact,
  formatUsd,
  newAlerts,
  normalizeLocale,
  paceSummary,
  recoveredAlerts,
  relativeAge,
  resetAlertMessage,
  resetText,
  retry,
  shortErrorLabel,
  sourceLabel,
  span,
  summarizeStatsByProvider,
  windowElapsedRatio,
  windowLabel,
} from "./model.ts"

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
  },
  i18n: GUI_I18N,
  setup(ctx) {
    const ui = ctx.ui
    const prefs = ctx.stores.prefs
    const strip = ctx.stores.strip
    const extras = ctx.stores.extras
    const display = ctx.stores.display
    const [card, setCard] = createSignal<LimitCard | null>(null)
    const [staleError, setStaleError] = createSignal("")
    const [zenActivity, setZenActivity] = createSignal<ZenActivityInfo | null>(null)
    const [ready, setReady] = createSignal(false)
    const [refreshing, setRefreshing] = createSignal(false)
    const [updateInfo, setUpdateInfo] = createSignal<UpdateStatusInfo | null>(null)
    const [updateBusy, setUpdateBusy] = createSignal(false)
    const notified = new Map<string, number>()
    const wasExhausted = new Set<string>()
    let notifiedUpdateVersion = ""
    let lastFocusRefreshAt = 0

    const lang = (): Locale => normalizeLocale(ctx.locale.locale())
    const light = () => ctx.appearance.mode() === "light"

    const visibleWindows = (): VisibleWindows => ({
      rolling: strip.value.show5h,
      weekly: strip.value.show1w,
      monthly: strip.value.show1m,
    })

    const activeWindowCount = () =>
      Number(strip.value.show5h) + Number(strip.value.show1w) + Number(strip.value.show1m)

    function toggleWindow(key: WindowKey) {
      const v = visibleWindows()
      if (v[key] && activeWindowCount() <= 1) return
      strip.update((draft) => {
        if (key === "rolling") draft.show5h = !draft.show5h
        else if (key === "weekly") draft.show1w = !draft.show1w
        else draft.show1m = !draft.show1m
      })
    }

    function showAllWindows() {
      strip.update((draft) => {
        draft.show5h = true
        draft.show1w = true
        draft.show1m = true
      })
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
      const s = strip.value
      const bars = prefs.value.showBars
      if (bars && s.show5h && s.show1w && s.show1m && s.showPercent && s.showLabels) return "standard"
      if (bars && s.show5h && !s.show1w && !s.show1m && s.showPercent && s.showLabels) return "only5h"
      if (!bars && s.show5h && s.show1w && s.show1m && s.showPercent && s.showLabels) return "text"
      if (!bars && s.show5h && !s.show1w && !s.show1m && s.showPercent && !s.showLabels) return "minimal"
      return null
    }

    function applyPreset(preset: PresetKey) {
      if (preset === "standard") {
        strip.set({ show5h: true, show1w: true, show1m: true, showPercent: true, showLabels: true })
        prefs.update((d) => {
          d.showBars = true
        })
      } else if (preset === "only5h") {
        strip.set({ show5h: true, show1w: false, show1m: false, showPercent: true, showLabels: true })
        prefs.update((d) => {
          d.showBars = true
        })
      } else if (preset === "text") {
        strip.set({ show5h: true, show1w: true, show1m: true, showPercent: true, showLabels: true })
        prefs.update((d) => {
          d.showBars = false
        })
      } else {
        strip.set({ show5h: true, show1w: false, show1m: false, showPercent: true, showLabels: false })
        prefs.update((d) => {
          d.showBars = false
        })
      }
    }

    function resetSettings() {
      prefs.set({ placement: "bottom", showBars: true, alerts: true, autoUpdate: true })
      strip.set({ show5h: true, show1w: true, show1m: true, showPercent: true, showLabels: true })
      extras.set({ monoBars: false, showZenStats: true, warnThreshold: 80, pollSeconds: 90 })
      display.set({ showRemaining: false })
      void syncAutoUpdate(true)
    }

    const consoleUrl = () => zenActivity()?.usageUrl || CONSOLE_URL

    const stripTooltip = () => {
      const c = card()
      const l = lang()
      const base = ctx.t("command.limits")
      if (!c?.ok) {
        return c?.error ? `${base}\n${c.error}` : base
      }
      const now = Date.now()
      const rem = display.value.showRemaining
      const rowsText = c.rows
        .map((r) => {
          const rs = resetText(r.resetsAtMs, r.resetsIn, now, l)
          const pct = displayPercent(r.used, rem)
          return `${windowLabel(r, l)} ${pct}%${rem ? ` ${ctx.t("limits.left")}` : ""} (${rs.text})`
        })
        .join(" · ")
      const pace = paceSummary(c.rows, now, l, c.snapshots)
      const z = extras.value.showZenStats ? zenActivity() : null
      const zenLine =
        z && z.today.zenCostUsd > 0
          ? `Zen: ${formatUsd(z.today.zenCostUsd)}`
          : z && z.today.goTokens > 0
            ? `${ctx.t("limits.todayGo")}: ${formatTokensCompact(z.today.goTokens)}`
            : ""
      const stale = staleError() ? ctx.t("limits.stale", { error: staleError() }) : ""
      return [base, rowsText, pace?.text, zenLine, stale].filter(Boolean).join("\n")
    }

    const placementOptions = () => [
      { value: "bottom" as const, label: ctx.t("settings.placement.bottom") },
      { value: "top" as const, label: ctx.t("settings.placement.top") },
      { value: "both" as const, label: ctx.t("settings.placement.both") },
      { value: "titlebar" as const, label: ctx.t("settings.placement.titlebar") },
      { value: "hidden" as const, label: ctx.t("settings.placement.hidden") },
    ]

    function notifyUpdated(version: string) {
      if (!version || version === notifiedUpdateVersion || ctx.signal.aborted) return
      notifiedUpdateVersion = version
      ctx.toast.show({
        variant: "success",
        title: ctx.t("settings.update.installedToast", { version }),
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
        const [limitsRes, statsRes] = await Promise.all([
          exp?.usage?.limits?.(undefined, { signal: ctx.signal }).catch(() => null),
          exp?.session?.stats?.({ from: start.getTime() }, { signal: ctx.signal }).catch(() => null),
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
        const usageUrl =
          typeof limitsRes?.data?.workspace?.usageURL === "string" &&
          limitsRes.data.workspace.usageURL.startsWith("https://")
            ? limitsRes.data.workspace.usageURL
            : undefined
        setZenActivity({ usageUrl, budgets, today })
      } catch {}
    }

    async function refresh(force = false): Promise<LimitCard | null> {
      if (ctx.signal.aborted) return null
      if (force) setRefreshing(true)
      try {
        const currentLang = lang()
        const maxAgeMs = extras.value.pollSeconds * 1000
        const result = (await ctx.client
          .rpc(Limits)
          .status({ force, lang: currentLang, maxAgeMs }, { signal: ctx.signal })) as LimitCard
        if (ctx.signal.aborted) return null
        setReady(true)
        if (result.ok) {
          setCard(result)
          setStaleError("")
          void loadZenActivity()
          const now = Date.now()
          const triggered = newAlerts(result.rows, notified, extras.value.warnThreshold)
          const recovered = recoveredAlerts(result.rows, wasExhausted)
          if (prefs.value.alerts) {
            for (const row of triggered) {
              ctx.toast.show({
                variant: row.used >= 100 ? "error" : "default",
                title: alertMessage(row, now, currentLang),
              })
            }
            for (const row of recovered) {
              ctx.toast.show({
                variant: "success",
                title: resetAlertMessage(row, currentLang),
              })
            }
          }
        } else if (card()?.ok) {
          setStaleError(result.error || ctx.t("limits.failed"))
        } else {
          setCard(result)
          setStaleError("")
        }
        return result
      } catch {
        if (ctx.signal.aborted) return null
        setReady(true)
        if (card()?.ok) {
          setStaleError(ctx.t("limits.noServer"))
        } else {
          setCard(emptyCard(ctx.t("limits.noServer")))
        }
        return null
      } finally {
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
          ctx.toast.show({ variant: "error", title: ctx.t("settings.update.failedToast", { error: res.error }) })
          return
        }
        if (res.restartRequired) notifyUpdated(res.version)
        await checkUpdates(false)
      } catch (error) {
        if (!ctx.signal.aborted) {
          ctx.toast.show({
            variant: "error",
            title: ctx.t("settings.update.failedToast", { error: String(error) }),
          })
        }
      } finally {
        if (!ctx.signal.aborted) setUpdateBusy(false)
      }
    }

    void retry(() => refresh(), (r) => r !== null, 5, undefined, ctx.signal).then(() => {
      if (ctx.signal.aborted) return
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

    createEffect(() => {
      const ms = Math.max(30, extras.value.pollSeconds) * 1000
      const timer = setInterval(() => void refresh(), ms)
      onCleanup(() => clearInterval(timer))
    })

    if (typeof document !== "undefined") {
      const onVisible = () => {
        if (document.visibilityState !== "visible") return
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
            name: "changed" | "updated",
            fn: (ev: { data?: { version?: string } }) => void,
            opts?: { signal?: AbortSignal },
          ) => () => void
        }
      }
      const stopChanged = rpcClient.events?.on?.("changed", () => void refresh(), { signal: ctx.signal })
      if (stopChanged) onCleanup(stopChanged)
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

    function DisplayFields(props: { page?: boolean; compact?: boolean }) {
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
        { value: "bars_pct" as const, label: ctx.t("settings.style.bars_pct") },
        { value: "text" as const, label: ctx.t("settings.style.text") },
        { value: "bars" as const, label: ctx.t("settings.style.bars") },
      ]
      const presetItems: Array<{ key: PresetKey; label: () => string }> = [
        { key: "standard", label: () => ctx.t("settings.presets.standard") },
        { key: "only5h", label: () => ctx.t("settings.presets.only5h") },
        { key: "text", label: () => ctx.t("settings.presets.text") },
        { key: "minimal", label: () => ctx.t("settings.presets.minimal") },
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
          monoBars={extras.value.monoBars}
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
                <span style="font-size:11px;opacity:.65;flex-shrink:0;">{ctx.t("settings.preview.label")}</span>
                <div style="min-width:0;overflow:hidden;display:flex;justify-content:flex-end;">
                  {previewStrip()}
                </div>
              </div>
            }
          >
            <ui.SettingsRow
              id="opencode-limits-go-preview"
              title={ctx.t("settings.preview.label")}
              description={ctx.t(`settings.placement.${prefs.value.placement}`)}
            >
              {previewStrip()}
            </ui.SettingsRow>
          </Show>
          <Show
            when={props.page}
            fallback={
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;box-sizing:border-box;">
                <span style="font-size:12px;opacity:.75;flex-shrink:0;">{ctx.t("settings.presets.title")}</span>
                {presetButtons()}
              </div>
            }
          >
            <ui.SettingsRow id="opencode-limits-go-presets" title={ctx.t("settings.presets.title")}>
              {presetButtons()}
            </ui.SettingsRow>
          </Show>
          <SettingField
            page={props.page}
            id="opencode-limits-go-placement"
            title={ctx.t("settings.placement.title")}
            description={ctx.t("settings.placement.description")}
          >
            <ui.Select<Placement>
              label={ctx.t("settings.placement.title")}
              options={placementOptions()}
              value={prefs.value.placement}
              onChange={(value) =>
                prefs.update((draft) => {
                  draft.placement = value
                })
              }
            />
          </SettingField>
          <SettingField
            page={props.page}
            id="opencode-limits-go-windows"
            title={ctx.t("settings.windows.title")}
            description={ctx.t("settings.windows.description")}
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
                  {ctx.t("settings.windows.all")}
                </ui.Button>
              </Show>
            </div>
          </SettingField>
          <SettingField
            page={props.page}
            id="opencode-limits-go-style"
            title={ctx.t("settings.style.title")}
            description={ctx.t("settings.style.description")}
          >
            <ui.Select<StripStyle>
              label={ctx.t("settings.style.title")}
              options={styleOptions()}
              value={stripStyle()}
              onChange={setStripStyle}
            />
          </SettingField>
          <SettingField
            page={props.page}
            id="opencode-limits-go-remaining"
            title={ctx.t("settings.remaining.title")}
            description={ctx.t("settings.remaining.description")}
          >
            <ui.Switch
              label={ctx.t("settings.remaining.title")}
              hideLabel
              checked={display.value.showRemaining}
              onChange={(checked) =>
                display.update((draft) => {
                  draft.showRemaining = checked
                })
              }
            />
          </SettingField>
          <Show when={!props.compact}>
            <SettingField
              page={props.page}
              id="opencode-limits-go-labels"
              title={ctx.t("settings.labels.title")}
              description={ctx.t("settings.labels.description")}
            >
              <ui.Switch
                label={ctx.t("settings.labels.title")}
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
              id="opencode-limits-go-mono"
              title={ctx.t("settings.mono.title")}
              description={ctx.t("settings.mono.description")}
            >
              <ui.Switch
                label={ctx.t("settings.mono.title")}
                hideLabel
                checked={extras.value.monoBars}
                onChange={(checked) =>
                  extras.update((draft) => {
                    draft.monoBars = checked
                  })
                }
              />
            </SettingField>
            <SettingField
              page={props.page}
              id="opencode-limits-go-zenstats"
              title={ctx.t("settings.zenStats.title")}
              description={ctx.t("settings.zenStats.description")}
            >
              <ui.Switch
                label={ctx.t("settings.zenStats.title")}
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
          </Show>
        </>
      )
    }

    function NotificationFields(props: { page?: boolean }) {
      const thresholdOptions = () => [
        { value: "70" as const, label: ctx.t("settings.threshold.70") },
        { value: "80" as const, label: ctx.t("settings.threshold.80") },
        { value: "90" as const, label: ctx.t("settings.threshold.90") },
        { value: "0" as const, label: ctx.t("settings.threshold.0") },
      ]
      return (
        <>
          <SettingField
            page={props.page}
            id="opencode-limits-go-alerts"
            title={ctx.t("settings.alerts.title")}
            description={ctx.t("settings.alerts.description")}
          >
            <ui.Switch
              label={ctx.t("settings.alerts.title")}
              hideLabel
              checked={prefs.value.alerts}
              onChange={(checked) =>
                prefs.update((draft) => {
                  draft.alerts = checked
                })
              }
            />
          </SettingField>
          <SettingField
            page={props.page}
            id="opencode-limits-go-threshold"
            title={ctx.t("settings.threshold.title")}
            description={ctx.t("settings.threshold.description")}
          >
            <ui.Select<string>
              label={ctx.t("settings.threshold.title")}
              options={thresholdOptions()}
              value={String(extras.value.warnThreshold)}
              onChange={(value) =>
                extras.update((draft) => {
                  draft.warnThreshold = Number(value)
                })
              }
            />
          </SettingField>
        </>
      )
    }

    function updateDescription(): string {
      const info = updateInfo()
      if (!info) return ctx.t("settings.version.checking")
      if (info.restartRequired) return ctx.t("settings.version.restart", { version: info.latestVersion })
      if (info.error) return ctx.t("settings.version.error", { version: info.currentVersion, error: info.error })
      if (info.updateAvailable) {
        if (info.managedByPackageManager) {
          return ctx.t("settings.version.managed", { current: info.currentVersion, latest: info.latestVersion })
        }
        return ctx.t("settings.version.available", { current: info.currentVersion, latest: info.latestVersion })
      }
      return ctx.t("settings.version.upToDate", { version: info.currentVersion })
    }

    function UpdateFields(props: { page?: boolean }) {
      const isManaged = () => !!updateInfo()?.managedByPackageManager
      const canInstall = () =>
        !!updateInfo()?.updateAvailable && !updateInfo()?.restartRequired && !isManaged()
      const pollOptions = () => [
        { value: "30" as const, label: ctx.t("settings.poll.30") },
        { value: "90" as const, label: ctx.t("settings.poll.90") },
        { value: "300" as const, label: ctx.t("settings.poll.300") },
      ]
      return (
        <>
          <SettingField
            page={props.page}
            id="opencode-limits-go-poll"
            title={ctx.t("settings.poll.title")}
            description={ctx.t("settings.poll.description")}
          >
            <ui.Select<string>
              label={ctx.t("settings.poll.title")}
              options={pollOptions()}
              value={String(extras.value.pollSeconds)}
              onChange={(value) =>
                extras.update((draft) => {
                  draft.pollSeconds = Number(value)
                })
              }
            />
          </SettingField>
          <Show
            when={!isManaged()}
            fallback={
              <SettingField
                page={props.page}
                id="opencode-limits-go-autoupdate"
                title={ctx.t("settings.autoUpdate.title")}
                description={ctx.t("settings.autoUpdate.managed")}
              >
                <span style="font-size:11px;opacity:.55;">CLI</span>
              </SettingField>
            }
          >
            <SettingField
              page={props.page}
              id="opencode-limits-go-autoupdate"
              title={ctx.t("settings.autoUpdate.title")}
              description={ctx.t("settings.autoUpdate.description")}
            >
              <ui.Switch
                label={ctx.t("settings.autoUpdate.title")}
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
            title={ctx.t("settings.version.title")}
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
                  {ctx.t("settings.update.check")}
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
                {ctx.t("settings.update.install")}
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
          title={ctx.t("settings.title")}
          description={ctx.t("settings.description")}
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
                  {ctx.t("settings.openAll")}
                </ui.Button>
                <ui.Button variant="ghost-muted" size="small" onClick={resetSettings}>
                  {ctx.t("settings.reset")}
                </ui.Button>
              </div>
              <ui.Button variant="contrast" autofocus onClick={dialog.close}>
                {ctx.t("settings.done")}
              </ui.Button>
            </div>
          }
        >
          <div style="display:flex;flex-direction:column;gap:10px;width:100%;box-sizing:border-box;">
            <DisplayFields compact />
            <SectionDivider label={ctx.t("settings.section.notifications")} light={light()} />
            <NotificationFields />
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
            setErr(next?.error || ctx.t("limits.failed"))
          }
        }
        return (
          <ui.Dialog
            title={ctx.t("limits.errorTitle")}
            size="fit"
            footer={
              <div style="display:flex;align-items:center;justify-content:space-between;width:100%;gap:8px;">
                <div style="display:flex;align-items:center;gap:6px;">
                  <ui.Tooltip value={ctx.t("limits.settings")}>
                    <ui.IconButton
                      icon="settings-gear"
                      label={ctx.t("limits.settings")}
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
                    icon="square-arrow-top-right"
                    onClick={() => ctx.system.openExternal(consoleUrl())}
                  >
                    {ctx.t("limits.console")}
                  </ui.Button>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                  <ui.Button variant="contrast" icon="refresh" busy={refreshing()} onClick={() => void handleRetry()}>
                    {ctx.t("limits.retry")}
                  </ui.Button>
                  <ui.Button variant="neutral" onClick={dialog.close}>
                    {ctx.t("limits.close")}
                  </ui.Button>
                </div>
              </div>
            }
          >
            <div style="display:flex;flex-direction:column;gap:8px;max-width:440px;font-size:12px;">
              <div style="padding:8px 10px;border-radius:8px;border:1px solid rgba(239,68,68,.35);background:rgba(239,68,68,.08);color:#ef4444;word-break:break-word;">
                {err()}
              </div>
              <div style="font-size:11px;opacity:.75;">{ctx.t("limits.errorAuthHint")}</div>
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
          const updatedPart = age ? ctx.t("limits.updated", { age }) : c.checkedAt
          return [c.org, c.email, updatedPart].filter(Boolean).join(" · ")
        }

        const handleRefresh = async () => {
          const next = await refresh(true)
          if (ctx.signal.aborted) return
          setNow(Date.now())
          if (!next || !next.ok) {
            ctx.toast.show({ variant: "error", title: next?.error ?? ctx.t("limits.failed") })
          }
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
        const hasZenDetails = () => {
          if (!extras.value.showZenStats) return false
          const z = zenActivity()
          if (!z) return false
          return (
            z.budgets.length > 0 ||
            z.today.goTokens > 0 ||
            z.today.zenTokens > 0 ||
            z.today.zenCostUsd > 0 ||
            z.today.topModels.length > 0
          )
        }

        return (
          <ui.Dialog
            title={ctx.t("command.limits")}
            description={description()}
            size="fit"
            footer={
              <div style="display:flex;align-items:center;justify-content:space-between;width:100%;gap:8px;">
                <div style="display:flex;align-items:center;gap:6px;">
                  <ui.Tooltip value={ctx.t("limits.settings")}>
                    <ui.IconButton
                      icon="settings-gear"
                      label={ctx.t("limits.settings")}
                      variant="neutral"
                      onClick={() => {
                        dialog.close()
                        openSettingsDialog()
                      }}
                    />
                  </ui.Tooltip>
                  <ui.Tooltip value={ctx.t("limits.consoleHint")}>
                    <ui.Button
                      variant="neutral"
                      size="small"
                      icon="square-arrow-top-right"
                      onClick={() => ctx.system.openExternal(consoleUrl())}
                    >
                      {ctx.t("limits.console")}
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
                    {ctx.t("limits.refresh")}
                  </ui.Button>
                  <ui.Button variant="contrast" autofocus onClick={dialog.close}>
                    {ctx.t("limits.close")}
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
                  {ctx.t("limits.stale", { error: staleError() })}
                </div>
              </Show>
              <For each={current().rows}>
                {(row: LimitRow) => {
                  const resetLine = () => {
                    const r = resetText(row.resetsAtMs, row.resetsIn, now(), lang())
                    return r.passed
                      ? `${ctx.t("limits.reset")} ${row.resetsAt} · ${r.text}`
                      : `${ctx.t("limits.reset")} ${row.resetsAt} · ${ctx.t("limits.in")} ${r.text}`
                  }
                  const rowPace = () => estimateWindowPace(row, now(), lang(), current().snapshots)
                  const elapsed = () => windowElapsedRatio(row, now())
                  const deltaTooltip = () =>
                    row.deltaSpanMs && row.deltaSpanMs > 0
                      ? ctx.t("limits.deltaSpan", { span: span(row.deltaSpanMs, lang()) })
                      : ctx.t("limits.deltaHint")
                  return (
                    <div style="display:flex;align-items:center;gap:8px;font-size:12px;">
                      <span style="width:24px;opacity:.7;flex-shrink:0;">{windowLabel(row, lang())}</span>
                      <ui.Tooltip value={ctx.t("limits.elapsedLegend")}>
                        <span style="display:inline-flex;align-items:center;">
                          <MiniBar
                            used={row.used}
                            width={72}
                            light={light()}
                            mono={extras.value.monoBars}
                            warnAt={extras.value.warnThreshold}
                            elapsedRatio={elapsed()}
                          />
                        </span>
                      </ui.Tooltip>
                      <span style="width:42px;text-align:right;font-variant-numeric:tabular-nums;flex-shrink:0;">
                        {displayPercent(row.used, display.value.showRemaining)}%
                      </span>
                      <span style="opacity:.6;font-size:11px;min-width:0;flex:1;">
                        {resetLine()}
                        {row.status !== "ok" ? ` · ${row.status}` : ""}
                      </span>
                      <Show when={row.delta1h && row.delta1h > 0}>
                        <ui.Tooltip value={deltaTooltip()}>
                          <span style="font-size:10px;opacity:.6;font-variant-numeric:tabular-nums;flex-shrink:0;">
                            +{row.delta1h}%
                          </span>
                        </ui.Tooltip>
                      </Show>
                      <Show when={rowPace()?.kind === "hot"}>
                        <ui.Tooltip value={ctx.t("limits.paceHint")}>
                          <span
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
              <Show when={pace()}>
                <div style={paceCardStyle()}>{pace()!.text}</div>
              </Show>
              <Show when={hasExhausted()}>
                <div style="font-size:11px;opacity:.75;">{ctx.t("limits.fallbackHint")}</div>
              </Show>
              <Show when={hasZenDetails()}>
                <div style={zenBoxStyle()}>
                  <div style="font-weight:500;opacity:.85;">{ctx.t("limits.zenTitle")}</div>
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
                          {ctx.t("limits.todayGo")}: {formatTokensCompact(zenActivity()!.today.goTokens)} ·{" "}
                          {zenActivity()!.today.goSteps} {ctx.t("limits.steps")}
                        </span>
                      </Show>
                      <Show
                        when={
                          (zenActivity()?.today.zenTokens ?? 0) > 0 ||
                          (zenActivity()?.today.zenCostUsd ?? 0) > 0
                        }
                      >
                        <span>
                          {ctx.t("limits.todayZen")}: {formatUsd(zenActivity()!.today.zenCostUsd)} (
                          {formatTokensCompact(zenActivity()!.today.zenTokens)})
                        </span>
                      </Show>
                    </div>
                  </Show>
                  <Show when={(zenActivity()?.today.topModels.length ?? 0) > 0}>
                    <div style="opacity:.65;font-size:10px;font-variant-numeric:tabular-nums;">
                      {ctx.t("limits.models")}:{" "}
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
                          <span style="opacity:.7;">{ctx.t("limits.budget")}</span>
                          <MiniBar
                            used={pct()}
                            width={60}
                            light={light()}
                            mono={extras.value.monoBars}
                            warnAt={extras.value.warnThreshold}
                          />
                          <span>
                            {formatUsd(budget.spent)} / {formatUsd(budget.limit)}
                          </span>
                          <Show when={budget.resetsAt > 0}>
                            <span style="margin-left:auto;opacity:.6;">
                              {ctx.t("limits.reset")} {span(budget.resetsAt - now(), lang())}
                            </span>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
              <Show when={sourceLabel(current().source, lang())}>
                <div style="font-size:10px;opacity:.45;display:flex;justify-content:space-between;gap:8px;">
                  <span>{sourceLabel(current().source, lang())}</span>
                  <span>{current().checkedAt}</span>
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
        openErrorDialog(result?.error ?? ctx.t("limits.failed"))
        return
      }
      openCard(result)
    }

    ctx.add(Command, (): Command => ({
      id: "limits",
      title: ctx.t("command.limits"),
      bind: "ctrl+shift+l",
      slash: { name: "limits" },
      run: () => showLimits(true),
    }))

    ctx.add(Command, (): Command => ({
      id: "settings",
      title: ctx.t("command.settings"),
      slash: { name: "limits-settings" },
      run: () => openSettingsDialog(),
    }))

    ctx.add(SettingsPage, (): SettingsPage => ({
      id: ctx.id,
      title: ctx.t("settings.title"),
      icon: "sliders",
      entries: [
        {
          id: ctx.id,
          title: ctx.t("settings.title"),
          description: ctx.t("settings.description"),
          keywords: "opencode go limits quota usage zen",
        },
        {
          id: "opencode-limits-go-presets",
          title: ctx.t("settings.presets.title"),
          keywords: "presets quick standard minimal text 5h",
        },
        {
          id: "opencode-limits-go-placement",
          title: ctx.t("settings.placement.title"),
          description: ctx.t("settings.placement.description"),
          keywords: "position bottom top header titlebar sidebar",
        },
        {
          id: "opencode-limits-go-windows",
          title: ctx.t("settings.windows.title"),
          description: ctx.t("settings.windows.description"),
          keywords: "windows 5h 1w 1m filter show hide rolling weekly monthly",
        },
        {
          id: "opencode-limits-go-style",
          title: ctx.t("settings.style.title"),
          description: ctx.t("settings.style.description"),
          keywords: "bars text percent compact progress style",
        },
        {
          id: "opencode-limits-go-remaining",
          title: ctx.t("settings.remaining.title"),
          description: ctx.t("settings.remaining.description"),
          keywords: "remaining left battery used percent",
        },
        {
          id: "opencode-limits-go-labels",
          title: ctx.t("settings.labels.title"),
          description: ctx.t("settings.labels.description"),
          keywords: "labels prefix 5h 1w 1m minimal",
        },
        {
          id: "opencode-limits-go-mono",
          title: ctx.t("settings.mono.title"),
          description: ctx.t("settings.mono.description"),
          keywords: "monochrome neutral color bars",
        },
        {
          id: "opencode-limits-go-zenstats",
          title: ctx.t("settings.zenStats.title"),
          description: ctx.t("settings.zenStats.description"),
          keywords: "zen cost spend budget tokens models today",
        },
        {
          id: "opencode-limits-go-alerts",
          title: ctx.t("settings.alerts.title"),
          description: ctx.t("settings.alerts.description"),
          keywords: "toast alert notification reset",
        },
        {
          id: "opencode-limits-go-threshold",
          title: ctx.t("settings.threshold.title"),
          description: ctx.t("settings.threshold.description"),
          keywords: "threshold 70 80 90 100 alert",
        },
        {
          id: "opencode-limits-go-poll",
          title: ctx.t("settings.poll.title"),
          description: ctx.t("settings.poll.description"),
          keywords: "poll interval refresh 30s 90s 5m",
        },
        {
          id: "opencode-limits-go-autoupdate",
          title: ctx.t("settings.autoUpdate.title"),
          description: ctx.t("settings.autoUpdate.description"),
          keywords: "update github release autoupdate",
        },
        {
          id: "opencode-limits-go-version",
          title: ctx.t("settings.version.title"),
          keywords: "version check update",
        },
      ],
      render: () => (
        <ui.SettingsLayout
          title={ctx.t("settings.title")}
          description={ctx.t("settings.description")}
          actions={
            <div style="display:flex;align-items:center;gap:8px;">
              <ui.Button variant="ghost-muted" onClick={resetSettings}>
                {ctx.t("settings.reset")}
              </ui.Button>
              <ui.Button
                variant="ghost"
                icon="square-arrow-top-right"
                onClick={() => ctx.system.openExternal(consoleUrl())}
              >
                {ctx.t("limits.console")}
              </ui.Button>
              <ui.Button variant="neutral" icon="refresh" busy={refreshing()} onClick={() => void refresh(true)}>
                {ctx.t("limits.refresh")}
              </ui.Button>
            </div>
          }
        >
          <ui.SettingsSection title={ctx.t("settings.section.display")}>
            <DisplayFields page />
          </ui.SettingsSection>

          <ui.SettingsSection title={ctx.t("settings.section.notifications")}>
            <NotificationFields page />
          </ui.SettingsSection>

          <ui.SettingsSection title={ctx.t("settings.section.updates")}>
            <UpdateFields page />
          </ui.SettingsSection>
        </ui.SettingsLayout>
      ),
    }))

    const showBottom = () => prefs.value.placement === "bottom" || prefs.value.placement === "both"
    const showTop = () => prefs.value.placement === "top" || prefs.value.placement === "both"

    ctx.add(Slot, {
      at: "window.bottom",
      render: () => (
        <Show when={showBottom()}>
          <ui.Tooltip value={stripTooltip()} keys={ctx.keybinds.keybind(`${ctx.id}.limits`)}>
            <LimitsStrip
              card={card()}
              ready={ready()}
              stale={!!staleError()}
              lang={lang()}
              light={light()}
              showBars={prefs.value.showBars}
              showPercent={strip.value.showPercent}
              showLabels={strip.value.showLabels}
              showRemaining={display.value.showRemaining}
              monoBars={extras.value.monoBars}
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
              stale={!!staleError()}
              lang={lang()}
              light={light()}
              showBars={prefs.value.showBars && !input.compact}
              showPercent={strip.value.showPercent || input.compact}
              showLabels={strip.value.showLabels}
              showRemaining={display.value.showRemaining}
              monoBars={extras.value.monoBars}
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
      if (prefs.value.placement !== "titlebar") return undefined
      const current = card()
      const l = lang()
      const rem = display.value.showRemaining
      const rows = current?.ok ? filterStripRows(current.rows, visibleWindows()) : []
      const label = current?.ok
        ? rows
            .map((r) => {
              const pct = displayPercent(r.used, rem)
              return strip.value.showLabels ? `${windowLabel(r, l)} ${pct}%` : `${pct}%`
            })
            .join(" · ")
        : `${l === "ru" ? "лимиты" : "limits"}: ${ready() ? shortErrorLabel(current?.error, l) : "…"}`
      const fullTitle = current?.ok
        ? `${ctx.t("command.limits")}: ${cardText(current, l)}`
        : `${ctx.t("command.limits")}: ${current?.error || label}`
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
