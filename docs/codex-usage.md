# Codex 使用说明

HarmonyOS Use 原名 harmonyos-preview。为兼容已有配置，MCP 注册名、命令及环境变量仍使用原名；预览面板名称仍为 HarmonyOS Preview。

## 安装 MCP

建议使用 Node.js 22 安装并运行插件。项目目前声明 Node.js 20+，但上游依赖 `@openai/mcp-extensions@0.1.0` 声明 Node.js 22+；使用 Node.js 20 时，npm 默认安装可能提示 `EBADENGINE`，开启 `engine-strict` 时会因该依赖拒绝安装。可先检查当前版本和严格检查配置：

```powershell
node --version
npm config get engine-strict
```

如果当前 `node` 是 20，切换到 Node.js 22 后重新执行 `npm ci`；如需确保安装脚本注册的是指定的 Node.js 22，可在原命令中追加 `-NodeCommand "C:\path\to\node22\node.exe"`。将路径替换为本机可执行文件的实际路径。已有同名 MCP 配置时，脚本默认保留原配置；如需替换，追加 `-Force`，然后重新连接 Codex。

隔离验证中，Node.js 20.20.2 默认安装出现上述警告，但打包后的 MCP 初始化、工具列表和资源元数据契约通过；严格安装失败。Node.js 22.23.4 的严格安装和相同打包契约通过。这只说明本次环境和这些检查的结果，不代表 Node.js 20 获得上游支持或所有设备场景均已验证。

推荐先使用安装脚本：

```powershell
.\scripts\install-codex.ps1 -ProjectPath C:\path\to\my-harmonyos-project
```

脚本会检查 Node.js、HDC 和设备，并注册 `harmonyos-preview`。没有连接设备时只给出警告；需要严格要求设备时加上 `-RequireDevice`。已有同名配置不会覆盖，确认替换时使用 `-Force`。

HDC 不在 `PATH` 时，明确指定可执行文件：

```powershell
.\scripts\install-codex.ps1 `
  -ProjectPath C:\path\to\my-harmonyos-project `
  -HdcCommand "C:\Program Files\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe"
```

将示例路径替换为本机实际位置。脚本解析并检查该文件后，会把完整路径作为 `HDC` 环境变量注册到 MCP；即使使用 `-SkipDeviceCheck`，显式指定的 HDC 路径仍会传入。手工执行 `codex mcp add` 时，可用 `--env "HDC=C:\path\to\hdc.exe"` 指定相同路径。

在 PowerShell 中注册本地插件：

```powershell
codex mcp add harmonyos-preview `
  --env HARMONY_PROJECT=C:\path\to\my-harmonyos-project `
  -- node "C:\path\to\harmonyos-use\bin\harmonyos-preview.mjs" --mcp
```

将示例中的仓库目录替换为实际路径；已有目录无需改名。

如需让预览服务独立于 MCP 进程运行，先启动：

```powershell
node bin/harmonyos-preview.mjs --project C:\path\to\my-harmonyos-project
```

再在 MCP 注册命令中增加：

```text
--env HARMONY_PREVIEW_URL=http://127.0.0.1:4100
```

需要 MCP 在服务不可用时自动拉起本机预览服务时，再增加 `--env HARMONY_PREVIEW_AUTOSTART=1`。安装脚本也支持 `-AutoStartPreview`。

注册后重启 Codex 或刷新 MCP 工具列表。插件进程只监听本机地址，预览服务的端口由 MCP 进程自动分配。

升级后新增的 `tap_element` 需要宿主重新连接 MCP 才能加载。已有只读验收通过时，使用新工具前确认它已出现在工具列表即可，无需重复此前已经完成的只读验收。

## 固定到 Codex 侧边栏

当前 MCP 服务提供 `preview_open` Global Entrypoint 和 `ui://harmonyos-preview/app` MCP App 资源。完成注册后：

1. 刷新 MCP 工具列表或重启 Codex Desktop。
2. 在侧边栏的“···”菜单中找到 HarmonyOS Preview。
3. 选择“固定到侧边栏”。
4. 打开面板，选择设备并启动预览；`preview_start` 会开始采集并等待首帧。

