import { expect, test } from "@playwright/test";
import vm from "node:vm";
import sharp from "sharp";
import { MirroringClient, selectMirroringWindow, buildTextScript, scrollDeltas, type MirroringWindow } from "../src/mirroring-client";
import { IPhoneMirroringRobot } from "../src/iphone-mirroring";

const standardWindow: MirroringWindow = {
	x: 100, y: 200, width: 320, height: 700, windowId: 42, connected: true, status: "connected",
};

test("matches capture to the standard window rather than a floating dialog", () => {
	const result = selectMirroringWindow([
		{ x: 6, y: 315, width: 66, height: 20, standard: false, status: "dialog" },
		{ x: 100, y: 200, width: 320, height: 700, standard: true, status: "connected" },
	], [
		{ x: 6, y: 315, width: 66, height: 20, windowId: 9 },
		{ x: 100, y: 200, width: 320, height: 700, windowId: 42 },
	]);
	expect(result).toEqual(standardWindow);
});

test("does not advertise a disconnected window as a connected phone", () => {
	const result = selectMirroringWindow([
		{ ...standardWindow, standard: true, status: "iPhone in Use. Lock your iPhone to connect. Connect" },
	], [standardWindow]);
	expect(result.connected).toBe(false);
	expect(result.status).toContain("Lock your iPhone");
});

test("rejects a window that cannot be matched to its capture id", () => {
	expect(() => selectMirroringWindow([{ ...standardWindow, standard: true }], [])).toThrow(/window/i);
});

test("typing preserves quotes, backslashes and unicode as data", () => {
	const typed: string[] = [];
	const clipboard: string[] = [];
	const text = "Calculator'); throw new Error('injected'); \\ 日本語";
	const se = { keystroke: (s: string) => typed.push(s) };
	const app = { setTheClipboardTo: (s: string) => clipboard.push(s), includeStandardAdditions: false };
	vm.runInNewContext(buildTextScript(text), {
		Application: Object.assign(() => se, { currentApplication: () => app }),
		delay: () => {},
	});
	expect(typed.join("")).toContain("Calculator'); throw new Error('injected'); \\ ");
	expect(clipboard.join("")).toBe("日本語");
});

test("scroll direction accounts for natural scrolling", () => {
	expect(scrollDeltas("down", 80, true)).toEqual({ deltaX: 0, deltaY: -80 });
	expect(scrollDeltas("up", 80, true)).toEqual({ deltaX: 0, deltaY: 80 });
	expect(scrollDeltas("left", 30, false)).toEqual({ deltaX: -30, deltaY: 0 });
	expect(scrollDeltas("right", 30, false)).toEqual({ deltaX: 30, deltaY: 0 });
});

class FixtureClient extends MirroringClient {
	position = { ...standardWindow };
	clicks: Array<{ x: number; y: number; numTaps: number }> = [];
	async window() { return { ...this.position }; }
	async activate() {}
	async captureWindow(info: MirroringWindow, options = {}) {
		const png = await sharp({ create: { width: 640, height: 1400, channels: 3, background: "red" } }).png().toBuffer();
		return this.processCapture(png, info, options);
	}
	async postClick(x: number, y: number, numTaps = 1) { this.clicks.push({ x, y, numTaps }); }
}

test("normalizes Retina captures to the logical device size and honors maxSize", async () => {
	const robot = new IPhoneMirroringRobot(new FixtureClient());
	expect(await robot.getScreenSize()).toEqual({ width: 320, height: 700, scale: 1 });
	const png = await robot.getScreenshot();
	expect(await sharp(png).metadata()).toMatchObject({ width: 320, height: 700, format: "png" });
	const jpeg = await robot.getScreenshot({ format: "jpeg", maxSize: 350 });
	expect(await sharp(jpeg).metadata()).toMatchObject({ width: 160, height: 350, format: "jpeg" });
});

test("refreshes moved window geometry before translating taps", async () => {
	const client = new FixtureClient();
	const robot = new IPhoneMirroringRobot(client);
	await robot.getScreenshot();
	client.position.x = 600;
	client.position.y = 40;
	await robot.tap(20, 80);
	expect(client.clicks).toEqual([{ x: 620, y: 120, numTaps: 1 }]);
	await expect(robot.tap(400, 80)).rejects.toThrow(/outside/);
});

test("refuses input when the physical iPhone is in use", async () => {
	const client = new FixtureClient();
	client.position = { ...standardWindow, connected: false, status: "iPhone in Use" };
	const robot = new IPhoneMirroringRobot(client);
	await expect(robot.tap(20, 80)).rejects.toThrow(/iPhone in Use/);
	expect(client.clicks).toEqual([]);
});

test("explains unsupported accessibility and device management operations", async () => {
	const robot = new IPhoneMirroringRobot(new FixtureClient());
	await expect(robot.getElementsOnScreen()).rejects.toThrow(/screenshot/i);
	await expect(robot.launchApp("com.apple.calculator")).rejects.toThrow(/mobile_mirroring_search_apps/);
	await expect(robot.installApp("x.ipa")).rejects.toThrow(/not supported/i);
	await expect(robot.pressButton("VOLUME_UP")).rejects.toThrow(/not supported/i);
});

