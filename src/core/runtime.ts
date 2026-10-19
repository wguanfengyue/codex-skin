import {
  backgroundStatus,
  configuredCdpIsReady,
  injectConfiguredBackground,
  startConfiguredBackground,
  syncConfiguredBackground,
} from "../runtime/background-service.ts"
import type { BackgroundServiceOptions } from "../runtime/background-service.ts"
import { buildBackgroundCss } from "../runtime/css.ts"
import { verifyAllTargets } from "../runtime/injector.ts"
import type { TargetVerification } from "../runtime/injector.ts"
import { configRevision } from "../runtime/runtime-state.ts"
import type { BackgroundApplication, BackgroundConfig } from "../runtime/types.ts"
import { createOperationQueue } from "./operation-queue.ts"

/** Per-launch behavior that is intentionally separate from reusable runtime dependencies. */
export interface CodexSkinCoreStartOptions {
  restartRunningCodex?: boolean
}

/** Reusable background engine consumed by command-line and desktop adapters. */
export interface CodexSkinCore {
  backgroundRunning(): Promise<boolean | undefined>
  configuredCdpIsReady(config: BackgroundConfig): ReturnType<typeof configuredCdpIsReady>
  inject(config: BackgroundConfig): Promise<number>
  start(
    config: BackgroundConfig,
    options?: CodexSkinCoreStartOptions,
  ): Promise<BackgroundApplication>
  status(
    config: BackgroundConfig,
    options?: { preferRecordedState?: boolean },
  ): ReturnType<typeof backgroundStatus>
  sync(config: BackgroundConfig): Promise<BackgroundApplication>
  verify(config: BackgroundConfig, options?: { reload?: boolean }): Promise<TargetVerification[]>
}

/** Dependencies and host adapters retained by a reusable core instance. */
export type CodexSkinCoreOptions = Omit<BackgroundServiceOptions, "restartRunningCodex">

/**
 * Creates a reusable Codex Skin engine without depending on a CLI or desktop window.
 *
 * The caller supplies lifecycle behavior once. CLI consumers can provide an entry path for the
 * detached daemon, while desktop clients can provide an in-process `backgroundLifecycle`.
 */
export function createCodexSkinCore(options: CodexSkinCoreOptions = {}): CodexSkinCore {
  const enqueue = createOperationQueue()
  const starts = new Map<string, Promise<BackgroundApplication>>()
  return {
    backgroundRunning: async () => await options.backgroundLifecycle?.isRunning?.(),
    configuredCdpIsReady: async (config) => await configuredCdpIsReady(config, options),
    inject: async (config) => await enqueue(() => injectConfiguredBackground(config, options)),
    start: (config, startOptions = {}) => {
      const restart = startOptions.restartRunningCodex === true
      const key = `${configRevision(config)}:${restart}`
      const existing = starts.get(key)
      if (existing) return existing
      const task = enqueue(() => startConfiguredBackground(config, { ...options, ...startOptions }))
      starts.set(key, task)
      void task
        .finally(() => {
          if (starts.get(key) === task) starts.delete(key)
        })
        .catch(() => undefined)
      return task
    },
    status: async (config, statusOptions = {}) =>
      await backgroundStatus(config, { ...options, ...statusOptions }),
    sync: async (config) => await enqueue(() => syncConfiguredBackground(config, options)),
    verify: async (config, verifyOptions = {}) =>
      await verifyAllTargets({
        css: await buildBackgroundCss(config),
        port: config.port,
        reload: verifyOptions.reload === true,
      }),
  }
}
