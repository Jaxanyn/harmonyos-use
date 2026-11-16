# Codex 验收

本清单先检查环境，再按需执行只读、点击、构建或宿主画面验收。点击和构建会改变设备状态，须获得用户对本次操作的授权。

## 环境检查

在仓库目录确认 MCP 已注册：

```powershell
codex mcp get harmonyos-preview
```

确认项目和设备，运行前将工程路径替换为实际路径：

```powershell
.\scripts\install-codex.ps1 `
  -ProjectPath C:\path\to\my-harmonyos-project `
  -RequireDevice `
  -CheckOnly
```

`-CheckOnly` 只检查环境，不修改 Codex MCP 配置。请保持设备连接和解锁。

## 默认只读验收

替换工程路径和 `DEVICE_ID` 后运行：

```powershell
node scripts/check-codex.mjs `
  --project C:\path\to\my-harmonyos-project `
  --device DEVICE_ID
```

脚本检查工具、设备、控件树、预览地址和新截图，不安装、启动应用或点击设备。脚本会启动并结束预览会话；运行前请确认不会影响正在使用的预览。

成功时 JSON 中 `check` 为 `codex: ok`，默认 `actionVerified` 为 `false`。这只证明本次只读检查通过，不证明业务操作完成。命令行使用独立 MCP 进程，`connectionCheck.scope` 为 `isolated_process`，`hostConnectionVerified` 为 `false`；该结果不能证明当前 Codex 对话已重连。

要验证当前宿主连接，请在当前对话调用 `preview_info`，传入 `deviceId`，确认 `runtime.diagnosticsVersion` 为 `1`、`deviceCheck.status` 为 `connected`，再实际调用 `observe`、`find` 和 `wait_for`。`connected` 顶层字段只表示实时预览是否收到帧，不能代替设备自检。

## 点击后等待并截图

仅在用户授权本次点击后运行。先让设备停在目标页面，确认 `--wait-selector` 在点击前尚无匹配；脚本不会导航寻找入口。替换工程路径、`DEVICE_ID`、控件 ID 和文字：

```powershell
node scripts/check-codex.mjs `
  --project C:\path\to\my-harmonyos-project `
  --device DEVICE_ID `
  --tap-selector '{"id":"openDetails","clickable":true}' `
  --wait-selector '{"id":"detailsTitle","text":"详情"}'
```

必须同时提供 `--device`、`--tap-selector` 和 `--wait-selector`；选择器为 JSON 对象，条件按 AND 匹配。脚本最多点击一次，等待目标出现后重新截图；截图和控件匹配不单独证明业务操作成功。

`tap_element` 会重新查询目标，拒绝不唯一、不可点击、明确禁用或隐藏、坐标无效或采样过期的目标。缺少可见性字段时仍可能通过，且无法保证未被遮挡或界面未发生变化。WebView、自绘内容或未暴露的控件可能无法定位。

实际点击失败或超时时，动作可能已经生效；先检查设备和新证据，不要自动重试。预检拒绝不会发送点击。

## 包含构建的验收

仅在用户允许构建、安装和启动应用后运行。替换工程路径和 `DEVICE_ID`：

```powershell
node scripts/check-codex.mjs `
  --project C:\path\to\my-harmonyos-project `
  --device DEVICE_ID `
  --build
```

多模块工程可追加 `--module feature --artifact feature-signed.hap`。CI 不持有真实设备，不能代替真机上的构建安装、业务流程和断连恢复验收。

## Codex 画面验收

以下操作在 Codex 宿主中单独进行，不属于上面的命令行脚本：

1. 调用 `preview_start`，记录 `sessionId`，打开返回的 `previewUrl`，确认目标设备显示新画面。
2. 在当前对话调用 `observe`、`find` 和 `capture`，确认控件与 MCP 图片可用。
3. 用户已授权操作时，调用 `tap_element`，再用 `wait_for` 和新的 `capture` 检查结果。无法通过控件树定位时，先用新截图确认坐标 `tap` 的目标。
4. 调用 `preview_stop` 并传入记录的 `sessionId`，确认会话结束。

固定侧边栏由 Codex 宿主界面决定。预览画面或新截图本身不证明业务操作成功。

## 历史记录

此前的设备采样、测试结果和详细诊断保留在[历史验收记录](codex-acceptance-history.md)。错误码和恢复方法见[连接自检与错误证据](codex-usage-reference.md#连接自检与错误证据)。