侧边栏面板通过 MCP App Bridge 调用设备工具，普通 `previewUrl` 页面仍可用于浏览器调试。固定动作由 Codex 用户界面执行，MCP 服务不能替用户强制固定。

## 标准使用流程

### 在当前对话右侧显示

`preview_panel` 提供 Thread Entrypoint，标题为“鸿蒙真机预览”。重启 Codex 后，可以从当前对话的面板入口打开这个标签。也可以让 Agent 调用 `preview_panel`；具体首次展示位置由宿主决定。若工具结果先显示在聊天中，通过宿主的展开操作打开面板。

打开后保持该标签即可在当前对话旁使用；入口本身不保证切换对话或重启后继续显示，也不能强制宿主固定。左侧的 `preview_open` Global Entrypoint 仍用于全局导航。

提示词：`在当前对话右侧打开鸿蒙真机预览，调用 preview_panel。`

### 设备操作

1. 让 Agent 调用 `list_devices`，确认 HDC 已发现鸿蒙真机或模拟器。
2. 需要重新安装应用时，让 Agent 调用 `build_run`。默认选择 `entry` 模块；多模块工程可传入 `moduleName`，当该模块生成多个可部署 HAP 时同时传入 `artifactName`，例如 `{"deviceId":"设备 ID","moduleName":"feature","artifactName":"feature-signed.hap"}`。未显式选择时，插件只会自动选择唯一的 `*-signed.hap`；多个签名产物仍返回构建产物歧义错误并停止安装。
3. 调用 `preview_start`，记录返回的 `sessionId` 和 `previewUrl`。
4. 使用 Codex 宿主的浏览器面板动作打开 `previewUrl`，位置设为 `right`；MCP App 通过 `preview_frame(afterSeq)` 获取实时画面，重复帧不会再次渲染。
5. Agent 使用 `observe` / `find` 读取页面和定位目标；用户已授权点击时优先用 `tap_element` 重新检查并点击目标。右侧面板自身的点击和拖动使用 App-only `preview_action`，模型仍使用 `tap` / `swipe` / `tap_element`。
6. MCP App 约 5 秒没有请求新帧时，该会话的 HDC 采集会自动暂停；动态画面产生新帧也不会延长该消费租约。重新请求 `preview_frame` 会在原 `sessionId` 上恢复。独立浏览器的 WebSocket 预览不使用这项 MCP App 租约。
7. 完成后调用 `preview_stop`，并传入原来的 `sessionId`。

MCP App 面板自行申请独立订阅：同一 MCP 进程内多个面板可以共享同一设备的采集会话，停止或关闭一个面板只释放自己的订阅。此进程当前同时只维护一个设备会话；若其他面板订阅或公开调用仍持有现有设备，面板启动另一设备时会返回 `PREVIEW_IN_USE`，需要先释放现有会话。约 60 秒没有读帧或动作续期的面板订阅会失效；订阅已失效时重新启动预览。该订阅租约与上面的约 5 秒无读帧暂停采集是两个不同机制。不同 MCP 进程和独立 WebSocket 浏览器不共享这些订阅。

程序直接调用时，`preview_start({"deviceId":"设备 ID","subscriber":true})` 返回面板专属 `subscriberId`；该面板后续 `preview_frame`、`preview_action` 与释放用的 `preview_stop` 须同时传自己的 `sessionId` 和 `subscriberId`。普通 `preview_start` 不申请面板订阅；公开 `preview_stop` 不带 `subscriberId` 时仍按原有语义停止整个会话。令牌过期、已释放或不属于当前会话时请求被拒绝，旧令牌不能释放新会话。

MCP 请求可以并发处理；同一 MCP 进程内，同一设备上的点击、输入、构建和启动会按到达顺序排队，读取和等待请求可以继续返回。客户端取消长时间请求时发送 `$/cancelRequest`（`params.requestId`）或 `notifications/cancelled`，服务会中止普通取帧、强制刷新等待、控件等待、截图和当前 HDC 子进程，并返回 JSON-RPC `-32800`。普通取帧取消时会清理等待器、定时器和取消监听器。连接关闭也会取消未完成请求；设备临时文件仍会执行有界清理。取消不能撤销已经发送的设备输入，不能据此自动重发动作。

