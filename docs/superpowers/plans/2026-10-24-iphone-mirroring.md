# iPhone Mirroring Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Control the mirrored iPhone through the mobile MCP server, including app search and launch.

**Architecture:** A native MirroringClient owns macOS subprocesses and image processing. An IPhoneMirroringRobot adapts it to Robot. Mirroring tools provide window control, diagnostics, scrolling and visual app search/launch.

**Tech Stack:** TypeScript, osascript/JXA, CoreGraphics, screencapture, sharp, existing MCP SDK and Playwright runner.

**Spec:** docs/superpowers/specs/2026-10-24-iphone-mirroring-design.md

## Global Constraints

- Keep the existing TypeScript build and test runner.
- Selecting Mirroring bypasses mobilecli, go-ios, and WebDriverAgent prerequisites.
- Preserve upstream MIT attribution in source and packaged output.
- No global configuration changes or additional worktrees.
- Refresh geometry and capture before input; never automatically replay input.

## Review Focus

- Retina captures must map to logical content coordinates without title-bar offsets.
- Window movement between capture and input must refresh the desktop offset.
- Missing permissions and a disconnected window must produce useful errors.
- Unicode and quotes in search and typing must remain data in JXA.
- App launch must use a visually selected result, never blindly submit a query.

### Task 1: Native client and Robot

**Files:** src/mirroring-client.ts, src/iphone-mirroring.ts, test/iphone-mirroring.test.ts, package.json, package-lock.json, lib licensing notice.
**Interfaces:** MirroringClient.window(): Promise<MirroringWindow>, capture(options?): Promise<Buffer>, click/drag/scroll/type/shortcut/windowControl/diagnostics; IPhoneMirroringRobot implements Robot and delegates using content coordinates.

- [ ] Write failing tests for logical geometry, moved-window mapping, unsupported operations, capture resizing, escaped text, scroll directions and permission failures.
- [ ] Run `npx playwright test test/iphone-mirroring.test.ts`; confirm the missing backend fails.
- [ ] Implement the macOS adapter from the upstream window/input code and preserve attribution. Use sharp for image crop, resize and encoding. Reject unsupported Robot operations explicitly.
- [ ] Run the focused tests, build and lint. Expected: pass.
- [ ] Commit the backend and license.

### Task 2: MCP integration and controls

**Files:** src/server.ts, src/mirroring-tools.ts, test/server-mirroring.test.ts.
**Interfaces:** reserved device id iphone-mirroring; MOBILEMCP_IPHONE_MIRRORING=1 enables backend. Register diagnostics, window control, scrolling, app search screenshot and app launch by visible coordinates.

- [ ] Write failing MCP tests for routing without mobilecli, offline diagnostics, tool schemas and unsupported mobilecli-only operations.
- [ ] Run `npx playwright test test/server-mirroring.test.ts`; confirm failure before integration.
- [ ] Integrate discovery and Robot selection before mobilecli requirements. Add controls with existing tool result/error conventions. App search replaces Spotlight query and returns image; launch taps caller-selected coordinates and reports that verification is required.
- [ ] Run focused and existing server tests. Expected: pass.
- [ ] Commit MCP integration.

### Task 3: Documentation, live checks and delivery

**Files:** README.md, docs/iphone-mirroring.md, design/plan progress.

- [ ] Document the local build/run config, tools, app search workflow and unsupported features.
- [ ] Run `npm run build`, `npm run lint`, and `npm test`. Expected: pass; report actual failures.
- [ ] Exercise diagnostics and safe screenshot/Home/Spotlight/search/launch against the local window when available. Record blocked checks instead of claiming device success.
- [ ] Request fresh whole-branch review, fix material findings, commit and push to the fork. No npm publication or installed MCP changes.
