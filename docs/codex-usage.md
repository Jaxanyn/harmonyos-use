# Codex 使用说明

harmonyos-use 的 MCP 注册名为 `harmonyos-preview`，预览面板名称为 harmonyos-use。

## 安装 MCP

需要 Windows、Codex CLI、Node.js 20+、DevEco Studio、HDC、已存在的 HarmonyOS 工程，以及已授权的真机或已启动的模拟器。

建议使用 Node.js 22：上游依赖 `@openai/mcp-extensions@0.1.0` 声明要求 Node.js 22+。Node.js 20 默认安装可能提示 `EBADENGINE`，启用 npm `engine-strict` 时安装会失败。

在仓库根目录运行以下命令，将工程路径替换为实际目录：

```powershell
npm ci
.\scripts\install-codex.ps1 -ProjectPath C:\path\to\my-harmonyos-project
codex mcp get harmonyos-preview
```

HDC 不在 `PATH` 时，可先用 `& "C:\path\to\hdc.exe" list targets` 检查设备，并在安装脚本中追加 `-HdcCommand "C:\path\to\hdc.exe"`；将示例路径替换为实际路径。

已有同名 MCP 配置默认不覆盖；确认需要替换时追加 `-Force`。注册后刷新 MCP 工具列表或重启 Codex。`codex mcp get` 只确认注册信息。

## 固定到 Codex 侧边栏

在支持该功能的宿主中，固定动作由用户通过 Codex 界面执行；MCP 服务不能强制固定。具体步骤见[完整参考](codex-usage-reference.md#固定到-codex-侧边栏)。

## 标准使用流程

1. 让 Agent 调用 `list_devices`，确认 HDC 已发现设备；如需检查连接，可对目标设备调用 `preview_info` 并查看 `deviceCheck.status`。
2. 让 Agent 调用 `preview_panel` 打开面板；首次显示位置由宿主决定。如果面板出现在聊天中，先展开面板，再选择设备并点击 `Start`。
3. 确认设备在列表中、面板显示正在运行且画面能更新。浏览器预览可使用 `preview_start` 返回的 `previewUrl`。
4. 读取页面时使用 `observe` 或 `find`。设备操作需用户授权；控件点击优先使用 `tap_element`，再用 `wait_for` 和新截图检查预期结果。WebView、自绘内容或未暴露的控件可能无法定位。
5. 同一 MCP 进程内，多个面板可以共享同一设备会话。需要停止整个预览时，调用 `preview_stop` 并传入 `sessionId`；不带订阅 ID 的公开调用会停止整个会话。

`tap_element` 会检查目标的唯一性、可点击状态和坐标；缺少可见性信息时仍可能通过，也不能保证目标未被遮挡或界面未变化。执行回执或新帧不等于业务操作成功。

需要构建、安装并启动应用时，在用户授权后调用 `build_run`；多模块和产物选择见[设备操作](codex-usage-reference.md#设备操作)。

## 配置与快速输入

默认使用标准点击和滑动。快速滑动属于实验路径；输入发出后发生失败、超时或取消时，结果未知，不会自动重发或补发抬起。设备断线或进程中止后的触摸释放尚未验证。

启用条件、快速点击和完整配置见[配置与快速输入](codex-usage-reference.md#配置与快速输入)。

取帧恢复失败或订阅失效时，面板会尝试自动恢复，并在确认新帧前暂停交互。动作结果未知时先检查设备，再按需选择 `Retry frame`；面板不会重发原操作。

## 验证

本地回归可运行 `npm run check`。默认只读真机验收、授权点击和构建验收见[真机验收清单](codex-acceptance.md)。使用独立进程验收通过，不能证明当前 Codex 对话已重连。

## 常见问题

- 设备未出现：检查 HDC 路径、设备连接及授权，或确认模拟器已启动。
- 工具缺失或面板提示宿主过旧：重新连接 MCP，必要时重启 Codex，再重新打开面板。
- `connected: false` 只表示预览未收到设备帧；传入目标 `deviceId` 调用 `preview_info`，查看 `deviceCheck.status` 判断设备连接。

完整的工具、协议、配置、诊断和性能说明见[使用说明参考](codex-usage-reference.md)。
