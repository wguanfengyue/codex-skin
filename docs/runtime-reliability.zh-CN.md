# 运行状态与连接可靠性改造

此维护分支基于上游 `1e400abef7d370f34bfa8d6d7c9d679d8d665962`（1.2.2）。它保留现有配置格式、CLI 和桌面入口，集中修复连接生命周期与状态同步。

## 已实现

- CDP 握手有超时，并发连接共享握手；连接提前关闭、取消或显式关闭时立即结束等待，关闭时清理未完成请求。
- Core 变更操作按顺序执行，相同配置的重复启动共享任务；桌面后台启动、接管和停止也按顺序执行。
- 后台记录初次未连接、断开、恢复、零窗口和停止状态。只有当前配置确实应用到窗口，才显示“已应用”；历史成功时间单独保留。
- 启动遇到已运行的普通模式 ChatGPT 时明确提示需要重启，继续由用户发起重启，不静默退出用户正在工作的客户端。
- 设置页定时及恢复前台时刷新运行状态，保留未保存的表单；过期状态响应不能覆盖保存后的新状态。状态请求有超时和卸载清理。
- HTTP 安全与静态资源、图片管理、配置变更排队分别抽取为模块，前后端共用浏览器安全的配置与响应类型。原 API 保留，增加受同一认证保护的 `GET /api/status`。
- 图片数据采用有容量、条目数量和文件元数据失效机制的缓存；同一图片调整透明度不重复读图，同路径图片更新会失效。
- 样式观察器只关注根节点与 head 中的样式丢失，不再因普通聊天内容变化重复写入壁纸；后台关闭后丢弃迟到的重新加载回调。

## 主要代码入口

| 职责                 | 文件                                                 |
| -------------------- | ---------------------------------------------------- |
| Core 门面与操作排队  | `src/core/runtime.ts`、`operation-queue.ts`          |
| 状态推导与诊断落盘   | `src/runtime/runtime-state.ts`                       |
| 后台监控             | `src/runtime/background-monitor.ts`                  |
| CDP 传输生命周期     | `src/runtime/cdp.ts`                                 |
| 图片缓存             | `src/runtime/image-resource.ts`                      |
| HTTP 和图片边界      | `src/runtime/settings-http.ts`、`settings-assets.ts` |
| 配置变更顺序         | `src/runtime/settings-mutations.ts`                  |
| 浏览器安全协议       | `src/shared/protocol.ts`                             |
| 页面状态、草稿与拖动 | `src/ui/hooks/`                                      |

## 验证

```sh
bun install --frozen-lockfile
bun run ci
```

`ci` 包含格式、lint、类型检查、测试、发布契约、npm 打包检查、桌面端和网站构建。新增测试覆盖真实回环 TCP/WebSocket、真实本地 HTTP 与配置落盘，以及 jsdom 中的 React 交互。完整测试包含上游的 116 项和本分支新增的回归测试。

所有自动测试使用临时目录、测试图片与测试服务，不读取个人背景配置。普通模式的现有客户端仍需要重新启动才能获得 CDP 参数；这是启动机制限制，界面现在明确反馈该状态。

自动测试与构建不等同于真实系统登录、冷启动耗时或窗口视觉验收。本分支没有据此声称冷启动提速百分比。未嵌入官方 Release 标签的本地开发构建不会自动切换到上游发行版。

## 回滚

基线标签：`backup/pre-refactor-2026-10-19`。本次改造按提交分组，可逐步审阅、回退。

在新的工作目录恢复上游基线：

```sh
git clone https://github.com/wguanfengyue/codex-skin.git codex-skin-original
cd codex-skin-original
git switch --detach backup/pre-refactor-2026-10-19
bun install --frozen-lockfile
```

不必对有未提交改动的工作目录执行破坏性重置。回滚应用时，保留配置与个人图片；本次源码调整不要求更改 `config.json` 的版本号。
