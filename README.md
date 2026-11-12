# harmonyos-use

[![CI](https://github.com/Jaxanyn/harmonyos-use/actions/workflows/ci.yml/badge.svg)](https://github.com/Jaxanyn/harmonyos-use/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

HarmonyOS Use 是面向 Codex 等 AI 编程 Agent 的 HarmonyOS 真机预览与交互 MCP 插件。它把设备发现、构建安装、控件树、截图、实时预览和受控操作放进同一条工作流。

项目原名为 harmonyos-preview。为兼容现有安装和配置，npm 包名、命令、MCP 注册名及环境变量暂时保留原名；预览面板仍显示为 HarmonyOS Preview。

## 为什么用它

- **看懂页面**：读取 UITest 控件树，按文字、ID、类型和状态查找目标。
- **验证改动**：构建、安装、启动应用，并用新截图和 `wait_for` 验证页面变化。
- **实时预览**：通过 MCP App 或本地 WebSocket 查看设备画面；重复帧不会进入模型上下文，点击后会等待动作产生的新帧。
- **安全操作**：优先按控件重新查询后点击；坐标操作可绑定 `frameId`/`seq`，旧帧、歧义目标、禁用控件和无效坐标会被拒绝，预览坐标会按帧尺寸安全映射到设备像素。
- **适配断连**：设备短暂离线时保留会话，恢复连接后继续预览。

## 快速开始

需要 Windows、Node.js 20+、DevEco Studio、HDC，以及已授权的 HarmonyOS 真机或已启动的模拟器。建议使用 Node.js 22：当前上游依赖 `@openai/mcp-extensions` 声明要求 Node.js 22+。Node.js 20 默认安装可能出现 `EBADENGINE` 警告；开启 npm `engine-strict` 时安装会失败。项目仍保留 Node.js 20 的现有声明，兼容性限制见[使用说明](docs/codex-usage.md)。

```powershell
hdc list targets
cd "C:\path\to\harmonyos-use"
.\scripts\install-codex.ps1 -ProjectPath C:\path\to\my-harmonyos-project
codex mcp get harmonyos-preview
```

HDC 不在 `PATH` 时，给安装脚本追加 `-HdcCommand "C:\path\to\hdc.exe"`；脚本会把检查过的完整路径写入 MCP 的 `HDC` 环境变量，路径中可以包含空格。

然后在 Codex 中发送：

```text
启动 C:\path\to\my-harmonyos-project，必要时先构建安装，然后打开实时预览。
```

## Agent 工作流

```text
list_devices
  → preview_info(deviceId)
  → build_run（需要重装时）
  → preview_start
  → preview_frame / capture
  → observe / find
  → tap_element / tap / swipe / input_text
  → wait_for
  → capture
  → preview_stop
```

`preview_panel` 可在当前对话右侧打开 MCP App，提供设备返回、主页、Fit、Zoom 和 Fullscreen；普通 `previewUrl` 仍可用于浏览器调试。

## MCP 能力

| 能力 | 工具 | 说明 |
| --- | --- | --- |
| 设备 | `list_devices`, `preview_info` | 发现设备并检查 HDC 连接状态 |
| 构建 | `build_run` | 构建、安装并启动应用 |
| 观察 | `observe`, `find`, `wait_for` | 读取控件树、定位目标、等待页面变化 |
| 截图 | `capture` | 每次重新采集设备画面，返回 `frameId` 和 `capturedAt` |
| 预览 | `preview_start`, `preview_frame`, `preview_stop` | 启动、取帧、恢复和停止实时预览，并返回采集来源、耗时和帧大小指标 |
| 操作 | `tap_element`, `tap`, `swipe`, `long_press`, `key_event`, `input_text` | 按控件或坐标操作设备；`tap_element` 可选 `verify` 自动确认点击后的控件状态 |

多模块工程可给 `build_run` 传入 `moduleName`；存在多个可部署 HAP 时传入 `artifactName`。未指定时只自动选择唯一的 `*-signed.hap`。

MCP 请求支持并发；同一 MCP 进程内，同一设备上的点击、输入、构建和启动按顺序执行。发送 `$/cancelRequest` 或 `notifications/cancelled` 可取消普通取帧、强制刷新等待、控件等待、截图和 HDC 子进程；取消不会撤销已发送的设备输入。

同一 MCP 进程内，多个 MCP App 面板可订阅同一设备；停止或关闭一个面板只释放它自己的订阅。当前进程同时只支持一个设备的预览，其他面板或公开调用仍持有会话时，面板切换到另一设备会被拒绝。面板约 60 秒没有续期时订阅失效；该会话约 5 秒不再读取帧时采集会暂停，动态画面也不会自行续租。无有效订阅及公开持有者时会话会停止。公开 `preview_stop` 不带订阅 ID 时仍表示停止整个会话。

取帧异常或动作结果未知时，面板可保留标记为旧帧的画面，并暂停交互；确认新帧后才恢复。结果未知时须先检查设备，再按需选择 `Retry frame` 手动取新帧，不会重发原设备操作。`preview_info` 顶层的 `previewRecoveryProtocol: 1` 和 `previewSubscriptionProtocol: 1` 分别表示当前 MCP 支持恢复与面板订阅协议；面板提示宿主过旧时，重新连接 MCP 并重新打开面板。

## 安全边界

- `tap_element` 只点击唯一、可点击、可见、坐标有效且未过期的控件，并且只执行一次。
- `capture` 不复用实时预览缓存；动作后应重新观察、等待并截图。
- WebView、自绘内容或未暴露的控件可能无法通过 UITest 定位。
- 构建、安装、启动和设备操作都会改变设备状态，应在 Agent 获得用户授权后执行。

## 配置

| 环境变量 | 用途 |
| --- | --- |
| `HARMONY_PROJECT` | MCP 模式下的 HarmonyOS 工程路径 |
| `HDC` | HDC 可执行文件路径，默认使用 `PATH` 中的 `hdc` |
| `HARMONY_PREVIEW_URL` | 复用已独立启动的预览服务 |
| `HARMONY_PREVIEW_AUTOSTART=1` | 预览服务不可用时自动拉起本机服务 |
| `HARMONY_PREVIEW_HDC_TIMEOUT_MS` | 单次 HDC 命令超时，默认 15000 毫秒 |
| `HARMONY_PREVIEW_ACTION_PREPARE_TIMEOUT_MS` | 点击前暂停预览采集的握手等待，默认 1000 毫秒，范围 5–5000；超时不执行点击 |
| `HARMONY_PREVIEW_SCALE` | JPEG 预览采样比例，默认 0.75，范围 0.25–1；首帧仍保留设备原始尺寸 |
| `HARMONY_PREVIEW_FAST_TAP` | 可选，仅对值精确匹配的 HDC 设备 ID 启用预览快速点击；未设置时使用标准点击 |
| `HARMONY_PREVIEW_FAST_SWIPE` | 实验性；仅对值精确匹配的 HDC 设备 ID 启用预览快速滑动，未设置时使用标准滑动 |

快速点击仅建议在已经实机验证 `uinput` 可用的设备上启用，并在 MCP 服务启动前设置对应设备 ID。能力探测不支持或失败时会在输入前使用标准点击；成功的面板点击会在 `preview_action` 结果中记录实际 `inputMethod`（`uinput` 或 `uitest`），不能仅凭配置判断实际路径。快速输入一旦发送，失败或结果不明时不会自动重发。命令返回和新帧均不代表业务操作成功。

快速滑动为实验路径，仅建议在指定设备上完成方向、距离和应用效果验证后启用。设备、屏幕方向、能力或时长条件不满足时在输入前使用标准滑动；输入发出后发生失败、超时或取消时结果未知，不自动重发或补发抬起。当前尚未验证设备断线或进程中止后的触摸释放，也不提供拖动过程实时跟手。实际输入方式可从 `preview_action` 结果的 `metrics.inputMethod` 确认。

完整配置、错误码和恢复流程见 [docs/codex-usage.md](docs/codex-usage.md)。

## 验证

本地回归：

```powershell
npm install
npm run check
npm pack --dry-run --registry=https://registry.npmjs.org/
```

点击性能基准：

```powershell
npm run benchmark:preview -- `
  --device DEVICE_ID `
  --warmup 1 `
  --actions 10 `
  --x 1 `
  --y 1
```

验证其他采样比例时，可在 PowerShell 先设置 `$env:HARMONY_PREVIEW_SCALE='0.4'`（默认值为 `0.75`）；设置为 `1` 使用设备原始尺寸，不能超过设备原始分辨率。基准 JSON 会回显实际 `scale`、帧尺寸和分段采集耗时；降低比例可减少采集与传输负担。

基准输出包含每次点击的 `actionRoundTripMs`、`actionMs`、`captureMs`、`frameWaitMs`、`frameAgeMs`，以及 `min/p50/p95/max/avg` 汇总。缩放 JPEG 的单命令采集使用 `combinedMs`；回退文件传输时使用 `snapshotMs`、`transferMs` 和 `readMs`。`frameAgeMs` 是帧送达 MCP 后的时间，不代表设备截图时间。基准使用独立 MCP 进程，不包含面板渲染，也不验证应用业务结果；`measurementScope` 会记录这些范围。运行前选择安全测试坐标，并关闭其他预览以减少采集竞争；脚本不会自动检查其他采集会话。

`warmup` 样本不计入汇总，用于减少首帧和 HDC 冷启动抖动的影响。分位数使用最近秩方法；少于 100 个动作样本时，报告会提示样本较少。示例中的 10 次适合快速排查，单次 p95 不能代表稳定尾延迟，应以更多样本的重复测量比较。

帧源能力可通过 `GET /api/capabilities` 查看。当前 HDC 适配器明确报告 `jpeg` 可用、`mjpeg`/`h264` 不可用；`FrameSource` 已支持可选的 `openFrameStream()` 适配器，设备具备长驻流能力时可直接使用 MJPEG 帧流，未提供该能力的设备继续使用 JPEG 回退。

默认只读真机验收：

```powershell
node scripts/check-codex.mjs `
  --project C:\path\to\my-harmonyos-project `
  --device DEVICE_ID
```

需要构建安装时追加 `--build`；多模块工程追加 `--module feature --artifact feature-signed.hap`。需要点击验收时，成对追加 `--tap-selector` 和 `--wait-selector`。

完整验收记录见 [docs/codex-acceptance.md](docs/codex-acceptance.md)。GitHub Actions 会在 push、Pull Request 和每天 UTC 01:00 运行 Node.js 20/22 回归检查；Node.js 22 使用 `engine-strict` 安装，Node.js 20 使用默认安装方式。真机流程仍需在授权设备上执行。

## 文档

- [使用说明](docs/codex-usage.md)
- [真机验收清单](docs/codex-acceptance.md)
- [Codex 工作流技能](skills/harmonyos-preview-codex/SKILL.md)
