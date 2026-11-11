---
name: harmonyos-preview-codex
description: Use the HarmonyOS Preview MCP tools from Codex to build, run, observe and interact with a HarmonyOS app on a connected device.
---

# HarmonyOS Preview in Codex

Use this workflow when the user asks to run or inspect a HarmonyOS project in a connected device, or asks to open HarmonyOS Preview in Codex.

## Required workflow

1. When the user asks to open the preview beside the conversation or in the right side panel, call `preview_panel` first. It is the thread entrypoint titled `鸿蒙真机预览`. Use `preview_open` for the left navigation/global app. Do not claim that either tool can force a pin state or persist the panel across chats or restarts.
2. Call `list_devices` and select one device ID. If no device is listed, report that HDC must be connected and authorized.
3. Call `preview_info` with the selected `deviceId` for a read-only connection check. Inspect `deviceCheck` and `runtime`; if it returns `restored: true`, reuse its `sessionId` and `previewUrl`.
4. Call `build_run` with the selected device ID when the app must be rebuilt or launched. It defaults to the `entry` module; for multi-module projects pass `moduleName`, and pass `artifactName` when that module emits multiple HAP files.
5. Call `preview_start` with the same device ID when no restorable session exists. Save the returned `sessionId` and `previewUrl`.
6. Open `previewUrl` with the Codex host browser-panel action at `placement: "right"` only as a live-preview fallback. The MCP App consumes `preview_frame(afterSeq)` for its live image; use `capture` when the next model decision needs an independent image.
7. Use `observe` for the current UITest tree and `find` with `selector` fields `text`, `textContains`, `id`, `type`, `clickable` or `enabled` to inspect candidates. For an authorized component click, call `tap_element` with that selector so the tool queries again and validates the current target. Keep coordinate `tap` for an authorized target confirmed from a fresh screenshot. After an action, use `wait_for` for expected state or text, then `capture` for fresh visual evidence.
8. Call `preview_stop` with the saved `sessionId` when the preview work is finished.

## Operating rules

- Do not call `preview_start` repeatedly for the same device; it reuses the active session.
- Keep the `sessionId` returned by `preview_start`; pass it to `preview_stop` so an older instruction cannot stop a newer session.
- `connected` from `preview_info` only means the live preview has received device frames. Check `deviceCheck.status` instead of treating `connected: false` as proof of an offline device. Without `deviceId`, the check is `not_checked`; with it, the check is `connected`, `disconnected` or `error`.
- Do not use coordinates from an old screenshot after navigation, scrolling, rotation or a new frame.
- `capture` always samples the device again, even during live preview. It returns `live: false`, a `frameId` and `capturedAt`; it does not prove an asynchronous page transition has finished.
- `preview_frame` is MCP App-only. It returns the newest in-memory frame by `seq`; repeated `afterSeq` values return no image and do not enter model content. Pass `waitMs` after an interaction to wait for the next frame instead of polling a stale sequence. Its structured `metrics` reports the source, capture duration, byte size, and capture time; the panel adds local `renderMs`. `preview_action` reports `actionMs` and the acted-on `frameSeq`. Five seconds without frame requests pauses HDC polling; the next frame request resumes the same session.
- `preview_action` is MCP App-only for one pointer tap or swipe. It checks the current frame, waits for the preview service to acknowledge capture pause, and resumes JPEG sampling after the input completes. The panel uses `nextFrameAfterSeq` to wait for the next frame. Successful model-facing `tap`, `tap_element`, `swipe`, `long_press`, `key_event` and `input_text` calls also request a live-preview refresh.
- MCP requests may run concurrently; mutating operations for one device are queued in arrival order while reads and waits remain responsive. Send `$/cancelRequest` or `notifications/cancelled` with `params.requestId` to cancel a long wait, screenshot or HDC child process; expect JSON-RPC error `-32800`.
- `observe` defaults to 200 nodes; `find` defaults to 20 candidates. Conditions combine with AND, and matching multiple nodes never triggers an automatic click. Re-read after any navigation, scrolling or rotation.
- `tap_element` takes `deviceId`, the same AND `selector`, and optional `bundleName`. It queries a fresh tree with a two-candidate limit but checks the full match count. It clicks once only for a unique, clickable target that is not explicitly disabled or hidden, has valid bounds and center, and has a valid observation age of 0–1000 ms. Preflight rejection does not click or retry; HDC action failure may already have taken effect, so inspect new evidence before deciding what to do.
- `tap_element` success returns `action: "tap"`, `target`, `observedAt` and `verified: false`. It confirms command execution, not business completion; follow with `wait_for` and `capture`. It does not atomically eliminate UI changes between reading and tapping or make custom-rendered controls locatable.
- Empty or truncated trees and layout errors are not proof that a target is absent. Inspect the fresh screenshot fallback and its capture metadata. If `screenshotError` is present, inspect `screenshotDiagnostic` separately from the main error before acting.
- `wait_for` uses the same AND selector as `find`; `state` is `present` (default) or `absent`. `timeoutMs` is an integer from 1 to 30000 (default 5000), and `intervalMs` from 100 to 5000 (default 500). Optional `bundleName` scopes the layout. It observes only and never clicks.
- Wait for changed text with both its ID and the expected exact `text`, using `present`. `absent` requires a nonempty readable tree without matches; it cannot prove prior presence, custom-rendered content or business completion. Matching checks the full tree even though `lastObservation` retains at most 200 nodes and 20 matches, with totals and truncation flags.
- Inspect `status` (`matched`, `timeout`, `observation_failed`), `attempts`, `elapsedMs`, `lastObservation` and `warnings`. Failures include `error`, set `isError: true` and attempt a fresh screenshot. Screenshot capture has a 3-second budget, and each HDC cleanup has up to 2 seconds; final wait cleanup plus screenshot work can add about 7 seconds after the wait deadline. `elapsedMs` includes wait cleanup, not screenshot work. Preserve `screenshotError`; do not automatically repeat a failed action.
- Use the structured result fields (`deviceId`, `live`, `sessionId`, `connected`) instead of parsing text when available.
- When the Codex `open_in_codex` host action is available, pass `{ target: { type: "browser", url: previewUrl }, placement: "right" }` so the preview opens beside the conversation.
- `preview_open` adds the global sidebar entry, but the user must choose the entry's menu action to pin it the first time; there is no MCP API that can set the host's pin state.
- When the host opens a new page, call `preview_info` first and reopen its `previewUrl`; do not create a second session when `restored: true`.
- Ask before `build_run` if the user did not request a build or device state change.

