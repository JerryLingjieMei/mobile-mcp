// Adapted from yev-yev-yev/iphone-mcp (MIT), copyright 2026 Yevgeniy Spektor.
// See THIRD_PARTY_NOTICES.md for the license and source revision.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ActionableError, ScreenshotOptions, SwipeDirection } from "./robot";

export const mirroringDeviceId = "iphone-mirroring";
const appName = "iPhone Mirroring";

export interface MirroringWindow {
	x: number;
	y: number;
	width: number;
	height: number;
	windowId: number;
	connected: boolean;
	status: string;
}

interface AxWindow {
	x: number;
	y: number;
	width: number;
	height: number;
	standard: boolean;
	status?: string;
}

type CaptureWindow = Pick<MirroringWindow, "x" | "y" | "width" | "height" | "windowId">;

export const selectMirroringWindow = (windows: AxWindow[], captures: CaptureWindow[]): MirroringWindow => {
	const standard = windows.find(w => w.standard);
	if (!standard) {
		throw new ActionableError("No standard iPhone Mirroring window. Open iPhone Mirroring and complete setup");
	}
	const capture = captures.find(w => w.x === standard.x && w.y === standard.y && w.width === standard.width && w.height === standard.height);
	if (!capture) {
		throw new ActionableError("Cannot match the iPhone Mirroring window to a screen capture. Check Screen Recording permission");
	}
	const status = standard.status || "Not connected. Connect the locked iPhone in iPhone Mirroring";
	return { x: standard.x, y: standard.y, width: standard.width, height: standard.height, windowId: capture.windowId, connected: status === "connected", status };
};

export const scrollDeltas = (direction: SwipeDirection, distance: number, natural: boolean) => {
	const sign = (direction === "up" || direction === "left" ? -1 : 1) * (natural ? -1 : 1);
	return { deltaX: direction === "left" || direction === "right" ? distance * sign : 0, deltaY: direction === "up" || direction === "down" ? distance * sign : 0 };
};

// JSON string literals keep user input out of the executable JXA source.
export const buildTextScript = (text: string): string => {
	const keyCodes = new Map([["\b", 51], ["\x7f", 117], ["\t", 48], ["\x1b", 53], ["\n", 36], ["\r", 36]]);
	const parts: string[] = ["const se = Application('System Events');", "const app = Application.currentApplication(); app.includeStandardAdditions = true;"];
	let segment = "";
	let isPaste = false;
	const flush = () => {
		if (segment) {
			parts.push(isPaste ? `app.setTheClipboardTo(${JSON.stringify(segment)}); delay(0.1); se.keystroke('v', {using:'command down'}); delay(0.1);` : `se.keystroke(${JSON.stringify(segment)});`);
			segment = "";
		}
	};
	for (const char of text) {
		const code = keyCodes.get(char);
		if (code !== undefined) {
			flush();
			parts.push(`se.keyCode(${code});`);
		} else {
			const paste = char.codePointAt(0)! > 126;
			if (paste !== isPaste) {
				flush();
			}
			isPaste = paste;
			segment += char;
		}
	}
	flush();
	return parts.join("\n");
};