使用独立预览服务时，MCP 会把会话写入 `.runtime/preview-session.json`。新建 Codex 页面后先调用 `preview_info`；如果返回 `restored: true`，直接使用其中的 `previewUrl`，通过 Codex 宿主浏览器面板动作以 `right` 位置恢复页面。

推荐提示词：

```text
启动 HarmonyOS 项目，打开鸿蒙真机实时预览，点击主操作按钮并确认画面变化。
```

## 返回结果

`preview_start` 返回：

- `sessionId`：当前预览会话编号
- `deviceId`：设备 ID
- `previewUrl`：浏览器预览页面
- `wsUrl`：WebSocket 地址
- `connected`：是否已收到设备截图
- `restored`：是否从独立预览服务的状态文件恢复
- `pollMs`：截图轮询间隔
- `previewRecoveryProtocol`：MCP 强制刷新恢复协议版本，当前为 `1`
- `previewSubscriptionProtocol`：面板订阅协议版本，当前为 `1`
- `subscriberId`：仅请求 `subscriber: true` 时返回，用于该面板续期和释放

`preview_frame` 是 MCP App 专用的实时帧接口，参数 `afterSeq` 用于去重，动作后的读取可传 `waitMs` 等待下一个新帧。结构化结果中的 `metrics` 提供 `source`、`captureMs`、`captureStages`、`frameBytes`、`capturedAt`、`width`、`height`、`deviceWidth` 和 `deviceHeight`。缩放后的 JPEG 优先通过一次 HDC 命令采集和传输，`captureStages.combinedMs` 表示两者合计耗时；设备不支持或响应未通过标记与 JPEG 基本结构检查时回退到文件传输，返回 `snapshotMs`、`transferMs` 和 `readMs`。基本结构检查不能保证图片一定能完整解码。面板还会显示本地 `renderMs`；`preview_action` 返回 `actionMs`、`frameSeq` 和 `nextFrameAfterSeq`，用于判断点击响应瓶颈并跳过动作前帧。它返回 `content: []`，图片只放在结构化结果中，不进入模型上下文。`capture` 仍然每次重新采集设备画面，适合模型在动作后取得独立证据。

预览区使用面板剩余空间，画面按设备比例完整显示；`Fit` 恢复自适应尺寸，放大后可以滚动画面。工具栏提供设备“返回”和“主页”，操作会等待动作后的新帧；新帧本身不证明业务操作成功。点击仅作用于图片，四周留白不发送设备输入；手势期间画面位置或尺寸变化时，该手势会取消，避免误点。

取帧或解码失败、动作在输入前因帧过期被拒绝，或动作已经发送但结果未知时，面板可保留旧画面并显示 `Old frame — interaction unavailable`。此时点击、滑动、设备返回与主页及构建操作不可用；恢复请求绑定当前设备、会话和序号，只有确认请求后的新帧并完成解码才恢复交互。动作结果未知时先检查设备，再按需点击 `Retry frame` 手动取新帧；不会自动重发原动作。其他刷新失败后也可选择 `Retry frame` 或停止后重新启动预览。明确断连、切换设备或会话变化时仍会清除旧画面；刷新成功不代表原动作业务成功。

坐标工具 `tap`、`swipe`、`long_press` 和带坐标的 `input_text` 可携带 `frameId`、`seq` 与 `coordinateSpace`。将 `coordinateSpace` 设为 `frame` 时，工具会按该帧的 `width`/`height` 与 `deviceWidth`/`deviceHeight` 映射到 HDC 坐标；帧身份或序号不匹配、预览未连接、缺少尺寸或检测到屏幕方向变化时会拒绝本次输入。方向失效后停止并重新启动预览会重新校准设备尺寸。MCP App 的 `preview_action` 也会校验可选 `frameId` 与 `seq`。未传绑定字段时继续按原有 device 坐标兼容处理；HTTP `/api/tap` 保持无状态，只接受 device 坐标。

