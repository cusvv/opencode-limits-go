import { createEffect, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js"
import { Schema } from "effect"
import { Command, Plugin, SettingsPage, Slot, Store, TitlebarItem } from "@opencode/plugin/gui"
import { Limits } from "./rpc.ts"
import {
  type LimitCard,
  type LimitRow,
  type Locale,
  type VisibleWindows,
  type WindowKey,
  alertMessage,
  cardText,
  emptyCard,
  estimateWindowPace,
  filterStripRows,
  newAlerts,
  normalizeLocale,
  paceSummary,
  resetText,
  retry,
  sourceLabel,
  span,
  tightLine,
  windowLabel,
} from "./model.ts"

const CONSOLE_URL = "https://opencode.ai/console"

type UpdateStatusInfo = {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  autoUpdated: boolean
  restartRequired: boolean
  releaseUrl: string
  checkedAtMs: number
  error: string
}

const PLACEMENTS = ["bottom", "top", "both", "titlebar", "hidden"] as const
type Placement = (typeof PLACEMENTS)[number]
type StripStyle = "bars_pct" | "text" | "bars"

const SAMPLE_CARD: LimitCard = {
  ok: true,
  org: "OpenCode",
  email: "",
  checkedAt: "",
  source: "",
  tight: "",
  error: "",
  rows: [
    { key: "rolling", label: "5h", used: 18, status: "ok", resetsAt: "", resetsIn: "" },
    { key: "weekly", label: "1w", used: 42, status: "ok", resetsAt: "", resetsIn: "" },
    { key: "monthly", label: "1m", used: 68, status: "ok", resetsAt: "", resetsIn: "" },
  ],
}

const Prefs = Schema.Struct({
  placement: Schema.Literals(PLACEMENTS),
  showBars: Schema.Boolean,
  alerts: Schema.Boolean,
  autoUpdate: Schema.Boolean,
})

const StripPrefs = Schema.Struct({
  show5h: Schema.Boolean,
  show1w: Schema.Boolean,
  show1m: Schema.Boolean,
  showPercent: Schema.Boolean,
  showLabels: Schema.Boolean,
})

function tone(used: number): string {
  if (used >= 100) return "#ef4444"
  if (used >= 80) return "#f59e0b"
  return "#22c55e"
}

function MiniBar(props: { used: number; width?: number; light: boolean }) {
  const track = () => (props.light ? "rgba(0,0,0,.14)" : "rgba(255,255,255,.16)")
  const widthPct = () => Math.min(Math.max(props.used, 0), 100)
  return (
    <span
      style={`display:inline-block;width:${props.width ?? 32}px;height:5px;background:${track()};border-radius:999px;overflow:hidden;vertical-align:middle;`}
    >
      <span style={`display:block;height:100%;width:${widthPct()}%;background:${tone(props.used)};`} />
    </span>
  )
}

function LimitsStrip(props: {
  card: LimitCard | null
  ready: boolean
  lang: Locale
  light: boolean
  showBars: boolean
  showPercent: boolean
  showLabels: boolean
  visible: VisibleWindows
  variant: "bottom" | "top"
  preview?: boolean
  onOpen: () => void
}) {
  const rows = () => filterStripRows(props.card?.rows ?? [], props.visible)
  const effBars = () => props.showBars
  const effPercent = () => props.showPercent || !effBars()
  const errorColor = () => (props.light ? "#b45309" : "#f59e0b")
  const prefix = () => (props.lang === "ru" ? "лимиты" : "limits")
  const noData = () => (props.lang === "ru" ? "нет данных" : "no data")

  const buttonStyle = () => {
    const cursor = props.preview ? "default" : "pointer"
    if (props.variant === "top") {
      const border = props.light ? "rgba(0,0,0,.12)" : "rgba(255,255,255,.12)"
      const bg = props.light ? "rgba(0,0,0,.04)" : "rgba(255,255,255,.05)"
      return `background:${bg};border:1px solid ${border};border-radius:6px;margin:0;color:inherit;font:inherit;cursor:${cursor};display:inline-flex;align-items:center;gap:8px;padding:4px 8px;font-size:11px;line-height:1.2;white-space:nowrap;`
    }
    return `background:transparent;border:0;margin:0;color:inherit;font:inherit;cursor:${cursor};display:inline-flex;align-items:center;gap:12px;padding:3px 10px;font-size:11px;white-space:nowrap;`
  }

  return (
    <button type="button" onClick={props.onOpen} style={buttonStyle()}>
      <Show
        when={props.card?.ok}
        fallback={
          <span style={`color:${errorColor()};`}>
            {prefix()}: {props.ready ? props.card?.error || noData() : "…"}
          </span>
        }
      >
        <For each={rows()}>
          {(row: LimitRow) => (
            <span style="display:inline-flex;align-items:center;gap:5px;">
              <Show when={props.showLabels}>
                <span style="opacity:.6;">{windowLabel(row, props.lang)}</span>
              </Show>
              <Show when={effBars()}>
                <MiniBar used={row.used} width={props.variant === "top" ? 24 : 32} light={props.light} />
              </Show>
              <Show when={effPercent()}>
                <span style="font-variant-numeric:tabular-nums;">{row.used}%</span>
              </Show>
            </span>
          )}
        </For>
      </Show>
    </button>
  )
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
  },
  i18n: {
    en: {
      "command.limits": "OpenCode Go limits",
      "command.settings": "OpenCode Go limits: settings",
      "limits.ok": "OK",
      "limits.refresh": "Refresh",
      "limits.settings": "Settings",
      "limits.console": "Console",
      "limits.consoleHint": "Open OpenCode Console in browser",
      "limits.paceHint": "Estimated time left at current pace",
      "limits.reset": "reset",
      "limits.in": "in",
      "limits.noServer": "cannot reach plugin server",
      "limits.failed": "Failed to load limits",
      "settings.title": "OpenCode Go limits",
      "settings.description": "Configure where limits are shown, alerts, and GitHub auto-updates",
      "settings.section.display": "Display",
      "settings.section.notifications": "Notifications",
      "settings.section.updates": "Updates",
      "settings.placement.title": "Widget position",
      "settings.placement.description": "Where to show the usage indicator in OpenCode",
      "settings.placement.bottom": "Bottom bar (default)",
      "settings.placement.top": "Top bar (session header)",
      "settings.placement.both": "Bottom + top bar",
      "settings.placement.titlebar": "Titlebar / sidebar button",
      "settings.placement.hidden": "Hidden (command only)",
      "settings.preview.label": "Preview",
      "settings.windows.title": "Windows in strip",
      "settings.windows.description": "Choose which windows appear on the bar",
      "settings.windows.all": "All",
      "settings.style.title": "Indicator style",
      "settings.style.description": "Bars with %, text only, or bars only",
      "settings.style.bars_pct": "Bar + %",
      "settings.style.text": "Text only",
      "settings.style.bars": "Bars only",
      "settings.labels.title": "Show window labels",
      "settings.labels.description": "Show 5h, 1w, 1m prefixes",
      "settings.alerts.title": "Threshold alerts (80% / 100%)",
      "settings.alerts.description": "Show a toast when any quota window reaches 80% or 100%",
      "settings.autoUpdate.title": "Auto-update from GitHub",
      "settings.autoUpdate.description": "Automatically download and install new releases from GitHub",
      "settings.version.title": "Plugin version",
      "settings.version.checking": "Checking for updates…",
      "settings.version.upToDate": "v{{version}} · Up to date",
      "settings.version.available": "v{{current}} → v{{latest}} available",
      "settings.version.restart": "Updated to v{{version}} · Restart OpenCode Desktop to apply",
      "settings.version.error": "v{{version}} · Check failed: {{error}}",
      "settings.update.check": "Check now",
      "settings.update.install": "Update now",
      "settings.update.installedToast": "opencode-limits-go updated to v{{version}}. Restart OpenCode Desktop to apply.",
      "settings.update.failedToast": "Update failed: {{error}}",
      "settings.done": "Done",
      "settings.openAll": "Open in Settings",
    },
    ru: {
      "command.limits": "Лимиты OpenCode Go",
      "command.settings": "Лимиты OpenCode Go: настройки",
      "limits.ok": "ОК",
      "limits.refresh": "Обновить",
      "limits.settings": "Настройки",
      "limits.console": "Консоль",
      "limits.consoleHint": "Открыть OpenCode Console в браузере",
      "limits.paceHint": "Оценка запаса по текущему темпу",
      "limits.reset": "сброс",
      "limits.in": "через",
      "limits.noServer": "нет связи с сервером плагина",
      "limits.failed": "Не удалось получить лимиты",
      "settings.title": "Лимиты OpenCode Go",
      "settings.description": "Настройка расположения, уведомлений и автообновлений с GitHub",
      "settings.section.display": "Отображение",
      "settings.section.notifications": "Уведомления",
      "settings.section.updates": "Обновления",
      "settings.placement.title": "Расположение виджета",
      "settings.placement.description": "Где показывать индикатор лимитов в окне OpenCode",
      "settings.placement.bottom": "Снизу (строка состояния)",
      "settings.placement.top": "Сверху (в топбаре сессии)",
      "settings.placement.both": "Снизу и сверху",
      "settings.placement.titlebar": "Кнопка в заголовке / сайдбаре",
      "settings.placement.hidden": "Скрыто (только /limits)",
      "settings.preview.label": "Предпросмотр",
      "settings.windows.title": "Окна в мини-барах",
      "settings.windows.description": "Какие лимиты показывать на панели",
      "settings.windows.all": "Все",
      "settings.style.title": "Вид индикатора",
      "settings.style.description": "Бары с %, только текст или только бары",
      "settings.style.bars_pct": "Бар + %",
      "settings.style.text": "Без баров",
      "settings.style.bars": "Только бары",
      "settings.labels.title": "Подписи окон",
      "settings.labels.description": "Показывать префиксы 5ч, 1н, 1м",
      "settings.alerts.title": "Уведомления о порогах (80% / 100%)",
      "settings.alerts.description": "Показывать тост, когда окно доходит до 80% или 100%",
      "settings.autoUpdate.title": "Автообновление с GitHub",
      "settings.autoUpdate.description": "Автоматически скачивать и устанавливать новые релизы с GitHub",
      "settings.version.title": "Версия плагина",
      "settings.version.checking": "Проверка обновлений…",
      "settings.version.upToDate": "v{{version}} · Актуальная версия",
      "settings.version.available": "Доступна v{{latest}} (текущая v{{current}})",
      "settings.version.restart": "Обновлено до v{{version}} · Перезапустите OpenCode Desktop",
      "settings.version.error": "v{{version}} · Ошибка проверки: {{error}}",
      "settings.update.check": "Проверить",
      "settings.update.install": "Обновить",
      "settings.update.installedToast": "opencode-limits-go обновлён до v{{version}}. Перезапустите OpenCode Desktop.",
      "settings.update.failedToast": "Не удалось обновить: {{error}}",
      "settings.done": "Готово",
      "settings.openAll": "В общих настройках",
    },
  },
  setup(ctx) {
    const ui = ctx.ui
    const prefs = ctx.stores.prefs
    const strip = ctx.stores.strip
    const [card, setCard] = createSignal<LimitCard | null>(null)
    const [ready, setReady] = createSignal(false)
    const [refreshing, setRefreshing] = createSignal(false)
    const [updateInfo, setUpdateInfo] = createSignal<UpdateStatusInfo | null>(null)
    const [updateBusy, setUpdateBusy] = createSignal(false)
    const notified = new Map<string, number>()
    let notifiedUpdateVersion = ""

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

    const stripTooltip = () => {
      const c = card()
      const base = ctx.t("command.limits")
      return c?.ok ? `${base} · ${cardText(c, lang())}` : base
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

    async function refresh(force = false): Promise<LimitCard | null> {
      if (ctx.signal.aborted) return null
      if (force) setRefreshing(true)
      try {
        const currentLang = lang()
        const result = (await ctx.client
          .rpc(Limits)
          .status({ force, lang: currentLang }, { signal: ctx.signal })) as LimitCard
        if (ctx.signal.aborted) return null
        setCard(result)
        setReady(true)
        if (result.ok) {
          const now = Date.now()
          const triggered = newAlerts(result.rows, notified)
          if (prefs.value.alerts) {
            for (const row of triggered) {
              ctx.toast.show({
                variant: row.used >= 100 ? "error" : "default",
                title: alertMessage(row, now, currentLang),
              })
            }
          }
        }
        return result
      } catch {
        if (ctx.signal.aborted) return null
        setCard(emptyCard(ctx.t("limits.noServer")))
        setReady(true)
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
          .updateStatus({ check: checkNow, autoInstall: prefs.value.autoUpdate }, { signal: ctx.signal })) as UpdateStatusInfo
        if (ctx.signal.aborted) return
        setUpdateInfo(res)
        if (res.autoUpdated || res.restartRequired) {
          notifyUpdated(res.latestVersion)
        }
      } catch {} finally {
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
          ctx.toast.show({ variant: "error", title: ctx.t("settings.update.failedToast", { error: String(error) }) })
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

    const timer = setInterval(() => void refresh(), 90_000)
    onCleanup(() => clearInterval(timer))

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

    function DisplayFields(props: { page?: boolean }) {
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

      const previewStrip = () => (
        <LimitsStrip
          card={previewCard()}
          ready={true}
          lang={lang()}
          light={light()}
          showBars={prefs.value.showBars}
          showPercent={strip.value.showPercent}
          showLabels={strip.value.showLabels}
          visible={visibleWindows()}
          variant={prefs.value.placement === "top" ? "top" : "bottom"}
          preview
          onOpen={() => {}}
        />
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
              onChange={(value) => prefs.update((draft) => { draft.placement = value })}
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
            id="opencode-limits-go-labels"
            title={ctx.t("settings.labels.title")}
            description={ctx.t("settings.labels.description")}
          >
            <ui.Switch
              label={ctx.t("settings.labels.title")}
              hideLabel
              checked={strip.value.showLabels}
              onChange={(checked) => strip.update((draft) => { draft.showLabels = checked })}
            />
          </SettingField>
        </>
      )
    }

    function NotificationFields(props: { page?: boolean }) {
      return (
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
            onChange={(checked) => prefs.update((draft) => { draft.alerts = checked })}
          />
        </SettingField>
      )
    }

    function updateDescription(): string {
      const info = updateInfo()
      if (!info) return ctx.t("settings.version.checking")
      if (info.restartRequired) return ctx.t("settings.version.restart", { version: info.latestVersion })
      if (info.error) return ctx.t("settings.version.error", { version: info.currentVersion, error: info.error })
      if (info.updateAvailable) {
        return ctx.t("settings.version.available", { current: info.currentVersion, latest: info.latestVersion })
      }
      return ctx.t("settings.version.upToDate", { version: info.currentVersion })
    }

    function UpdateFields(props: { page?: boolean }) {
      const canInstall = () => !!updateInfo()?.updateAvailable && !updateInfo()?.restartRequired
      return (
        <>
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
                prefs.update((draft) => { draft.autoUpdate = checked })
                void syncAutoUpdate(checked)
              }}
            />
          </SettingField>
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
              <ui.Button variant="contrast" autofocus onClick={dialog.close}>
                {ctx.t("settings.done")}
              </ui.Button>
            </div>
          }
        >
          <div style="display:flex;flex-direction:column;gap:12px;width:100%;box-sizing:border-box;">
            <DisplayFields />
            <NotificationFields />
            <UpdateFields />
          </div>
        </ui.Dialog>
      ))
    }

    function openCard(initial: LimitCard) {
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
          const source = sourceLabel(c.source, lang())
          return `${c.org}${c.email ? ` · ${c.email}` : ""} · ${c.checkedAt}${source ? ` · ${source}` : ""}`
        }

        const handleRefresh = async () => {
          const next = await refresh(true)
          if (ctx.signal.aborted) return
          setNow(Date.now())
          if (!next || !next.ok) {
            ctx.toast.show({ variant: "error", title: next?.error ?? ctx.t("limits.failed") })
          }
        }

        const pace = () => paceSummary(current().rows, now(), lang())
        const paceColor = () => {
          const k = pace()?.kind
          if (k === "exhausted") return "#ef4444"
          if (k === "hot") return "#f59e0b"
          return undefined
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
                    <ui.IconButton
                      icon="square-arrow-top-right"
                      label={ctx.t("limits.console")}
                      variant="neutral"
                      onClick={() => ctx.system.openExternal(CONSOLE_URL)}
                    />
                  </ui.Tooltip>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                  <ui.Button variant="neutral" icon="refresh" busy={refreshing()} onClick={() => void handleRefresh()}>
                    {ctx.t("limits.refresh")}
                  </ui.Button>
                  <ui.Button variant="contrast" autofocus onClick={dialog.close}>
                    {ctx.t("limits.ok")}
                  </ui.Button>
                </div>
              </div>
            }
          >
            <div style="display:flex;flex-direction:column;gap:8px;width:100%;box-sizing:border-box;">
              <For each={current().rows}>
                {(row: LimitRow) => {
                  const resetLine = () => {
                    const r = resetText(row.resetsAtMs, row.resetsIn, now(), lang())
                    return r.passed
                      ? `${ctx.t("limits.reset")} ${row.resetsAt} · ${r.text}`
                      : `${ctx.t("limits.reset")} ${row.resetsAt} · ${ctx.t("limits.in")} ${r.text}`
                  }
                  const rowPace = () => estimateWindowPace(row, now(), lang())
                  return (
                    <div style="display:flex;align-items:center;gap:10px;font-size:12px;">
                      <span style="width:24px;opacity:.7;">{windowLabel(row, lang())}</span>
                      <MiniBar used={row.used} width={70} light={light()} />
                      <span style="width:34px;text-align:right;font-variant-numeric:tabular-nums;">{row.used}%</span>
                      <span style="opacity:.55;font-size:11px;">
                        {resetLine()}
                        {row.status !== "ok" ? ` · ${row.status}` : ""}
                      </span>
                      <Show when={rowPace()?.kind === "hot"}>
                        <ui.Tooltip value={ctx.t("limits.paceHint")}>
                          <span style="margin-left:auto;font-size:11px;color:#f59e0b;font-variant-numeric:tabular-nums;">
                            ⚡ ~{span(rowPace()!.timeToFullMs, lang())}
                          </span>
                        </ui.Tooltip>
                      </Show>
                    </div>
                  )
                }}
              </For>
              <div style="font-size:11px;opacity:.7;">{tightLine(current().rows, now(), lang())}</div>
              <Show when={pace()}>
                <div style={`font-size:11px;opacity:.85;${paceColor() ? `color:${paceColor()};` : ""}`}>
                  {pace()!.text}
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
        ctx.toast.show({ variant: "error", title: result?.error ?? ctx.t("limits.failed") })
        return
      }
      openCard(result)
    }

    ctx.add(Command, (): Command => ({
      id: "limits",
      title: ctx.t("command.limits"),
      bind: "ctrl+shift+l",
      slash: { name: "limits" },
      run: () => showLimits(false),
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
          keywords: "zen limits opencode go quota usage",
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
          id: "opencode-limits-go-labels",
          title: ctx.t("settings.labels.title"),
          description: ctx.t("settings.labels.description"),
          keywords: "labels prefix 5h 1w 1m minimal",
        },
        {
          id: "opencode-limits-go-alerts",
          title: ctx.t("settings.alerts.title"),
          description: ctx.t("settings.alerts.description"),
          keywords: "toast alert 80 100 notification",
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
              <ui.Button variant="ghost" icon="square-arrow-top-right" onClick={() => ctx.system.openExternal(CONSOLE_URL)}>
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
              lang={lang()}
              light={light()}
              showBars={prefs.value.showBars}
              showPercent={strip.value.showPercent}
              showLabels={strip.value.showLabels}
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
              lang={lang()}
              light={light()}
              showBars={prefs.value.showBars && !input.compact}
              showPercent={strip.value.showPercent || input.compact}
              showLabels={strip.value.showLabels}
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
      const rows = current?.ok ? filterStripRows(current.rows, visibleWindows()) : []
      const label = current?.ok
        ? rows
            .map((r) => (strip.value.showLabels ? `${windowLabel(r, l)} ${r.used}%` : `${r.used}%`))
            .join(" · ")
        : `${l === "ru" ? "лимиты" : "limits"}: ${ready() ? current?.error || "—" : "…"}`
      const fullTitle = current?.ok ? `${ctx.t("command.limits")}: ${cardText(current, l)}` : `${ctx.t("command.limits")}: ${label}`
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
