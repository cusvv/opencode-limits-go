import { Plugin } from "@opencode/plugin"
import { Limits } from "./rpc.ts"
import { fetchUsage } from "./server/api.ts"
import { createCredentials } from "./server/auth.ts"
import { log } from "./server/log.ts"
import { EVENT_TYPES } from "./server/service/events.ts"
import { createLimitsService } from "./server/service/service.ts"
import { createUpdater } from "./server/updater.ts"

type RpcEventName = "changed" | "updated" | "prefsChanged"
type EmitEvent = (name: RpcEventName, data: unknown) => Promise<void>

export default Plugin.define({
  id: "opencode-limits-go",
  async setup(ctx) {
    let emitEvent: EmitEvent = async () => {}
    const updater = createUpdater({
      onInstalled: (version) => {
        void emitEvent("updated", { version }).catch(() => {})
      },
    })
    const service = createLimitsService({
      storage: {
        get: (key) => ctx.storage.get(key),
        set: (key, value) => ctx.storage.set(key, value as never),
        remove: (key) => ctx.storage.remove(key),
      },
      credentials: createCredentials({
        integration: ctx.integration,
        provider: ctx.provider,
        options: ctx.options,
      }),
      fetchUsage,
      log,
      options: ctx.options,
      updater,
      emit: (name, data) => emitEvent(name, data),
    })
    await service.init()

    const registration = await ctx.rpc.register(Limits, {
      status: (input, call) => service.status(input, { signal: call.signal }),
      getPrefs: () => service.getPrefs(),
      setPrefs: (input) => service.setPrefs(input),
      updateStatus: (input) => service.updateStatus(input),
      installUpdate: () => service.installUpdate(),
      setUpdateConfig: (input) => service.setUpdateConfig(input),
      diagnostics: () => service.diagnostics(),
    })
    emitEvent = (name, data) => registration.events.emit(name as never, data as never)

    const stopEvents = service.subscribe(
      ctx.event.subscribe({ types: EVENT_TYPES, signal: service.signal }) as AsyncIterable<unknown>,
    )

    return async () => {
      stopEvents()
      await service.dispose()
    }
  },
})