面板动作开始时会中止正在进行的预览 JPEG 采集，并等待预览服务确认暂停；确认失败时不执行动作。HDC 输入结束后才恢复采集，面板通过 `nextFrameAfterSeq` 等待后续帧。预览首帧保留设备原始尺寸并用于推导设备尺寸，后续 JPEG 按 `HARMONY_PREVIEW_SCALE` 采样（默认 `0.75`，范围 `0.25–1`）；设为 `1` 使用原始分辨率，设为 `0.4` 可减少采集与传输负担。显示细节不超过设备原始画面，面板坐标会映射回设备原始像素。

成功的预览点击在 `preview_action` 结果的 `metrics.inputMethod` 中报告实际输入路径：`uinput` 为快速输入，`uitest` 为标准点击。预览面板底部的指标和操作诊断已隐藏；面板仍在内部维护本次会话的统计及最近 10 条取消原因，停止或切换会话时清空。收到新帧不证明业务操作成功，需观察应用画面确认。`fastTapConfiguredForDevice` 只表示配置匹配，不证明实际使用了快速路径；失败或结果未知时也不应猜测输入是否生效。

模型调用 `tap`、`tap_element`、`swipe`、`long_press`、`key_event` 或 `input_text` 成功后，也会立即刷新正在运行的实时预览，减少等待下一轮轮询的时间。

可用 `npm run benchmark:preview -- --device <设备 ID> --warmup 1 --actions 10` 重复执行真机预览点击基准；基准 JSON 会输出实际 `scale`、每次动作的 `actionRoundTripMs`、`actionMs`、`actionPrepareMs`、`actionInputMs`、`captureMs`、`frameWaitMs`、`frameAgeMs`、分段采集耗时（合并路径为 `combinedMs`，文件回退路径为 `snapshotMs`、`transferMs`、`readMs`）、帧大小和分辨率，以及 `min/p50/p95/max/avg` 汇总。`--warmup` 样本不计入汇总，用于减少首帧和 HDC 冷启动抖动的影响；`--x`、`--y` 可指定测试坐标，默认使用 `1,1`；运行前需确认该坐标可安全重复点击。`--max-action-p95` 检查 `actionRoundTripMs` 的 p95，`--max-capture-p95` 检查采集耗时 p95，超过阈值时以非零状态退出。

`measurementScope` 明确基准使用独立 MCP 进程、测量点击到动作后帧的链路，不包括面板渲染，也不验证业务结果。脚本不检查其他采集会话（`otherCaptureSessions: "not_checked"`）；比较前应关闭其他预览，保持相同设备、页面和采样比例。分位数采用最近秩方法（`nearest_rank`）；少于 100 个动作样本时，报告会提示样本较少。10 次适合快速排查，即使阈值通过，也不能据单次 p95 宣称稳定尾延迟达标；应以更多样本的重复测量比较。

采集分段中，`combinedMs` 为合并采集及传输；`snapshotMs`、`transferMs` 和 `readMs` 表示文件采集路径，无法仅凭这些值确定是否发生回退。如果合并尝试失败后回退，文件各分段不包含失败尝试及清理耗时，不能把它们相加作为完整截图耗时。

也可分别测量滑动：`npm run benchmark:preview -- --device <设备 ID> --action swipe --x <起点 X> --y <起点 Y> --to-x <终点 X> --to-y <终点 Y> --warmup 1 --actions 10`。滑动必须显式提供不同的起止坐标，四舍五入到设备像素后两点仍须不同；这些值使用设备坐标。脚本会重复执行预热及采样动作，运行前应确认页面和整段手势均适合重复操作。`measurementScope.action` 标明本次是 `tap` 还是 `swipe`，每次样本的 `inputMethod` 在设备报告时展示实际路径，否则为 `null`。应观察并人工确认每次业务变化；收到新帧不代表动作生效。此独立基准不包含面板操作前校验、解码和绘制，不能当作完整面板体验耗时。`frameWaitMs` 是客户端总耗时减去服务端动作耗时，包含 RPC 和解析等额外开销，不是纯截图等待时间。

`frameAgeMs` 表示帧送达 MCP 后经过的时间，不能证明截图发生在动作之后。JPEG 预览通过暂停确认和动作结束后的采集顺序保证这一点；页面的异步更新仍需单独观察。

### 连接自检与错误证据

