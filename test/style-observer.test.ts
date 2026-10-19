// @vitest-environment jsdom
import { test, expect, vi } from "vitest"

import { buildInjectionExpression } from "../src/runtime/injector.ts"
test("D2 unrelated chat DOM updates trigger observer maintenance do not rewrite the wallpaper style", async () => {
  vi.useFakeTimers()
  const install = new Function(buildInjectionExpression("body {color: red}"))
  install()
  const style = document.getElementById("codex-skin-style")!
  let writes = 0
  const observe = new MutationObserver((records) => {
    writes += records.length
  })
  observe.observe(style, { attributes: true, attributeFilter: ["data-codex-skin-hash"] })
  for (let i = 0; i < 100; i++) {
    document.body.appendChild(document.createElement("div"))
  }
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(150)
  await Promise.resolve()
  expect(writes).toBe(0)
  expect(document.getElementById("codex-skin-style")).toBe(style)
  expect(document.querySelectorAll("#codex-skin-style")).toHaveLength(1)
  style.remove()
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(150)
  expect(document.getElementById("codex-skin-style")).toBeTruthy()
  ;(window as any).__codexSkinCleanup()
  observe.disconnect()
  vi.useRealTimers()
})
