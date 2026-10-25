import { ActionableError, Button, InstalledApp, Orientation, Robot, ScreenElement, ScreenSize, ScreenshotOptions, SwipeDirection } from "./robot";
import { MirroringClient, MirroringWindow } from "./mirroring-client";

export class IPhoneMirroringRobot implements Robot {
	public constructor(public readonly client = new MirroringClient()) {}

	public unsupported(operation: string): never {
		throw new ActionableError(`${operation} is not supported by iPhone Mirroring. Use a USB/WebDriverAgent device for device management, or mobile_take_screenshot and coordinate controls for visual navigation`);
	}

	public async ready(): Promise<MirroringWindow> {
		await this.client.activate();
		const info = await this.client.window();
		if (!info.connected) {
			throw new ActionableError(`iPhone Mirroring is disconnected: ${info.status}`);
		}
		return info;
	}

	public point(info: MirroringWindow, x: number, y: number) {
		if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= info.width || y >= info.height) {
			throw new ActionableError(`Coordinates (${x}, ${y}) are outside the ${info.width}x${info.height} Mirroring window. Take a fresh screenshot`);
		}
		return { x: info.x + x, y: info.y + y };
	}

	public async getScreenSize(): Promise<ScreenSize> {
		const info = await this.client.window();
		return { width: info.width, height: info.height, scale: 1 };
	}

	public async getScreenshot(options?: ScreenshotOptions): Promise<Buffer> {
		// Mirroring can be hidden when the client app occupies another Space.
		await this.client.activate();
		return this.client.captureWindow(await this.client.window(), options);
	}

	public async tap(x: number, y: number): Promise<void> {
		const point = this.point(await this.ready(), x, y);
		await this.client.postClick(point.x, point.y);
	}

	public async doubleTap(x: number, y: number): Promise<void> {
		const point = this.point(await this.ready(), x, y);
		await this.client.postClick(point.x, point.y, 2);
	}

	public async longPress(x: number, y: number, duration: number): Promise<void> {
		if (!Number.isFinite(duration) || duration < 0 || duration > 10000) {
			throw new ActionableError("Long press duration must be between 0 and 10000 milliseconds");
		}
		const point = this.point(await this.ready(), x, y);
		await this.client.postClick(point.x, point.y, 1, duration);
	}

	public async swipe(direction: SwipeDirection): Promise<void> {
		const info = await this.ready();
		const horizontal = direction === "left" || direction === "right";
		const distance = (horizontal ? info.width : info.height) * 0.5;
		const positive = direction === "down" || direction === "right";
		const x = horizontal ? info.width / 2 + (positive ? -1 : 1) * distance / 2 : info.width / 2;
		const y = horizontal ? info.height / 2 : info.height / 2 + (positive ? -1 : 1) * distance / 2;
		await this.swipeFromCoordinate(x, y, direction, distance);
	}

	public async swipeFromCoordinate(x: number, y: number, direction: SwipeDirection, distance?: number): Promise<void> {
		const info = await this.ready();
		const length = distance ?? (direction === "left" || direction === "right" ? info.width : info.height) / 2;
		if (!Number.isFinite(length) || length <= 0) {
			throw new ActionableError("Swipe distance must be positive");
		}
		const start = this.point(info, x, y);
		const endX = Math.max(1, Math.min(info.width - 1, x + (direction === "left" ? -length : direction === "right" ? length : 0)));
		const endY = Math.max(1, Math.min(info.height - 1, y + (direction === "up" ? -length : direction === "down" ? length : 0)));
		const end = this.point(info, endX, endY);
		await this.client.postDrag(start.x, start.y, end.x, end.y);
	}

	public async scroll(x: number, y: number, direction: SwipeDirection, distance: number): Promise<void> {
		const point = this.point(await this.ready(), x, y);
		await this.client.scroll(point.x, point.y, direction, distance);
	}

	public async sendKeys(text: string): Promise<void> {
		await this.ready();
		await this.client.type(text);
	}

	public async pressButton(button: Button | "APP_SWITCH" | "SPOTLIGHT" | "BACKSPACE"): Promise<void> {
		await this.ready();
		const shortcuts: Record<string, string> = { HOME: "1", APP_SWITCH: "2", SPOTLIGHT: "3" };
		if (shortcuts[button]) {
			await this.client.shortcut(shortcuts[button]);
		} else if (button === "ENTER" || button === "BACKSPACE") {
			await this.client.type(button === "ENTER" ? "\n" : "\b");
		} else {
			this.unsupported(`Button ${button}`);
		}
	}

	public async searchApps(query: string): Promise<void> {
		await this.ready();
		await this.client.shortcut("3");
		// Spotlight animates before its search field accepts keyboard input.
		await new Promise(resolve => setTimeout(resolve, 500));
		await this.client.shortcut("a");
		await this.client.type(query);
	}

	public async getClipboard(): Promise<string> {
		return this.client.run("/usr/bin/pbpaste", []);
	}

	public async setClipboard(text: string): Promise<void> {
		await this.client.run("/usr/bin/pbcopy", [], text);
	}

	public async listApps(): Promise<InstalledApp[]> { return this.unsupported("App enumeration"); }
	public async launchApp(packageName: string): Promise<void> { throw new ActionableError("Use mobile_mirroring_search_apps with the app display name, inspect its screenshot, then mobile_mirroring_launch_app at the chosen result coordinates. Bundle-id launch is not supported by iPhone Mirroring"); }
	public async terminateApp(packageName: string): Promise<void> { return this.unsupported("App termination"); }
	public async installApp(path: string): Promise<void> { return this.unsupported("App installation"); }
	public async uninstallApp(bundleId: string): Promise<void> { return this.unsupported("App uninstallation"); }
	public async openUrl(url: string): Promise<void> { return this.unsupported("Direct URL opening"); }
	public async getElementsOnScreen(): Promise<ScreenElement[]> { return this.unsupported("iOS accessibility queries; use mobile_take_screenshot"); }
	public async setOrientation(orientation: Orientation): Promise<void> { return this.unsupported("Changing physical orientation"); }
	public async getOrientation(): Promise<Orientation> {
		const info = await this.client.window();
		if (!info.connected) {
			throw new ActionableError(`iPhone Mirroring is disconnected: ${info.status}`);
		}
		return info.width > info.height ? "landscape" : "portrait";
	}
}
