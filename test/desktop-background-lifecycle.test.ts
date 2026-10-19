import assert from "node:assert/strict"

import { test } from "vitest"

import { createDesktopBackgroundLifecycle } from "../src/desktop/background-lifecycle.ts"

test("desktop lifecycle reuses one monitor and stops it through AbortSignal", async () => {
  let monitorStarts = 0
  let stopDaemonCalls = 0
  let receivedSignal: AbortSignal | undefined
  const lifecycle = createDesktopBackgroundLifecycle({
    dataDirectory: "/tmp/codex-skin-desktop-test",
    runMonitorImpl: async ({ signal }) => {
      monitorStarts += 1
      receivedSignal = signal
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()))
    },
    stopDaemonImpl: async () => {
      stopDaemonCalls += 1
      return null
    },
  })

  assert.deepEqual(await lifecycle.start(), {
    owner: "desktop",
    pid: process.pid,
    started: true,
  })
  assert.deepEqual(await lifecycle.start(), {
    owner: "desktop",
    pid: process.pid,
    started: false,
  })
  assert.equal(await lifecycle.isRunning?.(), true)
  assert.equal(monitorStarts, 1)
  assert.equal(stopDaemonCalls, 1)

  assert.equal(await lifecycle.stop(), process.pid)
  assert.equal(receivedSignal?.aborted, true)
  assert.equal(await lifecycle.isRunning?.(), false)
  assert.equal(stopDaemonCalls, 2)
})

test("concurrent desktop starts establish only one monitor before stop drains it", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let starts = 0,
    stops = 0
  const lifecycle = createDesktopBackgroundLifecycle({
    dataDirectory: "/tmp/codex-skin-concurrent",
    stopDaemonImpl: async () => {
      stops++
      if (stops === 1) await gate
      return null
    },
    runMonitorImpl: async ({ signal }) => {
      starts++
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true }),
      )
    },
  })
  const first = lifecycle.start(),
    second = lifecycle.start(),
    stop = lifecycle.stop()
  release()
  assert.equal((await first).started, true)
  assert.equal((await second).started, false)
  await stop
  assert.equal(starts, 1)
  assert.equal(await lifecycle.isRunning?.(), false)
})
