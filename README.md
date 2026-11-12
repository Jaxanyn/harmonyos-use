# harmonyos-use

HarmonyOS Use 是面向 Codex 等 AI 编程 Agent 的 HarmonyOS 真机与模拟器实时预览插件。通过 MCP 完成构建、安装、截图和触控操作。

项目原名为 harmonyos-preview。为兼容现有安装和配置，npm 包名、命令、MCP 注册名及环境变量暂时保留原名。

[![CI](https://github.com/Jaxanyn/harmonyos-use/actions/workflows/ci.yml/badge.svg)](https://github.com/Jaxanyn/harmonyos-use/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

## 能力

- 发现设备，构建、安装并启动 HarmonyOS 应用。
- 返回 MCP 截图，提供本地 WebSocket 实时预览。
- 支持点击、滑动、长按、按键和文本输入。
- 设备短暂离线后自动恢复轮询。

## 前置条件

- Windows、Node.js 20+、DevEco Studio 和 HDC。
- HDC 可通过 `PATH` 或 `HDC` 环境变量调用。
- 已授权的 HarmonyOS 真机或已启动的模拟器。
- 可独立构建的 HarmonyOS 工程，提供 `build-local.ps1` 或 `devecocli`。

```powershell
hdc list targets
```

## 在 Codex 中安装

从仓库目录执行：

```powershell
cd "C:\path\to\harmonyos-use"
.\scripts\install-codex.ps1 -ProjectPath C:\path\to\my-harmonyos-project
codex mcp get harmonyos-preview
```

没有设备时脚本只警告；严格要求设备加 `-RequireDevice`，覆盖已有配置加 `-Force`。

## 快速开始

在 Codex 中发送：

```text
启动 C:\path\to\my-harmonyos-project，必要时先构建安装，然后打开实时预览。
```

Agent 的基本流程：

```text
list_devices → build_run（可选）→ preview_start → 打开 previewUrl
→ capture / tap / swipe / input_text → preview_stop
```

`preview_start` 返回的 `previewUrl` 可直接在 Codex 浏览器或面板中打开；页面会自动连接设备并显示实时画面。

## MCP 工具

| 工具 | 作用 |
| --- | --- |
| `list_devices` | 列出设备 |
| `build_run` | 构建、安装并启动应用 |
| `preview_start` | 启动预览会话 |
| `preview_info` | 查询会话状态 |
| `capture` | 返回 MCP 图片 |
| `tap` / `swipe` / `long_press` | 触控操作 |
| `key_event` | 发送返回、主页或电源键 |
| `input_text` | 输入文本 |
| `preview_stop` | 停止预览会话 |

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HARMONY_PROJECT` | 无 | MCP 模式下的工程路径 |
| `HDC` | `hdc` | HDC 可执行文件 |
| `HARMONY_PREVIEW_HDC_TIMEOUT_MS` | `15000` | 单次 HDC 命令超时，单位毫秒 |
| `HARMONY_PREVIEW_URL` | 无 | 连接已独立运行的预览服务 |
| `HARMONY_PREVIEW_STATE` | `.runtime/preview-session.json` | 预览会话恢复状态文件 |
| `HARMONY_PREVIEW_AUTOSTART` | `0` | 外部服务不可用时自动拉起本机预览服务 |
| `HARMONY_PREVIEW_PORT` | `4100` | 预览服务端口 |
| `HARMONY_PREVIEW_POLL_MS` | `500` | 截图轮询间隔，最小 100 毫秒 |
| `HARMONY_PREVIEW_BACKOFF_MAX_MS` | `10000` | 设备断线时截图轮询的最大退避间隔，单位毫秒 |
| `HARMONY_PREVIEW_BUILD_TIMEOUT_MS` | `300000` | 构建超时，单位毫秒 |

独立启动预览服务：

```powershell
node bin/harmonyos-preview.mjs --project C:\path\to\my-harmonyos-project
```

打开 `http://127.0.0.1:4100/?deviceId=DEVICE_ID`。

需要让 MCP 复用该服务时，在注册 MCP 时增加 `HARMONY_PREVIEW_URL=http://127.0.0.1:4100`。
需要在服务崩溃后自动恢复时，再增加 `HARMONY_PREVIEW_AUTOSTART=1`。

## 真机验收

不构建时验证设备、截图和会话：

```powershell
node scripts/check-codex.mjs `
  --project C:\path\to\my-harmonyos-project `
  --device DEVICE_ID
```

需要验证构建、安装和启动时追加 `--build`。完整清单见 [docs/codex-acceptance.md](docs/codex-acceptance.md)。

## 故障排查

- `hdc list targets` 无设备：检查 USB 调试、授权和模拟器状态。
- `connected: false`：等待设备重连后重新 `capture`。
- 构建失败：确认工程路径、构建脚本和 HAP 输出路径。

## 开发

```powershell
npm install
npm run check
npm pack --dry-run --registry=https://registry.npmjs.org/
```

工作流说明见 [docs/codex-usage.md](docs/codex-usage.md)。当前版本通过本地 URL 提供预览，暂不包含 Codex 固定原生侧边栏。