export class MirroringClient {
	public async run(file: string, args: string[], input?: string): Promise<string> {
		if (process.platform !== "darwin") {
			throw new ActionableError("iPhone Mirroring requires macOS Sequoia 15 or later");
		}
		return new Promise((resolve, reject) => {
			const child = execFile(file, args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
				if (err) {
					reject(new ActionableError(`${file} failed: ${stderr.trim() || err.message}. Check Accessibility, Automation and Screen Recording permissions for the app hosting this server`));
				} else {
					resolve(stdout);
				}
			});
			if (input !== undefined) {
				child.stdin?.end(input);
			}
		});
	}

	public async jxa(script: string): Promise<string> {
		return this.run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script]);
	}

	public async window(): Promise<MirroringWindow> {
		const output = await this.jxa(`
ObjC.import('Cocoa'); ObjC.import('CoreGraphics');
const se = Application('System Events');
const processes = se.processes.whose({name:${JSON.stringify(appName)}})();
if (!processes.length) throw new Error('Open iPhone Mirroring and connect the locked iPhone first');
const p = processes[0];
let controlsEnabled = false;
try { controlsEnabled = p.menuBars[0].menuBarItems['View'].menus[0].menuItems['Home Screen'].enabled(); } catch (_) {}
function statusTexts(e, depth) {
  if (depth > 5) return [];
  let texts = [];
  try { if (e.role() === 'AXStaticText') texts.push(e.value() || e.name() || ''); } catch (_) {}
  try { e.uiElements().forEach(c => { texts = texts.concat(statusTexts(c, depth + 1)); }); } catch (_) {}
  return texts;
}
const windows = p.windows().map(w => {
  const pos = w.position(); const size = w.size(); const standard = w.subrole() === 'AXStandardWindow';
  return {x:pos[0], y:pos[1], width:size[0], height:size[1], standard,
    status:controlsEnabled ? 'connected' : (standard ? statusTexts(w, 0).join(' ') : '')};
});
const raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID);
const arr = ObjC.castRefToObject(raw); const captures = [];
for (let i = 0; i < arr.count; i++) {
  const w = ObjC.deepUnwrap(arr.objectAtIndex(i));
  if (w.kCGWindowOwnerPID === p.unixId() && w.kCGWindowLayer === 0) {
    const b = w.kCGWindowBounds;
    captures.push({x:b.X, y:b.Y, width:b.Width, height:b.Height, windowId:w.kCGWindowNumber});
  }
}
JSON.stringify({windows, captures});`);
		const { windows, captures } = JSON.parse(output);
		return selectMirroringWindow(windows, captures);
	}

	public async activate(): Promise<void> {
		await this.run("/usr/bin/osascript", ["-e", `tell application "${appName}" to activate\ndelay 0.2`]);
	}

	public async open(): Promise<void> {
		await this.run("/usr/bin/open", ["-a", appName]);
	}

	public async processCapture(buffer: Buffer, window: MirroringWindow, options: ScreenshotOptions = {}): Promise<Buffer> {
		let width = window.width;
		let height = window.height;
		if (options.maxSize !== undefined) {
			const ratio = Math.min(1, options.maxSize / Math.max(width, height));
			width = Math.max(1, Math.round(width * ratio));
			height = Math.max(1, Math.round(height * ratio));
		} else if (options.scale !== undefined) {
			width = Math.max(1, Math.round(width * options.scale));
			height = Math.max(1, Math.round(height * options.scale));
		}
		const pipeline = sharp(buffer).resize(width, height, { fit: "fill" });
		return options.format === "jpeg" ? pipeline.flatten({ background: "black" }).jpeg({ quality: options.quality ?? 75 }).toBuffer() : pipeline.png().toBuffer();
	}

	public async captureWindow(info: MirroringWindow, options: ScreenshotOptions = {}): Promise<Buffer> {
		const directory = await mkdtemp(join(tmpdir(), "mobile-mirroring-"));
		const filename = join(directory, "screen.png");
		try {
			await this.run("/usr/sbin/screencapture", ["-l", String(info.windowId), "-o", "-x", "-t", "png", filename]);
			return await this.processCapture(await readFile(filename), info, options);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}

	public async postClick(x: number, y: number, numTaps = 1, durationMs = 50): Promise<void> {
		await this.jxa(`
ObjC.import('CoreGraphics');
const point = $.CGPointMake(${x}, ${y});
for (let i = 0; i < ${numTaps}; i++) {
  const down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft);
  const up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft);
  $.CGEventSetIntegerValueField(down, $.kCGMouseEventClickState, i + 1);
  $.CGEventSetIntegerValueField(up, $.kCGMouseEventClickState, i + 1);
  $.CGEventPost($.kCGHIDEventTap, down); delay(${durationMs / 1000});
  $.CGEventPost($.kCGHIDEventTap, up); if (i + 1 < ${numTaps}) delay(0.1);
}`);
	}

	public async postDrag(startX: number, startY: number, endX: number, endY: number): Promise<void> {
		await this.jxa(`
ObjC.import('CoreGraphics');
const start = $.CGPointMake(${startX}, ${startY});
$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, start, $.kCGMouseButtonLeft));
for (let i = 1; i <= 10; i++) {
  const p = $.CGPointMake(${startX} + (${endX} - ${startX}) * i / 10, ${startY} + (${endY} - ${startY}) * i / 10);
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDragged, p, $.kCGMouseButtonLeft)); delay(0.05);
}
$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, $.CGPointMake(${endX}, ${endY}), $.kCGMouseButtonLeft));`);
	}

	public async scroll(x: number, y: number, direction: SwipeDirection, distance: number): Promise<void> {
		let natural = true;
		try {
			natural = (await this.run("/usr/bin/defaults", ["read", "-g", "com.apple.swipescrolldirection"])).trim() !== "0";
		} catch {
			// An absent preference means the macOS default, natural scrolling on.
		}
		const { deltaX, deltaY } = scrollDeltas(direction, Math.round(distance), natural);
		await this.jxa(`
ObjC.import('CoreGraphics');
$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, $.CGPointMake(${x}, ${y}), 0)); delay(0.05);
const totalX = ${deltaX}; const totalY = ${deltaY};
for (let i = 1; i <= 10; i++) {
  const dx = Math.round(totalX * i / 10) - Math.round(totalX * (i - 1) / 10);
  const dy = Math.round(totalY * i / 10) - Math.round(totalY * (i - 1) / 10);
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateScrollWheelEvent(null, 1, 2, dy, dx)); delay(0.05);
}`);
	}

	public async type(text: string): Promise<void> {
		await this.jxa(buildTextScript(text));
	}

	public async shortcut(key: string): Promise<void> {
		await this.jxa(`Application('System Events').keystroke(${JSON.stringify(key)}, {using:'command down'});`);
	}

	public async move(x: number, y: number): Promise<void> {
		await this.jxa(`const p = Application('System Events').processes[${JSON.stringify(appName)}]; p.windows().find(w => w.subrole() === 'AXStandardWindow').position = [${x}, ${y}];`);
	}

	public async resize(size: "larger" | "actual" | "smaller"): Promise<void> {
		const menu = { larger: "Larger", actual: "Actual Size", smaller: "Smaller" }[size];
		await this.jxa(`const p = Application('System Events').processes[${JSON.stringify(appName)}]; const item = p.menuBars[0].menuBarItems['View'].menus[0].menuItems[${JSON.stringify(menu)}]; if (!item.enabled()) throw new Error('Connect the iPhone before resizing'); item.click();`);
	}

	public async diagnostics() {
		const result: { platform: string; accessibility: boolean | null; screenRecording: boolean | null; window: MirroringWindow | null; error?: string } = { platform: process.platform, accessibility: null, screenRecording: null, window: null };
		try {
			result.accessibility = (await this.jxa("ObjC.import('Cocoa'); $.AXIsProcessTrusted();")).trim() === "true";
			result.window = await this.window();
			await this.captureWindow(result.window, { maxSize: 64 });
			result.screenRecording = true;
		} catch (err: any) {
			if (result.window) {
				result.screenRecording = false;
			}
			result.error = err.message;
		}
		return result;
	}
}
