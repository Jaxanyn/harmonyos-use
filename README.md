# harmonyos-use

HarmonyOS Use 让 Codex 等 AI Agent 通过 MCP 预览和操作 HarmonyOS 真机或模拟器，支持设备发现、截图、控件树读取、构建安装，以及点击、滑动和输入。

## 快速开始

### 1. 准备环境

需要 Windows、Git、Codex CLI、Node.js 20+、DevEco Studio、HDC、已存在的 HarmonyOS 工程，以及已授权的真机或已启动的模拟器。

建议使用 Node.js 22：上游依赖 `@openai/mcp-extensions` 要求 Node.js 22+。Node.js 20 默认安装可能提示 `EBADENGINE`，启用 npm `engine-strict` 时安装会失败。

运行 `hdc list targets` 检查设备。HDC 不在 `PATH` 中时，使用 `& "C:\path\to\hdc.exe" list targets`，并在安装脚本中追加 `-HdcCommand "C:\path\to\hdc.exe"`，将路径替换为实际位置。

### 2. 安装 MCP

```powershell
git clone https://github.com/Jaxanyn/harmonyos-use.git
cd harmonyos-use
npm ci
.\scripts\install-codex.ps1 -ProjectPath C:\path\to\my-harmonyos-project
codex mcp get harmonyos-preview
```

将 `C:\path\to\my-harmonyos-project` 替换为实际工程目录。已有同名 MCP 配置默认不覆盖；确认需要替换时追加 `-Force`。注册后刷新 MCP 工具列表或重启 Codex。

### 3. 打开预览

然后在 Codex 中发送：

```text
列出已连接的设备并打开预览面板；不要构建、安装或操作设备。
```

面板首次显示位置由宿主决定。如果面板出现在聊天中，请展开面板，然后选择设备并点击 `Start`。`previewUrl` 可用于浏览器预览。

`codex mcp get` 只确认注册信息。设备出现在列表、面板显示正在运行且画面能够更新后，才能确认当前连接可用。

## 使用限制

- 构建、安装、启动和设备操作会改变设备状态，须先获得用户授权。操作后应重新观察并确认结果。
- 当前预览通过截图轮询更新；画面刷新和操作反馈的速度受设备、连接和采集耗时影响。
- `tap_element` 会检查目标的唯一性、可点击状态和坐标，但缺少可见性信息时仍可能通过，不能保证目标未被遮挡或界面未发生变化。WebView、自绘内容或未暴露的控件可能无法定位。
- 取帧异常或动作结果未知时，面板可能保留旧画面并暂停交互，确认新帧后才恢复。先检查设备，再按需选择 `Retry frame`；面板不会自动重发原操作。
- 快速滑动属于实验路径；启用条件和失败处理见[使用说明](docs/codex-usage.md)。

## 文档

- [使用说明与配置](docs/codex-usage.md)
- [真机验收清单](docs/codex-acceptance.md)
- [Codex 工作流技能](skills/harmonyos-preview-codex/SKILL.md)（供 Agent 使用）
