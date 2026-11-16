import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";

import { startFakeAffinity } from "./fake-affinity.js";

let fake;

before(async () => {
  fake = await startFakeAffinity();
});

after(async () => {
  await fake.close();
});

/** Runs the real binary over stdio, the way an MCP client does. */
function runCli(args) {
  const child = spawn(process.execPath, ["dist/cli.js", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const responses = [];
  lines.on("line", (line) => {
    if (line.trim()) responses.push(JSON.parse(line));
  });
  const stderr = [];
  createInterface({ input: child.stderr }).on("line", (line) => stderr.push(line));
  let exitCode = null;
  child.on("exit", (code) => {
    exitCode = code;
  });
  return {
    child,
    responses,
    stderr,
    exitCode: () => exitCode,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    waitFor: async (count, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (responses.length < count) {
        if (Date.now() > deadline || exitCode !== null) {
          throw new Error(
            `got ${responses.length}/${count} responses, exit code ${exitCode}; stderr: ${stderr.join(" | ")}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
}

const initialize = (run) => {
  run.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  run.send({ jsonrpc: "2.0", method: "notifications/initialized" });
};

test("the stdio server answers initialize and a gated tool call", async () => {
  const run = runCli(["--url", fake.url, "--timeout", "5"]);
  try {
    initialize(run);
    await run.waitFor(1);
    assert.equal(run.responses[0].result.serverInfo.name, "pi-affinity-mcp");

    run.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "execute_script", arguments: { script: "1" } },
    });
    await run.waitFor(2);
    const call = run.responses[1];
    assert.equal(call.id, 2);
    assert.match(call.result.content[0].text, /Affinity fake/);
  } finally {
    run.child.kill();
  }
});

test("an upstream JSON-RPC error is answered and the server keeps serving", async () => {
  const run = runCli(["--url", fake.url, "--timeout", "5"]);
  try {
    initialize(run);
    run.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "no_such_tool", arguments: {} },
    });
    run.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_library_scripts", arguments: {} },
    });
    await run.waitFor(3);
    assert.deepEqual(run.responses[1].error, { code: -32602, message: "Tool not found: no_such_tool" });
    assert.equal(run.responses[2].result.isError, false);
    assert.equal(run.exitCode(), null);
  } finally {
    run.child.kill();
  }
});

test("the stdio server tells the client when Affinity comes back with different tools", async () => {
  const run = runCli(["--url", fake.url, "--timeout", "5"]);
  try {
    initialize(run);
    await run.waitFor(1);
    assert.equal(run.responses[0].result.capabilities.tools.listChanged, true);
    run.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await run.waitFor(2);

    fake.state.tools = [...fake.state.tools, { name: "new_tool", inputSchema: { type: "object" } }];
    fake.closeStreams();
    await new Promise((resolve) => setTimeout(resolve, 50));
    run.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_library_scripts", arguments: {} },
    });
    await run.waitFor(4);
    assert.deepEqual(run.responses[2], { jsonrpc: "2.0", method: "notifications/tools/list_changed" });

    run.send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    await run.waitFor(5);
    assert.ok(run.responses[4].result.tools.some((tool) => tool.name === "new_tool"));
  } finally {
    run.child.kill();
    fake.state.tools = fake.state.tools.filter((tool) => tool.name !== "new_tool");
  }
});

test("an Affinity that moved to another protocol version is reported as a failed call", async () => {
  fake.state.protocolVersion = "2099-01-01";
  const run = runCli(["--url", fake.url, "--timeout", "5"]);
  try {
    initialize(run);
    run.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "execute_script", arguments: { script: "1" } },
    });
    await run.waitFor(2);
    const call = run.responses[1];
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /refused the handshake: Unsupported protocol version.*2099-01-01/);
  } finally {
    run.child.kill();
    fake.state.protocolVersion = "2025-11-25";
  }
});

test("--dump-docs writes every topic, including those listed before the preamble", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-affinity-mcp-docs-"));
  try {
    const child = spawn(process.execPath, ["dist/cli.js", "--url", fake.url, "--dump-docs", dir]);
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
    assert.equal(
      await readFile(join(dir, "sdk-docs", "application.js.md"), "utf8"),
      "documentation for application.js\n",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--version and --help exit without touching the app", async () => {
  const run = async (flag) => {
    const child = spawn(process.execPath, ["dist/cli.js", flag]);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    const code = await new Promise((resolve) => child.on("close", resolve));
    return { code, output };
  };

  const version = await run("--version");
  assert.equal(version.code, 0);
  assert.match(version.output, /^\d+\.\d+\.\d+/);

  const help = await run("--help");
  assert.equal(help.code, 0);
  assert.match(help.output, /pi-affinity-mcp/);
});