## Minimal prompt pattern

```text
Run the HarmonyOS app, open its live preview, and tap the primary action button.
```

## 等待示例

用户已授权点击时，用 `tap_element` 查询并点击：`{"deviceId":"目标设备","selector":{"id":"submit","clickable":true}}`。成功结果的 `verified: false` 仍需验证；继续调用 `wait_for`：`{"deviceId":"目标设备","selector":{"id":"status","text":"完成"}}`，等待预期文字出现，再调用 `capture`。

加载控件消失可用 `{"deviceId":"目标设备","selector":{"id":"loading"},"state":"absent"}`。空树不算消失；当前树未匹配也不能替代业务结果确认。

## 连接与失败诊断

`preview_info({"deviceId":"目标设备"})` 只读检查 HDC 目标列表；不传设备时不探测。调用成功后仍需检查 `deviceCheck.status`，不能仅以没有 `isError` 判断设备在线。检查 `runtime.diagnosticsVersion`（当前为 `1`）及 `serverVersion`、`startedAt`、`instanceId`；同一次 MCP 服务启动期间的 `instanceId` 保持不变。缺少所需能力或运行契约时按 `MCP_OUTDATED` 处理，不据此判断设备离线，也不自动刷新宿主。

工具执行失败保留 `isError: true`、`error` 与结构化 `errorCode`、`stage`、`deviceId`、`elapsedMs`、`cause`。`DEVICE_OFFLINE` 需要目标列表确认；HDC 不可用或超时分别保留 `HDC_UNAVAILABLE`、`HDC_TIMEOUT`。等待超时可返回 `WAIT_TIMEOUT`；补图失败另记 `screenshotError`、`screenshotDiagnostic`，不能覆盖主错误或被用来自动重放点击、输入。

`tap_element` 的预检错误为 `ELEMENT_NOT_FOUND`、`ELEMENT_AMBIGUOUS`、`ELEMENT_NOT_ACTIONABLE` 或 `STALE_OBSERVATION`；保留其主错误与截图证据，不绕过检查自动改点候选或重试。新增工具需要宿主重新连接 MCP 后加载；已有只读验收通过时，仅确认新工具可见，不要求重复之前的只读验收。

`scripts/check-codex.mjs` 的 `connectionCheck` 标明检查范围：命令行为 `isolated_process`，传入客户端为 `provided_client`，两者均返回 `hostConnectionVerified: false`。独立验收通过不证明当前 Codex 对话已重连；宿主状态只能由当前对话实际调用工具验证。