调用 `preview_info` 可读取 `runtime`：`serverVersion`、`diagnosticsVersion`（当前为 `1`）、`startedAt` 和 `instanceId`。`instanceId` 在同一次 MCP 服务启动期间保持不变，重启后更换；它标识当前调用连到的 MCP 实例，不代表外部 HTTP 预览服务或宿主缓存已更新。

`preview_info` 顶层另提供 `previewRecoveryProtocol: 1` 和 `previewSubscriptionProtocol: 1`，`preview_start` 也返回这两个字段。面板需要订阅协议才能启动，并仅在恢复协议值为 `1` 时启用强制刷新恢复；缺失或不兼容时会提示宿主过旧，不会把普通缓存取帧当作恢复成功。此时应更新插件、重新连接 MCP（必要时重启 Codex），再重新打开面板确认协议字段。使用 `HARMONY_PREVIEW_URL` 连接独立服务时，也需同步更新该服务；MCP 的协议字段不能单独证明外部服务已更新，未取得确认新帧时仍保持交互禁用。

不传 `deviceId` 时，`deviceCheck.status` 为 `not_checked`，不主动探测设备。传入 `{"deviceId":"目标设备"}` 后，只读查询 HDC 目标列表，返回 `connected`、`disconnected` 或 `error`。自检失败记录在 `deviceCheck` 内；读取 `preview_info` 本身成功也应继续检查该状态和错误码。原有 `connected` 字段仍表示实时预览是否已收到设备帧，不能替代 `deviceCheck`；没有启动预览时，设备在线也可能返回 `connected: false`。

独立预览服务检查或恢复失败时，`preview_info` 仍保留 `runtime` 与设备自检结果，另用 `serviceDiagnostic` 记录服务错误；验收脚本保留该具体错误，不改写成 `MCP_OUTDATED`。

工具执行失败保留 MCP `isError: true` 与 `error` 文本，结构化结果统一包含 `errorCode`、`stage`、`deviceId`、`elapsedMs` 和 `cause`。设备未知时 `deviceId` 为 `null`；`stage` 指明失败环节，`cause` 保留原始消息及可用的系统错误码或退出码。按错误码判断下一步，不依赖错误文案匹配：

| 环节 | 错误码与含义 |
| --- | --- |
| 设备与 HDC | `DEVICE_OFFLINE` 仅在目标列表确认设备不在线时使用；`HDC_UNAVAILABLE` 表示无法调用 HDC，`HDC_TIMEOUT` 表示命令超时 |
| 页面读取与等待 | `LAYOUT_UNAVAILABLE` 表示控件树不可读；`WAIT_TIMEOUT` 表示等待条件未在期限内满足 |
| 截图 | `CAPTURE_FAILED` 表示截图采集失败 |
| 会话与操作 | `STATE_WRITE_FAILED` 表示会话状态写入失败；`ACTION_FAILED`、`BUILD_FAILED` 分别表示设备动作与构建链路失败 |
| 帧绑定 | `STALE_PREVIEW_FRAME` 表示 `frameId`/`seq` 已过期；`FRAME_BINDING_REQUIRED` 表示 frame 坐标缺少绑定；`FRAME_TRANSFORM_UNAVAILABLE` 表示缺少可用尺寸或存在不支持的旋转；`FRAME_COORDINATE_OUT_OF_BOUNDS` 或 `DEVICE_COORDINATE_OUT_OF_BOUNDS` 在 `action_frame` 阶段表示坐标超出可校准画面，输入未发送。设备坐标仅在绑定当前帧、设备尺寸有效且未发生方向变更或旋转时检查上限 |
| 验收能力 | `MCP_OUTDATED` 表示缺少所需工具或当前诊断契约，不能据此判断设备故障 |

读取或等待失败后的截图只是辅助证据，不替换主错误。成功补图保留 `screenshot` 中的 `frameId`、`capturedAt` 等新截图元数据；补图失败保留 `screenshotError`，并增加 `screenshotDiagnostic`。例如 `wait_for` 的主错误仍可为 `WAIT_TIMEOUT`，同时 `screenshotDiagnostic.errorCode` 为 `CAPTURE_FAILED`。先检查现有证据，再决定下一步；不会因诊断结果自动重复点击或输入。

