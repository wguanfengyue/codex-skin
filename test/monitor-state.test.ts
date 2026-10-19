import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { test } from "vitest"

import { runBackgroundMonitor } from "../src/runtime/background-monitor.ts"
import { normalizeConfig } from "../src/runtime/config.ts"
import type { RuntimeSnapshot } from "../src/shared/protocol.ts"

async function scenario(plan: boolean[], targets = 1) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "skin-monitor-"))
  const abort = new AbortController()
  const states: RuntimeSnapshot[] = []
  let step = 0,
    injections = 0,
    closes = 0
  try {
    const image = path.join(directory, "image.png")
    await writeFile(image, Buffer.from([137, 80, 78, 71]))
    const config = normalizeConfig({
      enabled: true,
      pollIntervalMs: 1,
      wallpaper: { enabled: true, image },
      surfaces: { main: { enabled: false }, sidebar: { enabled: false } },
    })
    await runBackgroundMonitor({
      dataDirectory: directory,
      signal: abort.signal,
      readConfigImpl: async () => config,
      observeClientImpl: async () => ({ pid: 42, ready: plan[step++]!, occupied: false }),
      createSessionsImpl: () => ({
        synchronize: async () => {
          injections++
          return Array.from({ length: targets }, () => ({ ok: true }))
        },
        close: () => {
          closes++
        },
      }),
      writeStateImpl: async (state) => {
        states.push(state)
        if (step >= plan.length) abort.abort()
      },
    })
    return { states, injections, closes }
  } finally {
    abort.abort()
    await rm(directory, { recursive: true, force: true })
  }
}
test("monitor publishes disconnect, resumes injection and clears current success when stopped", async () => {
  const { states, injections, closes } = await scenario([true, false, true])
  assert.deepEqual(
    states.slice(0, 3).map((state) => state.application),
    ["applied", "pending", "applied"],
  )
  assert.equal(states[1]!.connection, "needs-restart")
  assert.equal(states[1]!.targetCount, 0)
  assert.ok(states[1]!.lastSuccessAt)
  assert.equal(states.at(-1)!.application, "pending")
  assert.equal(states.at(-1)!.reason, "monitor-stopped")
  assert.equal(injections, 2)
  assert.equal(closes, 2)
})
test("initially missing CDP is published even when no injection session has ever existed", async () => {
  const { states, injections } = await scenario([false])
  assert.equal(states[0]!.connection, "needs-restart")
  assert.equal(states[0]!.targetCount, 0)
  assert.equal(injections, 0)
})
test("CDP without an injectable window is pending rather than applied", async () => {
  const { states } = await scenario([true], 0)
  assert.equal(states[0]!.connection, "connected")
  assert.equal(states[0]!.application, "pending")
})
