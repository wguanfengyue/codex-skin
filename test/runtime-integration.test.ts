import { mkdtemp, writeFile, rm } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import { test, expect } from "vitest"

import { startDesktopBackground } from "../src/desktop/startup.ts"
import {
  BackgroundStateError,
  syncConfiguredBackground,
  startConfiguredBackground,
} from "../src/runtime/background-service.ts"
import { CdpConnection } from "../src/runtime/cdp.ts"
import { normalizeConfig } from "../src/runtime/config.ts"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk9sAAAAASUVORK5CYII=",
  "base64",
)
async function imageConfig(task: (config: any) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skin-audit-"))
  try {
    const image = path.join(dir, "test.png")
    await writeFile(image, png)
    await task(
      normalizeConfig({
        enabled: true,
        wallpaper: { enabled: true, image, backgroundTransparency: 0.25 },
        surfaces: { main: { enabled: false }, sidebar: { enabled: false } },
      }),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("startup reports a restart requirement and other failures; success is quiet", async () => {
  for (const code of ["RESTART_REQUIRED", "CDP_TIMEOUT", null]) {
    let reports = 0
    await startDesktopBackground(
      {
        start: async () => {
          if (code) throw new BackgroundStateError(code, code)
        },
      } as any,
      normalizeConfig(),
      async () => {
        reports++
      },
    )
    expect(reports).toBe(code ? 1 : 0)
  }
})

test("A2 ordinary-running client without CDP explicitly requires restart and never silently restarts", () =>
  imageConfig(async (config) => {
    let quits = 0,
      launches = 0
    await expect(
      startConfiguredBackground(config, {
        appExecutableExistsImpl: async () => true,
        isCodexRunningImpl: async () => true,
        isCdpAvailableImpl: async () => false,
        quitCodexImpl: async () => {
          quits++
        },
        launchCodexImpl: async () => {
          launches++
          return 1
        },
      }),
    ).rejects.toMatchObject({ code: "RESTART_REQUIRED" })
    expect(quits).toBe(0)
    expect(launches).toBe(0)
  }))

test("A3 disconnected apply returns explicit saved/applied:false; connected apply generates correct transparency", () =>
  imageConfig(async (config) => {
    let injections = 0,
      css = ""
    const dependencies = {
      isCdpAvailableImpl: async () => false,
      injectAllTargetsImpl: async (options: any) => {
        injections++
        css = options.css
        return [{ ok: true }]
      },
      ensureDaemonImpl: async () => ({ pid: 1 }),
      entryPath: "/fake",
    }
    expect(await syncConfiguredBackground(config, dependencies)).toEqual({
      applied: false,
      mode: "saved",
      reason: "cdp-unavailable",
    })
    expect(injections).toBe(0)
    const online = await syncConfiguredBackground(config, {
      ...dependencies,
      isCdpAvailableImpl: async () => true,
    })
    expect(online).toMatchObject({ applied: true, mode: "injected", targets: 1 })
    expect(injections).toBe(1)
    expect(css).toContain("var(--codex-base-surface) 75%, transparent")
  }))

test("A4 real loopback TCP server that never completes WebSocket handshake rejects within configured timeout", async () => {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on("error", () => {})
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as net.AddressInfo).port
  const c = new CdpConnection(`ws://127.0.0.1:${port}/devtools/page/test`, { timeoutMs: 30 })
  let settled = false
  const p = c.connect().then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await new Promise((r) => setTimeout(r, 180))
  expect(sockets.size).toBeGreaterThan(0)
  expect(settled).toBe(true)
  c.close()
  for (const s of sockets) s.destroy()
  await new Promise<void>((r) => server.close(() => r()))
  await Promise.race([p, new Promise((r) => setTimeout(r, 50))])
})

test("A5 close before WebSocket open settles connect", async () => {
  class CloseBeforeOpen extends EventTarget {
    static OPEN = 1
    readyState = 0
    constructor() {
      super()
      queueMicrotask(() => {
        this.readyState = 3
        this.dispatchEvent(new Event("close"))
      })
    }
    close() {}
    send() {}
  }
  const c = new CdpConnection("ws://127.0.0.1:1/test", {
    timeoutMs: 20,
    WebSocketImpl: CloseBeforeOpen as any,
  })
  let settled = false
  void c.connect().then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await new Promise((r) => setTimeout(r, 80))
  expect(settled).toBe(true)
  c.close()
})

test("A6 real local WebSocket server connects successfully and receives a CDP response", async () => {
  const { WebSocketServer } = await import("ws")
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>((r) => server.once("listening", r))
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const { id } = JSON.parse(raw.toString())
      socket.send(JSON.stringify({ id, result: { ok: true } }))
    }),
  )
  const c = new CdpConnection(`ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/page`, {
    timeoutMs: 100,
  })
  try {
    await c.connect()
    expect(await c.call("Runtime.enable")).toEqual({ ok: true })
  } finally {
    c.close()
    for (const client of server.clients) client.terminate()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test("A7 CDP response timeout works once handshake has completed", async () => {
  const { WebSocketServer } = await import("ws")
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>((r) => server.once("listening", r))
  const c = new CdpConnection(`ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/page`, {
    timeoutMs: 30,
  })
  try {
    await c.connect()
    await expect(c.call("Runtime.enable")).rejects.toThrow("CDP call timed out")
  } finally {
    c.close()
    for (const client of server.clients) client.terminate()
    await new Promise<void>((r) => server.close(() => r()))
  }
})
