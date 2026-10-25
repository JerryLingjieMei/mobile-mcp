import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { IPhoneMirroringRobot } from "./iphone-mirroring";
import { mirroringDeviceId } from "./mirroring-client";

export const mirroringInstructions = `

iPhone Mirroring is enabled as device "iphone-mirroring". For this target, use
mobile_take_screenshot and coordinate controls: it does not expose the iOS
accessibility tree. Take a fresh screenshot before choosing coordinates, and
observe again after input. The coordinate space is the logical Mirroring window,
not physical iPhone pixels. Use mobile_mirroring_scroll for lists and pages;
mobile_swipe_on_screen performs a drag gesture. When disconnected, ask the user
to lock and connect the physical iPhone. Do not replay uncertain input.

To open an app, call mobile_mirroring_search_apps with its display name, inspect
the returned screenshot, then call mobile_mirroring_launch_app at the desired
result coordinates. Do not blindly launch the top Spotlight hit. If results are
ambiguous, ask the user to choose. Take a screenshot to verify the launched app.
Clipboard tools read/write the Mac clipboard; Universal Clipboard is required
for transfer to the iPhone. Unicode typing can replace the Mac clipboard.`;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const textResult = (value: unknown): { content: Content[] } => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

export const registerMirroringTools = (server: McpServer, robot: IPhoneMirroringRobot): void => {
	const register = (name: string, description: string, shape: Record<string, z.ZodType>, readOnly: boolean, cb: (args: any) => Promise<{ content: Content[] }>) => {
		server.registerTool(name, {
			description,
			inputSchema: z.object(shape),
			annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: !readOnly },
		}, async args => {
			try {
				return await cb(args);
			} catch (err: any) {
				return { ...textResult(err.message), isError: true };
			}
		});
	};

	register("mobile_mirroring_diagnostics", "Check iPhone Mirroring permissions, window geometry, and connection status without opening or focusing the app. A visible window is not proof of a connected phone. Screen Recording is checked by capturing this window only.", {}, true, async () => textResult({
		device: mirroringDeviceId,
		...await robot.client.diagnostics(),
		capabilities: ["screenshot", "tap", "double_tap", "long_press", "swipe", "scroll", "type", "home", "app_switcher", "spotlight", "app_search", "visual_app_launch", "mac_clipboard", "window_control"],
		unsupported: ["ios_accessibility_tree", "bundle_id_launch", "app_installation", "device_logs", "crash_reports", "screen_recording", "volume_buttons", "forced_orientation"],
	}));

	register("mobile_mirroring_control", "Control the Mac's iPhone Mirroring window, or navigate Home, App Switcher, and Spotlight. Opening does not bypass pairing or authentication. Window sizes use the app's View menu presets.", {
		action: z.enum(["open", "background", "focus", "home", "app_switcher", "spotlight", "move", "resize"]),
		x: z.number().int().optional().describe("Desktop x position for move; may be negative on another display."),
		y: z.number().int().optional().describe("Desktop y position for move."),
		size: z.enum(["larger", "actual", "smaller"]).optional().describe("Window size preset for resize."),
	}, false, async ({ action, x, y, size }) => {
		if (action === "open") {
			await robot.client.open();
			return textResult("Requested iPhone Mirroring to open in the background. Complete pairing/authentication if needed, then check mobile_mirroring_diagnostics.");
		}
		if (action === "background") {
			return textResult({ action, ...await robot.client.background() });
		}
		if (action === "move" && (x === undefined || y === undefined)) {
			throw new Error("Provide x and y for move");
		}
		if (action === "resize" && size === undefined) {
			throw new Error("Provide size for resize");
		}
		if (action === "home" || action === "app_switcher" || action === "spotlight") {
			const buttons: Record<string, "HOME" | "APP_SWITCH" | "SPOTLIGHT"> = { home: "HOME", app_switcher: "APP_SWITCH", spotlight: "SPOTLIGHT" };
			await robot.pressButton(buttons[action]);
		} else {
			await robot.client.activate();
			if (action === "move") {
				await robot.client.move(x, y);
			} else if (action === "resize") {
				await robot.client.resize(size);
			}
		}
		return textResult({ action, window: await robot.client.window() });
	});

	register("mobile_mirroring_scroll", "Scroll a list, page or feed with native scroll-wheel events. Coordinates use logical Mirroring-window pixels from a fresh screenshot. Start with a small distance, inspect a new screenshot after scrolling, and calibrate for the current app. Use mobile_swipe_on_screen for drag gestures.", {
		x: z.number().nonnegative(),
		y: z.number().nonnegative(),
		direction: z.enum(["up", "down", "left", "right"]),
		distance: z.number().positive().max(2000).default(80).describe("Native scroll-event distance; actual movement varies by app. Natural scrolling is accounted for."),
	}, false, async ({ x, y, direction, distance }) => {
		await robot.scroll(x, y, direction, distance);
		return textResult("Scroll sent. Take a fresh screenshot to verify movement.");
	});

	register("mobile_mirroring_search_apps", "Search iPhone apps by display name through Spotlight and return a screenshot of the results. This changes the current screen. Inspect the image and select the correct app with mobile_mirroring_launch_app; do not assume the first result is the desired app.", {
		query: z.string().trim().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value), "App search must not contain control keys"),
	}, false, async ({ query }) => {
		await robot.searchApps(query);
		await new Promise(resolve => setTimeout(resolve, 500));
		const screenshot = await robot.getScreenshot();
		const size = await robot.getScreenSize();
		return { content: [
			{ type: "text", text: `Spotlight query: ${query}. Screenshot coordinates match the ${size.width}x${size.height} Mirroring window. Inspect the results; if the app is ambiguous ask the user. Use mobile_mirroring_launch_app with the chosen result's x and y. No app has been launched by this search.` },
			{ type: "image", data: screenshot.toString("base64"), mimeType: "image/png" },
		] };
	});

	register("mobile_mirroring_launch_app", "Launch the app result visually selected in a fresh mobile_mirroring_search_apps screenshot. Pass the chosen app icon's coordinates in logical Mirroring-window pixels. This taps that result; it does not guess a bundle id or submit the top Spotlight hit. Take a fresh screenshot afterward to verify the requested app opened.", {
		x: z.number().nonnegative(),
		y: z.number().nonnegative(),
	}, false, async ({ x, y }) => {
		await robot.tap(x, y);
		return textResult("Tapped the selected app result. Take mobile_take_screenshot with device iphone-mirroring to verify the app opened; do not replay the tap if capture fails.");
	});
};
