import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { test, expect } from "vitest"

import { createCodexSkinCore } from "../src/core/runtime.ts"
import { writeConfig, readConfig } from "../src/runtime/config.ts"
import { listenSettingsServer } from "../src/runtime/settings-server.ts"
test("E1 real HTTP + disk + core pipeline saves disconnected value and actually applies connected value into generated CSS", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skin-http-audit-"))
  let instance: any
  let ready = false
  let appliedCss = ""
  let running = false
  try {
    const image = path.join(dir, "test.png")
    await writeFile(
      image,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk9sAAAAASUVORK5CYII=",
        "base64",
      ),
    )
    await writeConfig(
      {
        enabled: true,
        wallpaper: { enabled: true, image },
        surfaces: { main: { enabled: false }, sidebar: { enabled: false } },
      },
      { dataDirectory: dir },
    )
    const core = createCodexSkinCore({
      dataDirectory: dir,
      isCdpAvailableImpl: async () => ready,
      injectAllTargetsImpl: async ({ css }) => {
        appliedCss = css
        return [{ ok: true }]
      },
      backgroundLifecycle: {
        isRunning: async () => running,
        start: async () => {
          running = true
          return { pid: 1 }
        },
        stop: async () => {
          running = false
          return null
        },
      },
    })
    instance = await listenSettingsServer({
      dataDirectory: dir,
      core,
      idleTimeoutMs: null,
      token: "isolated-audit-session",
    })
    const bootstrap = await fetch(instance.url, { redirect: "manual" })
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!
    const origin = new URL(instance.url).origin
    expect((await fetch(origin + "/api/status")).status).toBe(403)
    const statusResponse = await fetch(origin + "/api/status", { headers: { cookie } })
    expect(statusResponse.status).toBe(200)
    const statusPayload = await statusResponse.json()
    expect(statusPayload.status.cdpAvailable).toBe(false)
    expect(statusPayload.config).toBeUndefined()
    async function save(value: number) {
      const res = await fetch(origin + "/api/config", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ wallpaper: { backgroundTransparency: value } }),
      })
      expect(res.status).toBe(200)
      return res.json()
    }
    const offline = await save(0.42)
    expect(offline.application).toEqual({
      applied: false,
      mode: "saved",
      reason: "cdp-unavailable",
    })
    expect((await readConfig({ dataDirectory: dir })).wallpaper.backgroundTransparency).toBe(0.42)
    expect(appliedCss).toBe("")
    ready = true
    const online = await save(0.63)
    expect(online.application).toMatchObject({ applied: true, mode: "injected", targets: 1 })
    expect((await readConfig({ dataDirectory: dir })).wallpaper.backgroundTransparency).toBe(0.63)
    expect(appliedCss).toContain("var(--codex-base-surface) 37%, transparent")
  } finally {
    if (instance) {
      instance.server.closeAllConnections()
      await new Promise<void>((r) => instance.server.close(() => r()))
    }
    await rm(dir, { recursive: true, force: true })
  }
})

test("concurrent HTTP patches preserve independent fields and never overlap apply operations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skin-concurrent-http-"))
  let active = 0,
    maximum = 0
  const core = createCodexSkinCore({
    dataDirectory: directory,
    isCdpAvailableImpl: async () => false,
    backgroundLifecycle: {
      start: async () => ({ pid: 1 }),
      stop: async () => null,
      isRunning: async () => false,
    },
  })
  const sync = core.sync
  core.sync = async (config) => {
    active++
    maximum = Math.max(maximum, active)
    try {
      await new Promise((resolve) => setTimeout(resolve, 15))
      return await sync(config)
    } finally {
      active--
    }
  }
  const instance = await listenSettingsServer({
    core,
    dataDirectory: directory,
    idleTimeoutMs: null,
    token: "http-mutation-test",
  })
  try {
    const bootstrap = await fetch(instance.url, { redirect: "manual" })
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!
    const origin = new URL(instance.url).origin
    const patch = (wallpaper: object) =>
      fetch(origin + "/api/config", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ wallpaper }),
      })
    const results = await Promise.all([
      patch({ backgroundTransparency: 0.2 }),
      patch({ positionX: 76 }),
    ])
    expect(results.map((result) => result.status)).toEqual([200, 200])
    const config = await readConfig({ dataDirectory: directory })
    expect(config.wallpaper.backgroundTransparency).toBe(0.2)
    expect(config.wallpaper.positionX).toBe(76)
    expect(maximum).toBe(1)
  } finally {
    instance.server.closeAllConnections()
    await new Promise<void>((resolve) => instance.server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
