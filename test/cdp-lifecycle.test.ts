import assert from "node:assert/strict"
import net from "node:net"

import { test } from "vitest"

import { CdpConnection } from "../src/runtime/cdp.ts"

class Socket extends EventTarget {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 0
  constructor() {
    super()
    Socket.instances.push(this)
  }
  send() {}
  close() {
    this.readyState = 3
    this.dispatchEvent(new Event("close"))
  }
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event("open"))
  }
}

test("real loopback handshake is bounded even when the TCP peer never responds", async () => {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on("error", () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const c = new CdpConnection(`ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/page`, {
    timeoutMs: 30,
  })
  try {
    await assert.rejects(c.connect(), /handshake timed out/)
  } finally {
    c.close()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("concurrent connects share one handshake and can retry after early close", async () => {
  const c = new CdpConnection("ws://127.0.0.1:9229/page", { WebSocketImpl: Socket, timeoutMs: 500 })
  const first = c.connect(),
    duplicate = c.connect()
  assert.equal(first, duplicate)
  Socket.instances.at(-1)!.close()
  await assert.rejects(first, /closed before opening/)
  const retry = c.connect()
  Socket.instances.at(-1)!.open()
  await retry
  assert.equal(c.connected, true)
  c.close()
})

test("explicit close and AbortSignal immediately settle a pending handshake", async () => {
  for (const cancel of ["close", "abort"]) {
    const abort = new AbortController()
    const c = new CdpConnection("ws://127.0.0.1:9229/page", {
      WebSocketImpl: Socket,
      timeoutMs: 5000,
    })
    const pending = c.connect({ signal: abort.signal })
    if (cancel === "close") c.close()
    else abort.abort()
    await assert.rejects(pending, /cancelled/)
    assert.equal(c.connected, false)
  }
})

test("close rejects outstanding CDP calls without waiting for request timeouts", async () => {
  const c = new CdpConnection("ws://127.0.0.1:9229/page", {
    WebSocketImpl: Socket,
    timeoutMs: 5000,
  })
  const connect = c.connect()
  Socket.instances.at(-1)!.open()
  await connect
  const pending = c.call("Runtime.enable")
  c.close()
  await assert.rejects(pending, /closed/)
})
