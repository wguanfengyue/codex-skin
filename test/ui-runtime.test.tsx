import { render, screen, fireEvent, act, cleanup } from "@testing-library/react"
// @vitest-environment jsdom
import { test, expect, vi, afterEach } from "vitest"

import { App } from "../src/ui/app.tsx"
import { defaultConfig, emptyBundledBackgroundCatalog } from "../src/ui/model.ts"
const configuration = () => ({
  ...structuredClone(defaultConfig),
  enabled: true,
  wallpaper: { ...defaultConfig.wallpaper, enabled: true, image: "/fixture.png" },
})
const status = (ready: boolean) => ({
  cdpAvailable: ready,
  cdpPortState: ready ? "codex" : "available",
  daemonRunning: ready,
  imageReadable: true,
  wallpaper: { imageReadable: true },
  surfaces: { main: { imageReadable: false }, sidebar: { imageReadable: false } },
})
function setup() {
  Object.defineProperty(document, "hidden", { configurable: true, value: false })
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
}
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test("C1 actual React App refreshes connection after focus without replacing the configuration draft", async () => {
  setup()
  vi.useFakeTimers()
  let ready = false
  let reads = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      reads++
      return new Response(
        JSON.stringify({
          config: configuration(),
          status: status(ready),
          bundledBackgrounds: emptyBundledBackgroundCatalog(),
        }),
        { headers: { "content-type": "application/json" } },
      )
    }),
  )
  render(<App />)
  await act(async () => {})
  expect(reads).toBe(1)
  expect(screen.getByText("等待启动背景模式")).toBeTruthy()
  fireEvent.change(screen.getByRole("slider", { name: /背景色透明度/ }), {
    target: { value: "0.37" },
  })
  ready = true
  await act(async () => {
    window.dispatchEvent(new Event("focus"))
    document.dispatchEvent(new Event("visibilitychange"))
    await vi.advanceTimersByTimeAsync(60000)
  })
  expect((screen.getByRole("slider", { name: /背景色透明度/ }) as HTMLInputElement).value).toBe(
    "0.37",
  )
  expect(reads).toBeGreaterThan(1)
  expect(screen.getByText("背景已连接")).toBeTruthy()
})

test("C2 actual slider save submits new value and distinguishes disconnected save from successful apply", async () => {
  setup()
  let ready = false
  const puts: any[] = []
  let current = configuration()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: any, opts: any) => {
      let application
      if (opts?.method === "PUT") {
        const body = JSON.parse(opts.body)
        puts.push(body)
        current = { ...current, wallpaper: { ...current.wallpaper, ...body.wallpaper } }
        application = ready
          ? { applied: true, mode: "injected", targets: 1 }
          : { applied: false, mode: "saved", reason: "cdp-unavailable" }
      }
      return new Response(
        JSON.stringify({
          config: current,
          status: status(ready),
          bundledBackgrounds: emptyBundledBackgroundCatalog(),
          application,
        }),
        { headers: { "content-type": "application/json" } },
      )
    }),
  )
  render(<App />)
  await act(async () => {})
  fireEvent.change(screen.getByRole("slider", { name: /背景色透明度/ }), {
    target: { value: "0.42" },
  })
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /保存壁纸参数/ }))
  })
  expect(puts[0].wallpaper.backgroundTransparency).toBe(0.42)
  expect(screen.getAllByText(/背景设置已保存。请正常退出/).length).toBeGreaterThan(0)
  ready = true
  fireEvent.change(screen.getByRole("slider", { name: /背景色透明度/ }), {
    target: { value: "0.63" },
  })
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /保存壁纸参数/ }))
  })
  expect(puts[1].wallpaper.backgroundTransparency).toBe(0.63)
  expect(screen.getByText("背景已连接")).toBeTruthy()
  expect(screen.getAllByText("背景已应用到 1 个 Codex 窗口。").length).toBeGreaterThan(0)
})

test("a late status response cannot overwrite a newer save acknowledgement", async () => {
  setup()
  vi.useFakeTimers()
  let resolve!: (value: Response) => void
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    ),
  )
  const { renderHook } = await import("@testing-library/react")
  const { useRuntimeStatus } = await import("../src/ui/hooks/use-runtime-status.ts")
  const hook = renderHook(() => useRuntimeStatus())
  await act(async () => {
    window.dispatchEvent(new Event("focus"))
  })
  act(() => hook.result.current.updateStatus(status(true)))
  await act(async () => {
    resolve(new Response(JSON.stringify({ status: status(false) })))
    await Promise.resolve()
  })
  expect(hook.result.current.status?.cdpAvailable).toBe(true)
  hook.unmount()
})

test("an unresponsive status request times out and is released for subsequent refreshes", async () => {
  setup()
  vi.useFakeTimers()
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          )
        }),
    ),
  )
  const { renderHook } = await import("@testing-library/react")
  const { useRuntimeStatus } = await import("../src/ui/hooks/use-runtime-status.ts")
  const hook = renderHook(() => useRuntimeStatus())
  await act(async () => {
    window.dispatchEvent(new Event("focus"))
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(hook.result.current.connectionFailed).toBe(true)
  hook.unmount()
})
