# iPhone Mirroring

This fork adds Apple's macOS iPhone Mirroring app as device `iphone-mirroring`.
It adapts the native automation code from
[yev-yev-yev/iphone-mcp](https://github.com/yev-yev-yev/iphone-mcp).
No WebDriverAgent, iOS provisioning profile, or Xcode project is needed for
this backend. Existing Android, simulator, USB, and cloud backends remain
available through their existing device ids.

```text
MCP client -> mobile-mcp -> iPhone Mirroring window -> physical iPhone
                       | screenshots and coordinate input
                       | scrolling and keyboard shortcuts
                       | Spotlight app search and visual launch
```

## Setup

Use macOS Sequoia 15 or later and iOS 18 or later. Complete
[Apple's iPhone Mirroring setup](https://support.apple.com/en-us/120421) first.
The Mac and phone must meet Apple's hardware, Apple Account, Bluetooth, Wi-Fi,
and region requirements. Keep the physical phone locked and nearby while
Mirroring is connected. A USB connection is not used by this backend.

The application hosting the server needs **Accessibility** and **Screen
Recording** access in System Settings → Privacy & Security. macOS may also
request Automation access to System Events. The server does not change these
permissions or bypass pairing or authentication.

The native window and menu integration currently uses the English app and View
menu names. Use an English macOS Mirroring interface for this version.

Build the fork with Node.js 22.13 or newer:

```bash
git clone https://github.com/JerryLingjieMei/mobile-mcp.git
cd mobile-mcp
npm ci
npm run build
MOBILEMCP_IPHONE_MIRRORING=1 node lib/index.js
```

Enable the backend in your MCP client's server configuration:

```json
{
  "mcpServers": {
    "mobile-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/mobile-mcp/lib/index.js"],
      "env": {
        "MOBILEMCP_IPHONE_MIRRORING": "1"
      }
    }
  }
}
```

Use an absolute Node executable path if your desktop application finds an older
Node version. The upstream `npx @mobilenext/mobile-mcp` command runs upstream,
not this fork. No global MCP configuration is changed by building the fork.

## Start here

1. Call `mobile_mirroring_diagnostics`. It checks Accessibility, captures only
   the Mirroring window to check Screen Recording, and reports native connection
   status. It does not open or focus the app.
2. If necessary, call `mobile_mirroring_control` with `action: "open"`, then
   complete connection or authentication in the app. A visible window alone
   does not establish a connected phone.
3. Call `mobile_list_available_devices`. The mirrored target appears separately
   from any USB-connected copy of the phone. An offline entry includes its status.
4. Call `mobile_take_screenshot` with `device: "iphone-mirroring"`.
5. Choose coordinates from that image and use the existing mobile input tools.
   Observe again after input before choosing the next action.

Mirroring discovery and input work without `mobilecli`, `go-ios`, or
WebDriverAgent. When `mobilecli` is missing, discovery still returns the
Mirroring target and explains why other devices cannot be enumerated.

## Existing mobile tools

Pass `device: "iphone-mirroring"` to these tools:

| Tool | Behavior |
| --- | --- |
| `mobile_get_screen_size` | Logical Mirroring-window width and height; scale 1 |
| `mobile_take_screenshot` | Screenshot with existing resize and coordinate guidance |
| `mobile_save_screenshot` | Save PNG or JPEG using existing output-path rules |
| `mobile_click_on_screen_at_coordinates` | Tap at x, y |
| `mobile_double_tap_on_screen` | Double tap at x, y |
| `mobile_long_press_on_screen_at_coordinates` | Hold for the requested duration, up to 10 seconds |
| `mobile_swipe_on_screen` | Drag in a direction, optionally from x, y and with distance |
| `mobile_type_keys` | Type into the focused field; submit sends Return |
| `mobile_press_button` | `HOME`, `APP_SWITCH`, `SPOTLIGHT`, `ENTER`, `BACKSPACE` |
| `mobile_clipboard` | Read/write the Mac clipboard; Universal Clipboard provides transfer to the iPhone |
| `mobile_get_orientation` | Infer displayed portrait/landscape while connected |

Coordinates refer to the whole standard Mirroring window at its logical
macOS dimensions. Captures normalize Retina pixels to those dimensions, and
input refreshes the window's position and size before translating coordinates.
Resized screenshots include the normal mobile-mcp conversion instructions.
After resizing the window, take a new screenshot before selecting coordinates.
No reference grid or extra padding is added.

Text entry supports quotes, backslashes, Unicode, emoji, Return, Backspace,
Tab, Delete, and Escape. Unicode text uses the Mac clipboard and can replace
its current contents. The on-screen iPhone keyboard need not be visible.

## Additional Mirroring tools

These tools act on the single currently mirrored phone and take no device id.
They are registered only when `MOBILEMCP_IPHONE_MIRRORING=1`.

| Tool | Arguments and behavior |
| --- | --- |
| `mobile_mirroring_diagnostics` | No arguments; platform, permissions, window, native status, capabilities and limits |
| `mobile_mirroring_control` | `action`: `open`, `focus`, `home`, `app_switcher`, `spotlight`, `move`, or `resize` |
| `mobile_mirroring_scroll` | `x`, `y`, `direction`, optional `distance` (default 80, maximum 2000); native scroll-wheel events |
| `mobile_mirroring_search_apps` | `query`: app display name; opens Spotlight, replaces the query and returns an image |
| `mobile_mirroring_launch_app` | `x`, `y`: tap the app result chosen from a fresh search screenshot |

For `move`, provide desktop `x` and `y`; negative coordinates are allowed for
other displays. For `resize`, provide `size: "larger"`, `"actual"`, or
`"smaller"` to use the app's View menu presets.

Use scrolling for lists, web pages and feeds. Use swipes for drag gestures.
Natural scrolling is accounted for, but actual motion varies with the app.
Start small, capture again, and adjust the distance or reverse direction if
needed. Do not assume a successful response proves that content moved.

### App search and launch

```text
mobile_mirroring_search_apps({"query":"Calculator"})
  -> inspect the screenshot and identify the intended app result
mobile_mirroring_launch_app({"x":<chosen result x>,"y":<chosen result y>})
mobile_take_screenshot({"device":"iphone-mirroring"})
  -> verify Calculator actually opened
```

Search does not launch anything. Launch taps the result you visually selected;
it does not blindly press Return on the first Spotlight hit. If results are
ambiguous, ask the user which app they intend. Launch coordinates use the same
logical space as the unscaled search screenshot. Launch reports the tap action;
only the following screenshot establishes that the desired app opened.

The additional Mirroring tools use separate MCP calls and are not included in
`mobile_batch_commands`. Existing mobile input tools remain batchable.

## Limits and recovery

Mirroring does not expose the iOS accessibility tree or stable element refs.
Use screenshots and coordinate input. It also cannot enumerate installed
bundles, launch by bundle id, install/uninstall apps, terminate apps directly,
open URLs directly, override GPS, fetch device logs/crashes, record the device
screen, send physical volume/lock buttons, or force phone orientation. These
operations return errors. Use an existing USB/WebDriverAgent backend when
those capabilities are required.

If the phone is unlocked or in use, input is refused with its native status.
Lock it and connect in the Mirroring app. Permission failures identify the
native command and the relevant macOS permissions. Screen Recording remains
unknown until a window can be captured. A working MCP transport alone does not
prove a usable Mirroring session.

If a screenshot fails after input, do not repeat the input. Retry only the
screenshot once, inspect the outcome, and reconnect only when the window or
transport is unavailable. No input is automatically retried.

## Development checks

```bash
npm run build
npm run lint
npm test
```

The automated tests cover geometry and Retina scaling, the floating-dialog
case, moved-window coordinates, disconnected input, native text data escaping,
scroll direction, diagnostics failures, routing without mobilecli, tool
schemas, and Spotlight search without blindly launching its first hit.
Live physical-phone checks require a locked and connected iPhone.

See [third-party notices](../THIRD_PARTY_NOTICES.md) for attribution and license.
