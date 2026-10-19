import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises"
import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createCodexSkinCore } from "../core/index.ts"
import type { CodexSkinCore } from "../core/index.ts"
import { startConfiguredBackground } from "./background-service.ts"
import { readConfig, resolveDataDirectory, writeConfig } from "./config.ts"
import { readDaemonPid } from "./daemon.ts"
import {
  codexSkinProcessCommandMatches,
  inspectProcess,
  listProcesses,
  processIdentityMatches,
  terminateProcesses,
} from "./process.ts"
import type { ProcessIdentity, ProcessSummary } from "./process.ts"
import { startBackgroundRestartWorker } from "./restart-worker.ts"
import {
  bundledBackgroundCatalog,
  selectBundledBackground,
  uploadImage,
  IMAGE_EXTENSIONS,
} from "./settings-assets.ts"
import {
  COOKIE_NAME,
  readJsonBody,
  securityHeaders,
  sendJson,
  requestIsAuthenticated,
  serveStaticFile,
  statusForError,
} from "./settings-http.ts"
import { mutateSettings } from "./settings-mutations.ts"
import type {
  BackgroundConfig,
  BackgroundConfigInput,
  BackgroundImageTarget,
  BackgroundSurface,
  DataDirectoryOptions,
  SpawnImplementation,
  SurfaceBackgroundConfigInput,
  WallpaperConfigInput,
} from "./types.ts"
import { BACKGROUND_SURFACES, errorCode, errorMessage } from "./types.ts"

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const defaultUiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/ui")
const EDITABLE_CONFIG_KEYS = new Set(["enabled", "menuBarIcon"])
const EDITABLE_WALLPAPER_KEYS = new Set([
  "backgroundTransparency",
  "enabled",
  "fit",
  "positionX",
  "positionY",
])
const EDITABLE_SURFACE_KEYS = new Set([
  "enabled",
  "illustrationSize",
  "illustrationX",
  "illustrationY",
  "illustrationBlur",
  "illustrationOpacity",
])
const LEGACY_MAIN_SURFACE_KEYS = new Set(
  [...EDITABLE_SURFACE_KEYS].filter((key) => key !== "enabled"),
)
type KillProcess = (pid: number, signal: NodeJS.Signals | 0) => boolean

interface SettingsProcessOptions extends DataDirectoryOptions {
  inspectProcessImpl?: (pid: number) => Promise<ProcessIdentity | null>
  killProcessImpl?: KillProcess
  listProcessesImpl?: () => Promise<ProcessSummary[]>
}

export interface SettingsOptions extends SettingsProcessOptions {
  authenticatedRedirectUrl?: string
  backgroundsRoot?: string
  core?: CodexSkinCore
  entryPath?: string
  idleTimeoutMs?: number | null
  isCdpAvailableImpl?: (options: { port: number }) => Promise<boolean>
  onConfigChange?: (config: BackgroundConfig) => Promise<void> | void
  port?: number
  spawnImpl?: SpawnImplementation
  startBackgroundRestartWorkerImpl?: typeof startBackgroundRestartWorker
  startConfiguredBackgroundImpl?: typeof startConfiguredBackground
  token?: string
  uiRoot?: string
}

function coreForSettings(options: SettingsOptions) {
  return (
    options.core ||
    createCodexSkinCore({
      dataDirectory: options.dataDirectory,
      entryPath: options.entryPath,
      isCdpAvailableImpl: options.isCdpAvailableImpl,
    })
  )
}

interface SettingsServerState {
  pid: number
  port: number
  process?: ProcessIdentity
  startedAt: string
  token: string
}

interface SettingsServerIdentity extends ProcessIdentity {
  pid: number
}

function runtimePaths(options: DataDirectoryOptions = {}) {
  const dataDirectory = options.dataDirectory || resolveDataDirectory(options.env)
  return {
    lock: path.join(dataDirectory, "settings-server.lock"),
    state: path.join(dataDirectory, "settings-server.json"),
  }
}

export function settingsServerIdentityMatches(
  state: SettingsServerState,
  actual: ProcessIdentity | null,
) {
  if (
    !actual ||
    !/(?:^|[\\/])codex-skin(?:\.(?:js|ts))?\s+settings-server(?:\s|$)/.test(actual.command)
  ) {
    return false
  }
  if (!state.process) return true
  return actual.command === state.process.command && actual.startedAt === state.process.startedAt
}

