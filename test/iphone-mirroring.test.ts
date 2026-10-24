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
