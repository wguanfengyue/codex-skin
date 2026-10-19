import { createHash, randomUUID } from "node:crypto"
import { readFile, mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"

import type { RuntimeSnapshot } from "../shared/protocol.ts"
import { resolveDataDirectory } from "./config.ts"
import type { BackgroundConfig, DataDirectoryOptions } from "./types.ts"

export function configRevision(config: BackgroundConfig) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        enabled: config.enabled,
        wallpaper: config.wallpaper,
        surfaces: config.surfaces,
      }),
    )
    .digest("hex")
    .slice(0, 16)
}

export function runtimeSnapshot(
  config: BackgroundConfig,
  observation: {
    codexPid: number | null
    cdpReady: boolean
    clientRunning?: boolean
    occupied?: boolean
    targetCount?: number
    appliedRevision?: string
    lastSuccessAt?: string
    error?: string
  },
): RuntimeSnapshot {
  const desiredRevision = configRevision(config)
  const targetCount = observation.cdpReady ? (observation.targetCount ?? 0) : 0
  const applied =
    config.enabled &&
    observation.cdpReady &&
    targetCount > 0 &&
    observation.appliedRevision === desiredRevision
  return {
    connection: observation.occupied
      ? "port-in-use"
      : observation.cdpReady
        ? "connected"
        : observation.codexPid || observation.clientRunning
          ? "needs-restart"
          : "client-not-running",
    application: !config.enabled
      ? "disabled"
      : observation.error
        ? "failed"
        : applied
          ? "applied"
          : "pending",
    desiredRevision,
    ...(applied ? { appliedRevision: desiredRevision } : {}),
    targetCount,
    codexPid: observation.codexPid,
    observedAt: new Date().toISOString(),
    ...(observation.lastSuccessAt ? { lastSuccessAt: observation.lastSuccessAt } : {}),
    ...(observation.error ? { reason: observation.error } : {}),
  }
}

export async function readRuntimeRecord(options: DataDirectoryOptions = {}) {
  try {
    return JSON.parse(
      await readFile(
        path.join(options.dataDirectory || resolveDataDirectory(options.env), "daemon-state.json"),
        "utf8",
      ),
    ) as {
      codexPid?: number | null
      runtime?: RuntimeSnapshot
    }
  } catch {
    return null
  }
}

/** Keep legacy diagnostic fields while making stale successes explicitly historical. */
export async function writeRuntimeRecord(
  runtime: RuntimeSnapshot,
  options: DataDirectoryOptions = {},
) {
  const directory = options.dataDirectory || resolveDataDirectory(options.env)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, "daemon-state.json")
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(
    temporary,
    JSON.stringify(
      {
        pid: process.pid,
        codexPid: runtime.codexPid,
        updatedAt: runtime.observedAt,
        injectedTargets: runtime.application === "applied" ? runtime.targetCount : 0,
        failedTargets: runtime.application === "failed" ? 1 : 0,
        runtime,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  )
  await rename(temporary, file)
}
