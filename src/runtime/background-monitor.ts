import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"

import type { RuntimeSnapshot } from "../shared/protocol.ts"
import { isCdpAvailable } from "./cdp.ts"
import { findCodexProcessId, inspectCdpPort } from "./client.ts"
import { configuredBackgroundImages, readConfig, resolveDataDirectory } from "./config.ts"
import { buildBackgroundCss } from "./css.ts"
import { imageRevision } from "./image-resource.ts"
import { removeFromAllTargets, TargetSessionManager } from "./injector.ts"
import { configRevision, runtimeSnapshot, writeRuntimeRecord } from "./runtime-state.ts"
import type { BackgroundConfig, DataDirectoryOptions } from "./types.ts"
import { errorMessage } from "./types.ts"

export interface BackgroundMonitorOptions extends DataDirectoryOptions {
  exitWhenCodexCloses?: boolean
  signal?: AbortSignal
  readConfigImpl?: typeof readConfig
  observeClientImpl?: (
    config: BackgroundConfig,
  ) => Promise<{ pid: number | null; ready: boolean; occupied: boolean }>
  createSessionsImpl?: (port: number) => Pick<TargetSessionManager, "synchronize" | "close">
  writeStateImpl?: (state: RuntimeSnapshot) => Promise<void>
  removeImpl?: typeof removeFromAllTargets
}

function waitForNextPoll(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delayMs)
    function finish() {
      signal?.removeEventListener("abort", finish)
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener("abort", finish, { once: true })
  })
}

/** Observe every state transition; retain historical success without reporting it as current. */
export async function runBackgroundMonitor(options: BackgroundMonitorOptions = {}) {
  const directory = options.dataDirectory || resolveDataDirectory(options.env)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const log = (error: unknown) =>
    appendFile(
      path.join(directory, "daemon.log"),
      `${new Date().toISOString()} ${errorMessage(error)}\n`,
      { mode: 0o600 },
    )
  const publish = options.writeStateImpl || ((state) => writeRuntimeRecord(state, options))
  let observedCodex = false
  let cachedSignature = "",
    cachedCss = ""
  let sessions: Pick<TargetSessionManager, "synchronize" | "close"> | undefined
  let sessionPort: number | undefined
  let lastSuccessAt: string | undefined
  let lastSnapshot: RuntimeSnapshot | undefined
  let previousState = ""
  let lastWrite = 0
  try {
    while (!options.signal?.aborted) {
      let pollIntervalMs = 3000
      let config: BackgroundConfig | undefined
      let pid: number | null = null
      try {
        config = await (options.readConfigImpl || readConfig)(options)
        pollIntervalMs = config.pollIntervalMs
        const observation = options.observeClientImpl
          ? await options.observeClientImpl(config)
          : await observeClient(config)
        pid = observation.pid
        if (pid) observedCodex = true
        const revision = configRevision(config)
        let targetCount = 0
        let appliedRevision: string | undefined
        const hasImages = configuredBackgroundImages(config).length > 0
        if (config.enabled && hasImages && observation.ready && !options.signal?.aborted) {
          const signature = revision + (await imageRevision(configuredBackgroundImages(config)))
          if (signature !== cachedSignature) {
            cachedCss = await buildBackgroundCss(config)
            cachedSignature = signature
          }
          if (!sessions || sessionPort !== config.port) {
            sessions?.close()
            sessionPort = config.port
            sessions =
              options.createSessionsImpl?.(config.port) ||
              new TargetSessionManager({
                port: config.port,
                onError: (error) => {
                  void log(error).catch(() => undefined)
                },
              })
          }
          // Do not inject a configuration superseded while preparing image data.
          const latest = await (options.readConfigImpl || readConfig)(options)
          if (configRevision(latest) === revision && !options.signal?.aborted) {
            const results = await sessions.synchronize(cachedCss)
            targetCount = results.filter((result) => result.ok).length
            if (targetCount > 0) {
              appliedRevision = revision
              lastSuccessAt = new Date().toISOString()
            }
          }
        } else if (sessions) {
          const port = sessionPort || config.port
          sessions.close()
          sessions = undefined
          sessionPort = undefined
          cachedSignature = ""
          if (observation.ready && !options.signal?.aborted)
            await (options.removeImpl || removeFromAllTargets)({ port })
        }
        const state = runtimeSnapshot(config, {
          codexPid: pid,
          cdpReady: observation.ready,
          occupied: observation.occupied,
          targetCount,
          appliedRevision,
          lastSuccessAt,
        })
        lastSnapshot = state
        const signature = JSON.stringify({
          ...state,
          observedAt: undefined,
          lastSuccessAt: undefined,
        })
        if (signature !== previousState || Date.now() - lastWrite >= 30000) {
          await publish(state)
          previousState = signature
          lastWrite = Date.now()
        }
        if (options.exitWhenCodexCloses && codexLifecycleEnded(observedCodex, pid)) break
      } catch (error) {
        if (config)
          await publish(
            runtimeSnapshot(config, {
              codexPid: pid,
              cdpReady: false,
              lastSuccessAt,
              error: errorMessage(error),
            }),
          )
        await log(error)
      }
      await waitForNextPoll(pollIntervalMs, options.signal)
    }
  } finally {
    sessions?.close()
    if (lastSnapshot)
      await publish({
        ...lastSnapshot,
        observedAt: new Date().toISOString(),
        application: lastSnapshot.application === "disabled" ? "disabled" : "pending",
        targetCount: 0,
        appliedRevision: undefined,
        reason: "monitor-stopped",
      })
  }
}

async function observeClient(config: BackgroundConfig) {
  const inspection = await inspectCdpPort(config.appPath, config.port)
  const pid = inspection.codexPid ?? (await findCodexProcessId(config.appPath))
  return {
    pid,
    occupied: inspection.state === "occupied",
    ready: inspection.state === "codex" && (await isCdpAvailable({ port: config.port })),
  }
}

export function codexLifecycleEnded(observedCodex: boolean, codexPid: number | null) {
  return observedCodex && codexPid === null
}
