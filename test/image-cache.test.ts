import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { test, expect, vi } from "vitest"
const h = vi.hoisted(() => ({ reads: 0, file: "" }))
vi.mock("node:fs/promises", async (original) => {
  const actual: any = await original()
  return {
    ...actual,
    readFile: async (...args: any[]) => {
      if (args[0] === h.file) h.reads++
      return actual.readFile(...args)
    },
  }
})
import { syncConfiguredBackground } from "../src/runtime/background-service.ts"
import { normalizeConfig } from "../src/runtime/config.ts"
test("D1 each connected transparency apply uses the cached image, even when only opacity changed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skin-image-read-"))
  h.file = path.join(dir, "test.png")
  try {
    await writeFile(
      h.file,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk9sAAAAASUVORK5CYII=",
        "base64",
      ),
    )
    const config = normalizeConfig({
      enabled: true,
      wallpaper: { enabled: true, image: h.file, backgroundTransparency: 0.4 },
      surfaces: { main: { enabled: false }, sidebar: { enabled: false } },
    })
    const deps = {
      isCdpAvailableImpl: async () => true,
      injectAllTargetsImpl: async () => [{ ok: true }],
    }
    h.reads = 0
    await syncConfiguredBackground(config, deps)
    expect(h.reads).toBe(1)
    await syncConfiguredBackground(
      { ...config, wallpaper: { ...config.wallpaper, backgroundTransparency: 0.6 } },
      deps,
    )
    expect(h.reads).toBe(1)
    await writeFile(h.file, Buffer.from([137, 80, 78, 71, 1]))
    await syncConfiguredBackground(config, deps)
    expect(h.reads).toBe(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