HTTP 设备请求失败和 WebSocket `error` 消息也保留上述诊断字段；轮询失败的 `preview-status` 通过 `diagnostic` 附带原因。只有已确认的 `DEVICE_OFFLINE` 使用 `reason: "device-disconnected"`，其他截图异常使用 `capture-failed`，不能仅凭截图失败断定设备离线。

`capture` 每次都重新采集设备画面，不返回实时预览的缓存。调用应在动作完成后进行；页面异步加载或动画仍可能尚未完成，需根据新画面继续判断。

`capture` 返回 MCP 图片，同时返回结构化元数据：

```json
{
  "deviceId": "设备 ID",
  "live": false,
  "sessionId": null,
  "frameId": "本次采集编号",
  "capturedAt": "2026-10-26T00:00:00.000Z"
}
```

### 页面读取和目标查询

`observe` 参数为 `deviceId`、可选 `bundleName` 和 `maxNodes`（默认 200，上限 1000）。它通过 `uitest dumpLayout` 读取当前控件树，返回 `nodes`、`totalNodes`、`truncated` 和 `observedAt`。节点包含可用的文字、ID、类型、状态、边界和中心坐标。

`find` 参数为 `deviceId`、`selector`、可选 `bundleName` 和 `limit`（默认 20，上限 100）。`selector` 至少包含一个条件：`text`、`textContains`、`id`、`type`、`clickable` 或 `enabled`。条件按 AND 匹配；除 `textContains` 外均精确匹配。结果中的 `matches` 是候选节点数组，`totalMatches` 是匹配总数，`truncated` 表示候选列表被限制。

例如先调用 `find`，参数为 `{"deviceId":"目标设备","selector":{"text":"搜索","clickable":true}}`，查看候选是否属于当前目标。`find` 不自动点击；用户已授权点击时，将选择器交给 `tap_element`，由它重新查询当前页面并检查目标。重名控件不会被自动选中。

空树、截断的 `observe` 和没有匹配的 `find` 会附带新截图；布局读取失败也会尝试附图，并保留 `isError: true` 与主错误诊断。`observe` 还返回 `treeQuality`（`full`、`partial` 或 `empty`）、`fallback`（`none` 或 `screenshot`）和 `customRendered`；其中 `customRendered: true` 表示截图中可能存在 UITest 未暴露的自绘或受保护内容。若截图也失败，结构化结果包含 `screenshotError` 和 `screenshotDiagnostic`。控件树只反映 UITest 暴露的内容，WebView、自绘或受保护内容可能缺失；空结果、节点数量及截断标记不能证明业务页面或列表完整。基础定位不提供跨页面稳定的元素句柄；导航、滚动或旋转后重新读取。

### 按控件点击

`tap_element` 必填 `deviceId` 和 `selector`，可选 `bundleName` 与 `verify`。选择器与 `find` 一致，所有条件按 AND 匹配。例如用户已授权点击提交按钮时，调用：`{"deviceId":"目标设备","selector":{"id":"submit","clickable":true,"enabled":true}}`。需要自动确认点击结果时，增加 `verify`：`{"selector":{"text":"提交成功"},"state":"present","timeoutMs":5000}`；`state` 默认 `present`，也可用 `absent`。

工具内部重新读取控件树，以 `limit: 2` 返回候选，但用全树的匹配总数判断是否唯一；只有唯一匹配、`clickable: true`、未明确禁用或隐藏、`bounds` 与 `center` 有效，且 `observedAt` 距点击检查为 0–1000 毫秒时，才发送一次点击。不会复用上次 `find` 的坐标，也不会自动重试。

预检拒绝分别返回 `ELEMENT_NOT_FOUND`（没有匹配）、`ELEMENT_AMBIGUOUS`（多个匹配）、`ELEMENT_NOT_ACTIONABLE`（不可点击或几何无效）、`STALE_OBSERVATION`（采样无效或过期），不发出点击；布局读取或 HDC 失败保留原错误码。MCP 会尝试补充新截图，补图错误另记。若实际点击命令失败或超时，动作可能已经生效，应先重新观察，不能自动再点一次。

