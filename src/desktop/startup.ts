import type { CodexSkinCore } from "../core/index.ts"
import { BackgroundStateError } from "../runtime/background-service.ts"
import type { BackgroundConfig } from "../runtime/types.ts"

/** Failure is observable without silently restarting an already-running client. */
export async function startDesktopBackground(
  core: CodexSkinCore,
  config: BackgroundConfig,
  report: (message: string, detail: string) => Promise<void>,
) {
  try {
    await core.start(config)
  } catch (error) {
    if (error instanceof BackgroundStateError && error.code === "RESTART_REQUIRED") {
      await report(
        "ChatGPT 已打开，但背景尚未启用",
        "当前 ChatGPT 未开启背景连接。请在 Codex Skin 中点击“启动背景模式”，确认重启后应用；配置和图片已保留。",
      )
      return
    }
    await report(
      "Codex Skin 暂时无法启动背景服务",
      error instanceof Error ? error.message : String(error),
    )
  }
}
