import assert from "node:assert/strict"

import { test } from "vitest"

import { normalizeConfig } from "../src/runtime/config.ts"
import { configRevision, runtimeSnapshot } from "../src/runtime/runtime-state.ts"

const config = normalizeConfig({
  enabled: true,
  wallpaper: { enabled: true, image: "/fixture.png" },
})
test("applied requires a connected client, at least one target and current configuration", () => {
  const ready = {
    codexPid: 42,
    cdpReady: true,
    targetCount: 1,
    appliedRevision: configRevision(config),
  }
  assert.equal(runtimeSnapshot(config, ready).application, "applied")
  assert.equal(runtimeSnapshot(config, { ...ready, targetCount: 0 }).application, "pending")
  assert.equal(
    runtimeSnapshot(config, { ...ready, appliedRevision: "outdated" }).application,
    "pending",
  )
  const disconnected = runtimeSnapshot(config, {
    ...ready,
    cdpReady: false,
    lastSuccessAt: "2026-01-01T00:00:00Z",
  })
  assert.equal(disconnected.application, "pending")
  assert.equal(disconnected.targetCount, 0)
  assert.equal(disconnected.appliedRevision, undefined)
  assert.equal(disconnected.lastSuccessAt, "2026-01-01T00:00:00Z")
})
test("disabled, missing client and occupied port remain distinct states", () => {
  assert.equal(
    runtimeSnapshot({ ...config, enabled: false }, { codexPid: null, cdpReady: false }).application,
    "disabled",
  )
  assert.equal(
    runtimeSnapshot(config, { codexPid: null, cdpReady: false }).connection,
    "client-not-running",
  )
  assert.equal(
    runtimeSnapshot(config, { codexPid: 42, cdpReady: false }).connection,
    "needs-restart",
  )
  assert.equal(
    runtimeSnapshot(config, { codexPid: 42, cdpReady: false, occupied: true }).connection,
    "port-in-use",
  )
})
