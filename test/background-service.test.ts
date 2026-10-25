import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import ts from "typescript";

test.skip(process.platform !== "darwin", "iPhone Mirroring background integration requires macOS");

const root = path.resolve(__dirname, "..");
const fixture = () => {
	fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
	const directory = fs.mkdtempSync(path.join(root, "test-results", "background-"));
	fs.mkdirSync(path.join(directory, "lib"));
	for (const filename of fs.readdirSync(path.join(root, "src")).filter(name => name.endsWith(".ts"))) {
		const output = ts.transpileModule(fs.readFileSync(path.join(root, "src", filename), "utf8"), {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
		});
		fs.writeFileSync(path.join(directory, "lib", filename.replace(/\.ts$/, ".js")), output.outputText);
	}
	fs.copyFileSync(path.join(root, "package.json"), path.join(directory, "package.json"));
	return directory;
};
const run = (directory: string, action: string, port?: number) => {
	const output = execFileSync(
		process.execPath,
		[path.join(directory, "lib", "background.js"), action, ...(port === undefined ? [] : [String(port)])],
		{ cwd: directory, encoding: "utf8", env: { ...process.env, MOBILEMCP_DISABLE_TELEMETRY: "1" }, timeout: 20000 });
	return JSON.parse(output);
};
const freePort = async () => {
	const server = net.createServer();
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as net.AddressInfo).port;
	await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
	return port;
};

test("background server survives launcher exit, stays reachable, and stops cleanly", async () => {
	test.skip(process.env.MOBILEMCP_TEST_MIRRORING !== "1", "Opt in to opening and hiding the Mac's iPhone Mirroring app");
	const directory = fixture();
	const port = await freePort();
	try {
		const started = run(directory, "start", port);
		expect(started.running).toBe(true);
		expect(started.url).toBe(`http://127.0.0.1:${port}/mcp`);
		expect(started.mirroring).toMatchObject({ visible: false, frontmost: false });
		expect(run(directory, "status")).toMatchObject({ running: true, mcpReady: true, pid: started.pid });
		expect(run(directory, "start", port).pid).toBe(started.pid);
		expect(run(directory, "stop").running).toBe(false);
		expect(run(directory, "status").running).toBe(false);
	} finally {
		if (fs.existsSync(path.join(directory, "lib", "background.js"))) { run(directory, "stop"); }
	}
});

test("stale service state cannot stop another process", () => {
	const directory = fixture();
	fs.mkdirSync(path.join(directory, ".mobile-mcp"));
	fs.writeFileSync(path.join(directory, ".mobile-mcp", "state.json"), JSON.stringify({ pid: process.pid, port: 3000, node: process.execPath }));
	const result = run(directory, "stop");
	expect(result.running).toBe(false);
	expect(result.stale).toBe(true);
	expect(() => process.kill(process.pid, 0)).not.toThrow();
});