async function readSettingsServerIdentity(filePath: string) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as SettingsServerIdentity
  } catch (error) {
    if (errorCode(error) === "ENOENT" || error instanceof SyntaxError) return null
    throw error
  }
}

async function readVerifiedSettingsServerIdentity(
  filePath: string,
  options: SettingsProcessOptions,
) {
  const identity = await readSettingsServerIdentity(filePath)
  if (!identity) return null
  const actual = await (options.inspectProcessImpl || inspectProcess)(identity.pid)
  return processIdentityMatches(identity, actual) ? identity : null
}

async function claimSettingsServerLock(
  identity: SettingsServerIdentity,
  options: SettingsProcessOptions,
) {
  const lockPath = runtimePaths(options).lock
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, `${JSON.stringify(identity, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      })
      return true
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
      if (await readVerifiedSettingsServerIdentity(lockPath, options)) return false
      await rm(lockPath, { force: true })
    }
  }
  return false
}

async function releaseSettingsServerLock(pid: number, options: SettingsProcessOptions) {
  const lockPath = runtimePaths(options).lock
  const owner = await readSettingsServerIdentity(lockPath)
  if (owner?.pid === pid) await rm(lockPath, { force: true })
}

/** Returns every independently launched settings server except the caller. */
export function settingsServerPidsFromProcesses(
  processes: ProcessSummary[],
  currentPid = process.pid,
) {
  return processes
    .filter(
      ({ command, pid }) =>
        pid !== currentPid && codexSkinProcessCommandMatches(command, "settings-server"),
    )
    .map(({ pid }) => pid)
}

async function discoveredSettingsServerPids(options: SettingsProcessOptions) {
  const activeDataDirectory = path.resolve(
    options.dataDirectory || resolveDataDirectory(options.env),
  )
  const defaultDataDirectory = path.resolve(resolveDataDirectory(options.env))
  if (!options.listProcessesImpl && activeDataDirectory !== defaultDataDirectory) return []
  return settingsServerPidsFromProcesses(await (options.listProcessesImpl || listProcesses)())
}

function editableConfig(input: unknown): BackgroundConfigInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Configuration must be a JSON object.")
  }
  const source = input as Record<string, unknown>
  const result = Object.fromEntries(
    Object.entries(source).filter(([key]) => EDITABLE_CONFIG_KEYS.has(key)),
  ) as BackgroundConfigInput
  const surfaces =
    source.surfaces && typeof source.surfaces === "object" && !Array.isArray(source.surfaces)
      ? (source.surfaces as Record<string, unknown>)
      : {}
  const surfaceUpdates: Partial<Record<BackgroundSurface, SurfaceBackgroundConfigInput>> = {}
  let wallpaperUpdate: WallpaperConfigInput | undefined
  if (result.enabled !== undefined) {
    for (const surface of BACKGROUND_SURFACES) {
      surfaceUpdates[surface] = { enabled: Boolean(result.enabled) }
    }
    wallpaperUpdate = { enabled: Boolean(result.enabled) }
  }
  const wallpaper = source.wallpaper
  if (wallpaper && typeof wallpaper === "object" && !Array.isArray(wallpaper)) {
    wallpaperUpdate = {
      ...wallpaperUpdate,
      ...Object.fromEntries(
        Object.entries(wallpaper).filter(([key]) => EDITABLE_WALLPAPER_KEYS.has(key)),
      ),
    }
  }
  const legacyMainUpdate = Object.fromEntries(
    Object.entries(source).filter(([key]) => LEGACY_MAIN_SURFACE_KEYS.has(key)),
  )
  if (Object.keys(legacyMainUpdate).length > 0) {
    surfaceUpdates.main = { ...surfaceUpdates.main, ...legacyMainUpdate }
  }
  for (const surface of BACKGROUND_SURFACES) {
    const candidate = surfaces[surface]
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
    surfaceUpdates[surface] = {
      ...surfaceUpdates[surface],
      ...Object.fromEntries(
        Object.entries(candidate).filter(([key]) => EDITABLE_SURFACE_KEYS.has(key)),
      ),
    }
  }
  if (Object.keys(surfaceUpdates).length > 0) result.surfaces = surfaceUpdates
  if (wallpaperUpdate) result.wallpaper = wallpaperUpdate
  return result
}

async function statePayload(config: BackgroundConfig, options: SettingsOptions) {
  const core = coreForSettings(options)
  const [status, backgroundRunning] = await Promise.all([
    core.status(config),
    core.backgroundRunning(),
  ])
  return {
    bundledBackgrounds: await bundledBackgroundCatalog(config, { ...options, core }),
    config,
    status: {
      ...status,
      daemonRunning:
        backgroundRunning ?? Boolean(await readDaemonPid({ dataDirectory: options.dataDirectory })),
    },
  }
}

async function saveAndSync(input: unknown, options: SettingsOptions) {
  const current = await readConfig({ dataDirectory: options.dataDirectory })
  const updates = editableConfig(input)
  const config = await writeConfig(
    {
      ...current,
      ...updates,
      wallpaper: { ...current.wallpaper, ...updates.wallpaper },
      surfaces: {
        main: { ...current.surfaces.main, ...updates.surfaces?.main },
        sidebar: { ...current.surfaces.sidebar, ...updates.surfaces?.sidebar },
      },
    },
    { dataDirectory: options.dataDirectory },
  )
  await options.onConfigChange?.(config)
  const backgroundChanged = Object.keys(updates).some((key) => key !== "menuBarIcon")
  const application = backgroundChanged
    ? await coreForSettings(options).sync(config)
    : { applied: true, mode: "saved" as const }
  return { ...(await statePayload(config, options)), application }
}

function imageTarget(pathname: string): BackgroundImageTarget | undefined {
  if (pathname === "/api/image") return "main"
  if (pathname === "/api/wallpaper/image") return "wallpaper"
  const match = pathname.match(/^\/api\/surfaces\/(main|sidebar)\/image$/)
  return match?.[1] as BackgroundSurface | undefined
}

function bundledBackgroundTarget(pathname: string): BackgroundImageTarget | undefined {
  const match = pathname.match(/^\/api\/bundled-backgrounds\/(wallpaper|main|sidebar)$/)
  return match?.[1] as BackgroundImageTarget | undefined
}

export function createSettingsHttpServer(options: SettingsOptions) {
  if (!options.entryPath && !options.core) {
    throw new Error("The settings server requires a core instance or CLI entry path.")
  }
  const token = options.token || randomBytes(24).toString("hex")
  const dataDirectory = options.dataDirectory || resolveDataDirectory(options.env)
  const uiRoot = options.uiRoot || defaultUiRoot
  const backgroundsRoot = options.backgroundsRoot || path.join(uiRoot, "backgrounds")
  const core =
    options.core ||
    createCodexSkinCore({
      dataDirectory,
      entryPath: options.entryPath,
      isCdpAvailableImpl: options.isCdpAvailableImpl,
    })
  const runtimeOptions = { ...options, backgroundsRoot, core, dataDirectory, uiRoot }
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const armIdleTimer = () => {
    if (options.idleTimeoutMs === null) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => server.close(), options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS)
    idleTimer.unref()
  }

  const server = http.createServer(async (request, response) => {
    armIdleTimer()
    securityHeaders(response)
    const url = new URL(request.url || "/", "http://127.0.0.1")

    if (request.method === "GET" && url.pathname === "/" && url.searchParams.get("token")) {
      if (url.searchParams.get("token") !== token) {
        sendJson(response, 403, { error: "Invalid settings session." })
        return
      }
      response.statusCode = 303
      response.setHeader("set-cookie", `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`)
      response.setHeader("location", options.authenticatedRedirectUrl || "/")
      response.end()
      return
    }

    if (!requestIsAuthenticated(request, token)) {
      sendJson(response, 403, { error: "Open the settings page from codex-skin settings." })
      return
    }

    try {
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        if (await serveStaticFile(response, url.pathname, uiRoot)) return
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        const config = await readConfig({ dataDirectory })
        const running =
          (await core.backgroundRunning()) ?? Boolean(await readDaemonPid({ dataDirectory }))
        const status = await core.status(config, { preferRecordedState: running })
        sendJson(response, 200, { status: { ...status, daemonRunning: running } })
        return
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        const config = await readConfig({ dataDirectory })
        sendJson(response, 200, await statePayload(config, runtimeOptions))
        return
      }

      const requestedImageTarget = imageTarget(url.pathname)
      if (request.method === "GET" && requestedImageTarget) {
        const config = await readConfig({ dataDirectory })
        const image =
          requestedImageTarget === "wallpaper"
            ? config.wallpaper.image
            : config.surfaces[requestedImageTarget].image
        if (!image) {
          response.statusCode = 404
          response.end()
          return
        }
        const extension = path.extname(image).toLowerCase()
        const mediaType =
          [...IMAGE_EXTENSIONS.entries()].find(([, value]) => value === extension)?.[0] ||
          (extension === ".jpeg" ? "image/jpeg" : null)
        if (!mediaType) throw new Error("The configured image type is not supported.")
        response.statusCode = 200
        response.setHeader("content-type", mediaType)
        response.end(await readFile(image))
        return
      }

      if (request.method === "PUT" && url.pathname === "/api/config") {
        const input = await readJsonBody(request)
        sendJson(
          response,
          200,
          await mutateSettings(runtimeOptions, () => saveAndSync(input, runtimeOptions)),
        )
        return
      }

      const selectedBundledBackground = bundledBackgroundTarget(url.pathname)
      if (request.method === "POST" && selectedBundledBackground) {
        const input = await readJsonBody(request)
        const result = await mutateSettings(runtimeOptions, () =>
          selectBundledBackground(input, selectedBundledBackground, runtimeOptions),
        )
        sendJson(response, 200, {
          ...(await statePayload(result.config, runtimeOptions)),
          application: result.application,
        })
        return
      }
      if (request.method === "POST" && requestedImageTarget) {
        const result = await mutateSettings(runtimeOptions, () =>
          uploadImage(request, requestedImageTarget, runtimeOptions),
        )
        sendJson(response, 200, {
          ...(await statePayload(result.config, runtimeOptions)),
          application: result.application,
        })
        return
      }

      if (request.method === "POST" && url.pathname === "/api/start") {
        const input = await readJsonBody(request)
        const restartRunningCodex =
          typeof input === "object" &&
          input !== null &&
          "restartRunningCodex" in input &&
          input.restartRunningCodex === true
        const config = await readConfig({ dataDirectory })
        if (restartRunningCodex) {
          const payload = await statePayload(config, runtimeOptions)
          response.once("finish", () => {
            try {
              if (options.entryPath) {
                const startRestartWorker =
                  options.startBackgroundRestartWorkerImpl || startBackgroundRestartWorker
                startRestartWorker({ entryPath: options.entryPath })
              } else {
                void core
                  .start(config, { restartRunningCodex: true })
                  .catch((error) => console.error("Unable to restart Codex:", error))
              }
            } catch (error) {
              console.error("Unable to hand off the Codex restart:", error)
            }
          })
          sendJson(response, 202, {
            ...payload,
            application: { applied: false, mode: "restarting" },
          })
          return
        }
        const application = options.startConfiguredBackgroundImpl
          ? await options.startConfiguredBackgroundImpl(config, runtimeOptions)
          : await core.start(config)
        const activeConfig = await readConfig({ dataDirectory })
        sendJson(response, 200, {
          ...(await statePayload(activeConfig, runtimeOptions)),
          application,
        })
        return
      }

      sendJson(response, 404, { error: "Not found." })
    } catch (error) {
      sendJson(response, statusForError(error), {
        code: errorCode(error) || "BAD_REQUEST",
        error: errorMessage(error),
      })
    }
  })

  server.once("close", () => clearTimeout(idleTimer))
  armIdleTimer()
  return { server, token, dataDirectory }
}

export async function listenSettingsServer(options: SettingsOptions) {
  const instance = createSettingsHttpServer(options)
  await new Promise<void>((resolve, reject) => {
    instance.server.once("error", reject)
    instance.server.listen(options.port || 0, "127.0.0.1", resolve)
  })
  const address = instance.server.address() as AddressInfo
  const state: SettingsServerState = {
    pid: process.pid,
    port: address.port,
    token: instance.token,
    startedAt: new Date().toISOString(),
  }
  return {
    ...instance,
    state,
    url: `http://127.0.0.1:${state.port}/?token=${state.token}`,
  }
}

