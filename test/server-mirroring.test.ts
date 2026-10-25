import { expect, test } from "@playwright/test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import sharp from "sharp";
import { createMcpServer } from "../src/server";
import { MirroringClient } from "../src/mirroring-client";

const originalWindow = MirroringClient.prototype.window;
const originalCapture = MirroringClient.prototype.captureWindow;
const originalActivate = MirroringClient.prototype.activate;
const previous = { ...process.env };

test.beforeEach(() => {
	process.env.MOBILEMCP_DISABLE_TELEMETRY = "1";
	process.env.MOBILEMCP_IPHONE_MIRRORING = "1";
	process.env.MOBILECLI_PATH = "/no-such-mobilecli";
	MirroringClient.prototype.window = async () => ({ x: 100, y: 200, width: 320, height: 700, windowId: 42, connected: true, status: "connected" });
	MirroringClient.prototype.captureWindow = async () => sharp({ create: { width: 320, height: 700, channels: 3, background: "red" } }).png().toBuffer();
	MirroringClient.prototype.activate = async () => {};
});

test.afterEach(() => {
	MirroringClient.prototype.window = originalWindow;
	MirroringClient.prototype.captureWindow = originalCapture;
	MirroringClient.prototype.activate = originalActivate;
	for (const name of ["MOBILEMCP_DISABLE_TELEMETRY", "MOBILEMCP_IPHONE_MIRRORING", "MOBILECLI_PATH"]) {
		if (previous[name] === undefined) { delete process.env[name]; } else { process.env[name] = previous[name]; }
	}
});

const withClient = async (action: (client: Client) => Promise<void>) => {
	const server = createMcpServer();
	const client = new Client({ name: "mirroring-test", version: "1.0" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(b);
	await client.connect(a);
	try { await action(client); } finally { await client.close(); await server.close(); }
};

test("discovers the mirror and takes screenshots without mobilecli", async () => {
	await withClient(async client => {
		const result: any = await client.callTool({ name: "mobile_list_available_devices", arguments: {} });
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(result.content[0].text).devices).toContainEqual(expect.objectContaining({ id: "iphone-mirroring", platform: "ios", state: "online" }));
		const screen: any = await client.callTool({ name: "mobile_take_screenshot", arguments: { device: "iphone-mirroring" } });
		expect(screen.isError).not.toBe(true);
		expect(screen.content.some((c: any) => c.type === "image")).toBe(true);
	});
});

test("keeps offline mirror visible with useful status and never suggests cloud setup", async () => {
	MirroringClient.prototype.window = async () => { throw new Error("Open iPhone Mirroring first"); };
	await withClient(async client => {
		const result: any = await client.callTool({ name: "mobile_list_available_devices", arguments: {} });
		const data = JSON.parse(result.content[0].text);
		expect(data.devices[0]).toMatchObject({ id: "iphone-mirroring", state: "offline" });
		expect(data.devices[0].status).toContain("Open iPhone Mirroring");
		expect(data.hint || "").not.toContain("cloud");
	});
});

test("rejects mobilecli-only actions on a mirror with capability errors", async () => {
	await withClient(async client => {
		for (const [name, args] of [
			["mobile_list_crashes", {}], ["mobile_get_crash", { id: "x" }], ["mobile_start_screen_recording", {}],
		] as const) {
			const result: any = await client.callTool({ name, arguments: { device: "iphone-mirroring", ...args } });
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("not supported by iPhone Mirroring");
		}
	});
});

test("advertises visual app search and launch tools with explicit schemas", async () => {
	await withClient(async client => {
		const { tools } = await client.listTools();
		const search = tools.find(t => t.name === "mobile_mirroring_search_apps");
		const launch = tools.find(t => t.name === "mobile_mirroring_launch_app");
		expect(search?.inputSchema.properties).toHaveProperty("query");
		expect(launch?.inputSchema.required).toEqual(expect.arrayContaining(["x", "y"]));
		expect(launch?.description).toContain("screenshot");
		expect(search?.annotations?.readOnlyHint).toBe(false);
	});
});

test("app search returns the visible results without blindly submitting the top hit", async () => {
	const originalRun = MirroringClient.prototype.run;
	let query = "";
	let spotlight = false;
	let selected = false;
	let launches = 0;
	const se = {
		keystroke: (value: string, options?: { using: string }) => {
			if (options?.using === "command down") {
				if (value === "3") { spotlight = true; }
				if (value === "a") { selected = true; }
			} else {
				query = selected ? value : query + value;
				selected = false;
			}
		},
		keyCode: (code: number) => { if (code === 36) { launches++; } },
	};
	MirroringClient.prototype.run = async (file, args) => {
		const script = args[args.length - 1];
		const vm = await import("node:vm");
		vm.runInNewContext(script, { Application: Object.assign(() => se, { currentApplication: () => ({ includeStandardAdditions: false }) }), delay: () => {} });
		return "";
	};
	try {
		await withClient(async client => {
			const result: any = await client.callTool({ name: "mobile_mirroring_search_apps", arguments: { query: "Calculator" } });
			expect(result.isError).not.toBe(true);
			expect(result.content.some((c: any) => c.type === "image")).toBe(true);
			expect(spotlight).toBe(true);
			expect(query).toBe("Calculator");
			expect(launches).toBe(0);
			const bad: any = await client.callTool({ name: "mobile_mirroring_search_apps", arguments: { query: "Calculator\n" } });
			// Trailing whitespace is harmlessly trimmed; internal control keys must fail.
			expect(bad.isError).not.toBe(true);
			const rejected: any = await client.callTool({ name: "mobile_mirroring_search_apps", arguments: { query: "Calc\nulator" } });
			expect(rejected.isError).toBe(true);
			expect(rejected.content[0].text).toContain("control keys");
		});
	} finally {
		MirroringClient.prototype.run = originalRun;
	}
});

test("background control hides Mirroring without focusing or inspecting its hidden window", async () => {
	const prototype = MirroringClient.prototype as any;
	const previousBackground = prototype.background;
	prototype.background = async () => ({ processId: 42, visible: false, frontmost: false });
	MirroringClient.prototype.window = async () => { throw new Error("Hidden window must not be queried"); };
	try {
		await withClient(async client => {
			const result: any = await client.callTool({ name: "mobile_mirroring_control", arguments: { action: "background" } });
			expect(result.isError).not.toBe(true);
			expect(JSON.parse(result.content[0].text)).toMatchObject({ action: "background", processId: 42, visible: false, frontmost: false });
		});
	} finally {
		if (previousBackground === undefined) { delete prototype.background; } else { prototype.background = previousBackground; }
	}
});