未传 `verify` 时返回 `deviceId`、`selector`、`observedAt`、`target`、`action: "tap"` 和 `verified: false`，只确认点击命令执行完成。传入 `verify` 后，工具会在同一设备锁内等待指定控件状态，并返回 `verification`（包含 `status`、`attempts`、`elapsedMs` 和末次观察）；只有 `verification.status: "matched"` 时 `verified` 才为 `true`，超时仍返回点击结果但 `verified: false`。控件树读取与点击之间页面仍可能变化，此工具不能原子消除 UI 竞态，也不解决 UITest 未暴露的自绘内容；原有 `tap` 仍用于用户已授权、以新截图判断的坐标点击。

地图页可将自绘标记桥接为透明 ArkUI `Button`，因此 `find`/`tap_element` 能按稳定 ID 命中标记：单点使用 `map-stop-<stopId>`，聚合点使用 `map-cluster-<stopId>-...`。进入地图后先用 `find` 确认唯一节点，再把同一 ID 与 `type: "Button"`、`clickable: true`、`enabled: true` 交给 `tap_element`；地图缩放或切换行程后重新读取，避免复用旧坐标。

### 等待页面变化

`wait_for` 读取当前控件树并等待条件满足，不会自动点击。必填参数为 `deviceId` 和 `selector`；可选 `bundleName`。`selector` 复用 `find` 的 AND 条件。`state` 为 `present`（默认）或 `absent`；`timeoutMs` 为 1–30000 的整数，默认 5000；`intervalMs` 为 100–5000 的整数，默认 500，单位均为毫秒。

例如提交后等待文字更新：

1. 用户已授权点击时，调用 `tap_element`；可直接传 `verify` 自动等待结果：`{"deviceId":"目标设备","selector":{"id":"submit","clickable":true,"enabled":true},"verify":{"selector":{"id":"status","text":"完成"},"state":"present","timeoutMs":5000}}`。
2. 若未传 `verify`，点击成功后调用 `wait_for`：`{"deviceId":"目标设备","selector":{"id":"status","text":"完成"},"state":"present","timeoutMs":5000}`。
3. 调用 `capture`，查看动作后的新画面。

等待加载控件消失：`{"deviceId":"目标设备","selector":{"id":"loading"},"state":"absent"}`。内部检查全树，返回的节点数量限制不会影响匹配；空树不能满足 `absent`。`absent` 只证明当前非空、可读的控件树中没有匹配项，既不证明该控件曾经出现，也不能保证自绘内容或业务流程完成。文字变化应使用同一控件 ID 加预期 `text` 等待 `present`，不要用旧文字消失代替结果确认。

结果包含 `status`（`matched`、`timeout` 或 `observation_failed`）、`attempts`、`elapsedMs`、`lastObservation` 和 `warnings`；失败时附带 `error`。`lastObservation` 最多保留 200 个节点和 20 个匹配候选，同时给出总数与截断标记。`elapsedMs` 包括等待阶段的 HDC 清理时间，不包括失败后的截图时间。

超时或读取失败返回 MCP `isError: true`，同时尝试采集新截图，绝不使用预览缓存。补图采集预算为 3 秒，每次 HDC 清理最多 2 秒；等待末次检查和补图各可能清理一次，因此超过等待期限后仍可能额外耗时约 7 秒。补图失败保留 `screenshotError` 与独立的 `screenshotDiagnostic`。遇到 `timeout` 或 `observation_failed` 时，检查主错误、补图诊断与截图后再决定下一步，不把等待失败视为业务失败或自动重复点击。

预览页面按解码后的图片实际尺寸映射坐标。切设备、断线、停止及捕获失败后，旧画面不再用于操作；取得所选设备的新帧后才能交互。

## 常见问题

- 没有设备：检查 DevEco Studio、HDC 路径和设备授权状态。
- `connected: false`：表示预览未收到设备帧；用 `preview_info({"deviceId":"目标设备"})` 检查 HDC 连接，不使用旧截图坐标。
- 预览页面无法打开：确认 MCP 进程仍在运行，并使用最新的 `previewUrl`；不要手动拼接设备参数。
- 只想截图：可以直接调用 `capture`，不必启动实时预览。

`SKILL.md` 是 Codex 工作流提示文件；真正注册设备工具的是 MCP 命令。`preview_open` 负责侧边栏 Global Entrypoint，`previewUrl` 仍是独立浏览器预览入口。