export async function runSettingsServerDaemon(options: SettingsOptions & { entryPath: string }) {
  const dataDirectory = options.dataDirectory || resolveDataDirectory(options.env)
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  const processIdentity = await (options.inspectProcessImpl || inspectProcess)(process.pid)
  if (!processIdentity) throw new Error("Unable to verify the settings server process.")
  const identity = { ...processIdentity, pid: process.pid }
  if (!(await claimSettingsServerLock(identity, options))) return

  const statePath = runtimePaths({ dataDirectory }).state
  try {
    const instance = await listenSettingsServer({ ...options, dataDirectory })
    await writeFile(
      statePath,
      `${JSON.stringify({ ...instance.state, process: processIdentity }, null, 2)}\n`,
      { mode: 0o600 },
    )

    const close = () => instance.server.close()
    process.once("SIGTERM", close)
    process.once("SIGINT", close)
    await new Promise<void>((resolve) => instance.server.once("close", resolve))
  } finally {
    const current = await readSettingsServerIdentity(statePath)
    if (current?.pid === process.pid) await unlink(statePath).catch(() => undefined)
    await releaseSettingsServerLock(process.pid, options)
  }
}

export async function readSettingsServerState(
  options: SettingsProcessOptions = {},
): Promise<SettingsServerState | null> {
  try {
    const state = JSON.parse(
      await readFile(runtimePaths(options).state, "utf8"),
    ) as SettingsServerState
    const actual = await (options.inspectProcessImpl || inspectProcess)(state.pid)
    return settingsServerIdentityMatches(state, actual) ? state : null
  } catch (error) {
    if (errorCode(error) === "ENOENT" || error instanceof SyntaxError) return null
    throw error
  }
}

