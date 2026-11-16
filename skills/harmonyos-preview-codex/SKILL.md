---
name: harmonyos-preview-codex
description: Use HarmonyOS Use MCP tools from Codex to build, run, observe and interact with a HarmonyOS app on a connected device.
---

# HarmonyOS Use in Codex

Use this workflow to inspect or run a HarmonyOS app on a connected device, or open its preview in Codex. Existing MCP registration and commands retain `harmonyos-preview` for compatibility.

## Open the preview

1. For a preview beside the conversation or in the right panel, call `preview_panel` first. Use `preview_open` for the global sidebar entry. Neither tool can force a pin or keep the panel open across chats or restarts.
2. Call `list_devices` and select a device ID. If none is listed, report that HDC must be connected and authorized.
3. Call `preview_info` with `deviceId`. Check `deviceCheck.status` and `runtime`; the top-level `connected` only indicates whether preview frames have arrived. Before reusing a restored session, confirm the top-level `deviceId` matches the selected device. If an existing session belongs to another device, report the conflict and pause this workflow until it is resolved; do not automatically stop or replace a shared session.
4. If a rebuild or launch is requested or otherwise authorized, call `build_run` with the device ID. It defaults to `entry`; use `moduleName` for another module and `artifactName` when multiple HAPs are produced. Reuse the matching restored `sessionId` and `previewUrl`; otherwise, when there is no device conflict, call `preview_start` with the selected device ID and save its `sessionId` and `previewUrl`.
5. If the panel needs a live-preview fallback, use the Codex host action `open_in_codex` with `{ target: { type: "browser", url: previewUrl }, placement: "right" }`. The MCP App consumes `preview_frame`; call `capture` when the model needs an independent fresh image.

## Inspect and interact

- Obtain authorization for device changes, including `swipe`, `long_press`, `key_event` and `input_text`. Use `observe` or `find` to inspect the current UI; selector conditions combine with AND. After navigation, scrolling or rotation, inspect again.
- For an authorized component click, pass the selector to `tap_element`. It re-queries the UI and checks that the target is unique and actionable before sending one click. It cannot guarantee that the target is unobscured or that the UI remains unchanged. If the control cannot be located, use coordinate `tap` only after confirming the target in a fresh `capture`; never reuse coordinates from an old frame.
- After an action, use `wait_for` for the expected state or text, then `capture` for fresh visual evidence. A successful command, `verified: false`, or a new frame does not establish business success. An empty or truncated UI tree does not prove the target is absent.
- If preflight rejects a target, do not automatically choose another or bypass the check. If an action fails or times out after it may have been sent, its outcome is unknown: inspect fresh evidence before deciding what to do, and do not automatically repeat it.

## Finish and diagnose

- Stop the preview only when it is no longer needed. Call `preview_stop` with the saved `sessionId`; a public call without a subscriber ID stops the entire session, including shared panels.
- For connection failures, inspect `deviceCheck` and retain the structured error and any `screenshotError` or `screenshotDiagnostic`. Missing required tools or diagnostics indicate `MCP_OUTDATED`, not an offline device; reconnect the host before using the missing capability. A CLI check using `isolated_process` does not prove that the current Codex host has reconnected; verify it through tools in the current conversation.
- For tool parameters, session sharing, error codes and recovery, see the [usage reference](https://github.com/Jaxanyn/harmonyos-use/blob/main/docs/codex-usage-reference.md). For host and device checks, see the [acceptance checklist](https://github.com/Jaxanyn/harmonyos-use/blob/main/docs/codex-acceptance.md).
