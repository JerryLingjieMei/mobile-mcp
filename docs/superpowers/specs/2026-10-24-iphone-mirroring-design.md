# iPhone Mirroring support

Status: implementation scope accepted through the user’s follow-up, including app search and launch.

## Intent

Add control of a physical iPhone through Apple's macOS iPhone Mirroring app
to this fork of mobile-next/mobile-mcp. Reuse the relevant implementation from
yev-yev-yev/iphone-mcp and preserve its MIT license and attribution. The user
also requested other useful controls for the Mirroring app.

Inspected source revisions: mobile-mcp
`621e0e5b305f9eac51f61306d05b8fa2cd304f7a` and iphone-mcp
`e56e78e281a4c564a28c82e3cfa481411c647380`.

## Approaches

The proposed choice is a native TypeScript backend using the source project's
window capture, CGEvent injection, and keyboard input code. It fits mobile-mcp's
Robot interface and runs in the existing server process.

A second approach would start iphone-mcp as a child MCP server and translate
calls. That preserves more upstream code unchanged, but adds a second server,
its lifecycle, and another build/configuration dependency. A hybrid with
WebDriverAgent would retain device-management features but defeat the useful
property of controlling the phone without provisioning or Xcode setup.

Use direct integration. The user accepted the proposed controls and added app search and launch.

## Supported behavior

- Expose the currently mirrored phone under a distinct device id,
  `iphone-mirroring`, without impersonating its USB device id.
- Use the existing mobile tools for screen dimensions, screenshots, saving
  screenshots, tapping, double tapping, long pressing, typing, and swiping.
- Add a Mirroring-specific control tool for Home, App Switcher, Spotlight,
  opening the Mirroring app, focusing its window, moving its window, and
  selecting supported window sizes.
- Add a scrolling tool with a point, direction, and distance. Use scroll-wheel
  events for scrolling and drag events for swipes; do not conflate them.
- Support clipboard reads and writes through the existing clipboard tool.
  Explain that these operate the Mac clipboard and rely on Universal Clipboard
  for transfer to the iPhone.
- Add read-only Mirroring diagnostics that report the host platform, window
  availability, permissions, geometry, and supported capabilities. A visible
  Mac window alone is not proof of a connected phone.

## Device discovery and setup

The proposed backend is explicitly enabled in the server configuration. On
macOS, discovery reports the Mirroring target separately from USB devices.
Selecting it bypasses mobilecli, go-ios, and WebDriverAgent prerequisites.
Existing discovery behavior remains available for all other device ids.

The implementation must not launch or focus the app during ordinary device
listing, silently grant permissions, change security settings, or claim a
disconnected phone is online. Setup instructions cover macOS Sequoia or later,
iOS 18 or later, Apple's pairing requirements, Accessibility, and Screen
Recording permissions. Authentication and initial pairing remain user actions.

## Coordinates and capture

Use the Mirroring content rectangle as the device coordinate space. Exclude
desktop window chrome consistently from captures and input. Normalize captures
to the logical dimensions exposed by getScreenSize; preserve the server's
existing screenshot resize/coordinate guidance. Refresh window geometry before
input so moving or resizing the window does not invalidate the conversion.
Test Retina scaling, window offsets, and resized screenshots explicitly.

Keep screenshots free of a grid by default so the existing coordinate contract
does not acquire a padding offset. The source project's optional grid is not
required for this first integration.

## Limits

The Mirroring backend does not provide the iOS accessibility tree, bundle-id
app enumeration/launch/termination, installation, GPS override, device logs,
crash reports, physical volume buttons, or forced device orientation. Return
actionable unsupported-operation errors rather than empty success results.
Read the displayed orientation when it can be determined from the content.

Add an app-search tool that opens Spotlight, replaces the search query, and
returns a screenshot. Add an app-launch tool that taps a result at coordinates
chosen from that screenshot. The caller must inspect the screenshot and choose
the desired app; do not blindly launch the top search hit or treat typing as
proof that an app launched. App-launch reports the action and requires a fresh
screenshot to verify the outcome.

No OCR, cloud service, new global agent configuration, or automatic installation
of this fork is included. Do not close a working Mirroring session after each
tool call. A failed capture after an input must not cause input replay.

## Structure

```text
MCP mobile tools -> Robot selection -> iPhone Mirroring backend
                                          | window geometry and capture
                                          | CGEvent input and scrolling
                                          | keyboard shortcuts and typing
                                          | permission/window diagnostics
```

Keep the existing TypeScript build and test runner. Adapt only the upstream
modules needed for this backend; retain licensing in shipped output. Leave
exact class/module boundaries and tool schema names to the implementer.

## Verification and delivery

Add focused tests for discovery without mobilecli, routing, unsupported
operations, coordinate conversion, input escaping, scrolling direction,
diagnostic errors, and MCP tool schemas. Run build, lint, and applicable tests.
Existing tests that require unrelated simulators or physical devices should be
reported separately if those devices are unavailable.

If a connected Mirroring session is available, verify screenshots, geometry,
Home, Spotlight, typing, tapping, and scrolling with harmless actions and fresh
screenshots. Report blocked live checks explicitly; unit tests alone do not
establish that physical phone control works.

Commit and push the completed implementation to the user's fork, with setup
instructions and clear capability limits. Do not publish an npm package or
change the user's installed MCP configuration as part of this request.