test("does not report connection-screen orientation as the phone orientation", async () => {
	const client = new FixtureClient();
	client.position = { ...standardWindow, connected: false, status: "iPhone in Use" };
	await expect(new IPhoneMirroringRobot(client).getOrientation()).rejects.toThrow(/disconnected/);
});

test("diagnostics report capture permission failure without assuming a visible window is usable", async () => {
	const client = new FixtureClient();
	client.jxa = async () => "true";
	client.captureWindow = async () => { throw new Error("Screen Recording denied"); };
	const status = await client.diagnostics();
	expect(status.accessibility).toBe(true);
	expect(status.screenRecording).toBe(false);
	expect(status.error).toContain("Screen Recording denied");
});

test("waits for Spotlight to become ready before entering an app query", async () => {
	class OpeningSpotlightClient extends FixtureClient {
		spotlightReadyAt = 0;
		query = "";
		async shortcut(key: string) {
			if (key === "3") { this.spotlightReadyAt = Date.now() + 300; }
		}
		async type(text: string) {
			if (Date.now() < this.spotlightReadyAt) { throw new Error("Spotlight has not focused its search field"); }
			this.query = text;
		}
	}
	const client = new OpeningSpotlightClient();
	await new IPhoneMirroringRobot(client).searchApps("Calculator");
	expect(client.query).toBe("Calculator");
});

test("uses the captured window bounds when accessibility geometry lags a resize", () => {
	const resolved = selectMirroringWindow([
		{ x: 100, y: 200, width: 320, height: 700, standard: true, title: "iPhone Mirroring", status: "connected" },
	], [
		{ x: 6, y: 315, width: 66, height: 20, windowId: 9, title: "Window" },
		{ x: 400, y: 100, width: 400, height: 880, windowId: 42, title: "iPhone Mirroring" },
	]);
	expect(resolved).toMatchObject({ x: 400, y: 100, width: 400, height: 880, windowId: 42 });
});

test("does not disturb focus when Mirroring is already frontmost", async () => {
	let focusChanges = 0;
	const target = {};
	Object.defineProperty(target, "frontmost", { get: () => () => true, set: () => { focusChanges++; } });
	const client = new MirroringClient();
	client.run = async (file, args) => {
		if (args.includes("JavaScript")) {
			vm.runInNewContext(args[args.length - 1], { Application: () => ({ processes: { "iPhone Mirroring": target } }), delay: () => {} });
		} else {
			// The former unconditional AppleScript activation disturbs focus.
			focusChanges++;
		}
		return "";
	};
	await client.activate();
	expect(focusChanges).toBe(0);
});

test("makes a hidden Mirroring surface available before capturing it", async () => {
	class HiddenClient extends FixtureClient {
		active = false;
		async activate() { this.active = true; }
		async window() {
			if (!this.active) { throw new Error("No standard iPhone Mirroring window"); }
			return { ...this.position };
		}
	}
	const png = await new IPhoneMirroringRobot(new HiddenClient()).getScreenshot();
	expect(await sharp(png).metadata()).toMatchObject({ width: 320, height: 700 });
});

test("scrolling emits a complete continuous gesture at the requested point", async () => {
	const events: Array<{ fields: Record<number, number>; point?: { x: number; y: number } }> = [];
	let cursor = { x: 0, y: 0 };
	const client = new MirroringClient();
	client.run = async (file, args) => {
		if (file.endsWith("defaults")) { return "1"; }
		const cg = {
			CGPointMake: (x: number, y: number) => ({ x, y }),
			CGWarpMouseCursorPosition: (p: { x: number; y: number }) => { cursor = p; },
			CGEventCreateMouseEvent: () => ({ fields: {} }),
			CGEventCreateScrollWheelEvent: () => ({ fields: {} }),
			CGEventSetIntegerValueField: (e: { fields: Record<number, number> }, key: number, value: number) => { e.fields[key] = value; },
			CGEventSetLocation: (e: { point?: { x: number; y: number } }, point: { x: number; y: number }) => { e.point = point; },
			CGEventPost: (tap: unknown, e: { fields: Record<number, number> }) => { events.push(e); },
		};
		vm.runInNewContext(args[args.length - 1], { ObjC: { import: () => {} }, $: cg, delay: () => {} });
		return "";
	};
	await client.scroll(150, 800, "down", 20);
	const scrolls = events.filter(e => e.fields[88] === 1);
	expect(cursor).toEqual({ x: 150, y: 800 });
	expect(scrolls[0].fields[99]).toBe(128);
	expect(scrolls[1].fields[99]).toBe(1);
	expect(scrolls[scrolls.length - 1].fields[99]).toBe(4);
	expect(scrolls.reduce((sum, e) => sum + (e.fields[96] || 0), 0)).toBe(-20);
	expect(scrolls.every(e => e.point?.x === 150 && e.point?.y === 800)).toBe(true);
});