/** Stops the detached settings server without signaling an unrelated recycled PID. */
export async function stopSettingsServer(options: SettingsProcessOptions = {}) {
  const paths = runtimePaths(options)
  const [state, lockOwner, discovered] = await Promise.all([
    readSettingsServerState(options),
    readVerifiedSettingsServerIdentity(paths.lock, options),
    discoveredSettingsServerPids(options),
  ])
  const pids = [...discovered, ...(state ? [state.pid] : []), ...(lockOwner ? [lockOwner.pid] : [])]
  await terminateProcesses(pids, options)
  await Promise.all([rm(paths.lock, { force: true }), rm(paths.state, { force: true })])
  return state?.pid || lockOwner?.pid || pids[0] || null
}

export async function ensureSettingsServer({
  entryPath,
  spawnImpl = spawn as SpawnImplementation,
  ...options
}: SettingsOptions & { entryPath: string }) {
  const paths = runtimePaths(options)
  const [existing, lockOwner, discovered] = await Promise.all([
    readSettingsServerState(options),
    readVerifiedSettingsServerIdentity(paths.lock, options),
    discoveredSettingsServerPids(options),
  ])
  if (existing && lockOwner?.pid === existing.pid) {
    await terminateProcesses(
      discovered.filter((pid) => pid !== existing.pid),
      options,
    )
    return {
      ...existing,
      started: false,
      url: `http://127.0.0.1:${existing.port}/?token=${existing.token}`,
    }
  }
  await terminateProcesses(
    [...discovered, ...(existing ? [existing.pid] : []), ...(lockOwner ? [lockOwner.pid] : [])],
    options,
  )
  await Promise.all([rm(paths.lock, { force: true }), rm(paths.state, { force: true })])

  const child = spawnImpl(process.execPath, [entryPath, "settings-server"], {
    detached: true,
    env: {
      ...process.env,
      CODEX_SKIN_HOME: options.dataDirectory || resolveDataDirectory(options.env),
    },
    stdio: "ignore",
  })
  child.unref()
  if (!child.pid) throw new Error("Unable to start the settings server.")

  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const [state, registeredLock] = await Promise.all([
      readSettingsServerState(options),
      readVerifiedSettingsServerIdentity(paths.lock, options),
    ])
    if (state && registeredLock?.pid === state.pid) {
      return {
        ...state,
        started: state.pid === child.pid,
        url: `http://127.0.0.1:${state.port}/?token=${state.token}`,
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("The settings server did not start within 5 seconds.")
}

export function openSettingsPage(url: string, options: { spawnImpl?: SpawnImplementation } = {}) {
  const child = (options.spawnImpl || (spawn as SpawnImplementation))("open", [url], {
    detached: true,
    stdio: "ignore",
  })
  child.unref()
}
