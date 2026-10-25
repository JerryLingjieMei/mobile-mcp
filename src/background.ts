#!/usr/bin/env node
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

type State = { pid: number; port: number; node: string };
const root = path.resolve(__dirname, "..");
const directory = path.join(root, ".mobile-mcp");
const statePath = path.join(directory, "state.json");
const logPath = path.join(directory, "server.log");
const serverPath = path.join(__dirname, "index.js");
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const readState = (): State | undefined => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : undefined;
const ownsProcess = (state: State): boolean => {
	try {
		const command = execFileSync("/bin/ps", ["-ww", "-p", String(state.pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return command === `${state.node} ${serverPath} --listen 127.0.0.1:${state.port}`;
	} catch {
		return false;
	}
};
const urlFor = (state: State) => `http://127.0.0.1:${state.port}/mcp`;
const withClient = async <T>(state: State, action: (client: Client) => Promise<T>): Promise<T> => {
	const client = new Client({ name: "mobile-mcp-background", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(urlFor(state)), {
		requestInit: {
			headers: process.env.MOBILEMCP_AUTH ? { Authorization: `Bearer ${process.env.MOBILEMCP_AUTH}` } : {},
			signal: AbortSignal.timeout(3000),
		},
	});
	try {
		await client.connect(transport);
		return await action(client);
	} finally {
		await client.close();
	}
};
const status = async (state?: State) => {
	if (!state || !ownsProcess(state)) {
		return { running: false, stale: !!state };
	}
	let mcpReady = false;
	try {
		await withClient(state, client => client.listTools());
		mcpReady = true;
	} catch { /* Report a live process separately from MCP readiness. */ }
	return { running: true, mcpReady, pid: state.pid, url: urlFor(state), logPath };
};
const start = async (existing: State | undefined, port: number) => {
	let state = existing;
	if (!state || !ownsProcess(state)) {
		const probe = net.createServer();
		await new Promise<void>((resolve, reject) => {
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", resolve);
		});
		await new Promise<void>((resolve, reject) => probe.close(err => err ? reject(err) : resolve()));
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const log = fs.openSync(logPath, "a", 0o600);
		try {
			const child = spawn(process.execPath, [serverPath, "--listen", `127.0.0.1:${port}`], {
				cwd: root,
				env: { ...process.env, MOBILEMCP_IPHONE_MIRRORING: "1" },
				detached: true,
				stdio: ["ignore", log, log],
			});
			await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
			state = { pid: child.pid!, port, node: process.execPath };
			fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
			child.unref();
		} finally {
			fs.closeSync(log);
		}
	} else if (state.port !== port) {
		throw new Error(`Already running on port ${state.port}. Stop it before changing ports.`);
	}
	const deadline = Date.now() + 10000;
	while (!(await status(state)).mcpReady) {
		if (!ownsProcess(state) || Date.now() >= deadline) {
			throw new Error(`Background server did not become ready. Check ${logPath}`);
		}
		await pause();
	}
	const mirroring = await withClient(state, async client => {
		for (const action of ["open", "background"]) {
			const result = await client.callTool({ name: "mobile_mirroring_control", arguments: { action } });
			const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
			if (result.isError) { throw new Error(`Server is running; Mirroring ${action} failed: ${text}`); }
			if (action === "background") { return JSON.parse(text); }
		}
	});
	return { ...await status(state), mirroring };
};
const stop = async (state?: State) => {
	if (!state || !ownsProcess(state)) {
		fs.rmSync(statePath, { force: true });
		return { running: false, stale: !!state };
	}
	process.kill(state.pid, "SIGTERM");
	const deadline = Date.now() + 5000;
	while (ownsProcess(state)) {
		if (Date.now() >= deadline) { throw new Error(`Process ${state.pid} has not stopped.`); }
		await pause();
	}
	fs.rmSync(statePath, { force: true });
	return { running: false };
};
const main = async () => {
	if (process.platform !== "darwin") { throw new Error("Background iPhone Mirroring requires macOS."); }
	const [action, rawPort = "3000", ...extra] = process.argv.slice(2);
	if (!["start", "status", "stop"].includes(action) || extra.length || (action !== "start" && process.argv.length > 3)) {
		throw new Error("Usage: node lib/background.js start [port] | status | stop");
	}
	const port = Number(rawPort);
	if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new Error("Port must be an integer from 1 to 65535."); }
	const state = readState();
	const result = action === "start" ? await start(state, port) : action === "stop" ? await stop(state) : await status(state);
	console.log(JSON.stringify(result, null, 2));
};
main().catch(err => {
	console.error(err.message);
	process.exitCode = 1;
});
