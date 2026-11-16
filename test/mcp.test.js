import assert from "node:assert/strict";
import { test } from "node:test";

import { AffinityRpcError } from "../dist/client.js";
import { McpServerCore } from "../dist/mcp.js";

const stubBridge = (overrides = {}) => ({
  listTools: async () => [{ name: "execute_script" }],
  callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
  close() {},
  ...overrides,
});

test("initialize echoes a protocol version we support and advertises our own", async () => {
  const core = new McpServerCore(stubBridge());
  const echoed = await core.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  assert.equal(echoed.result.protocolVersion, "2025-06-18");

  const fallback = await core.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "1.0.0-unknown" },
  });
  assert.equal(fallback.result.protocolVersion, "2025-11-25");
  assert.equal(fallback.result.serverInfo.name, "pi-affinity-mcp");
});

test("notifications never get a response", async () => {
  const core = new McpServerCore(stubBridge());
  const response = await core.handle({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(response, null);
});

test("ping is answered", async () => {
  const core = new McpServerCore(stubBridge());
  assert.deepEqual((await core.handle({ jsonrpc: "2.0", id: 1, method: "ping" })).result, {});
});

test("resources and prompts are not offered, as in Affinity", async () => {
  const core = new McpServerCore(stubBridge());
  for (const method of ["resources/list", "prompts/list"]) {
    const response = await core.handle({ jsonrpc: "2.0", id: 1, method });
    assert.equal(response.error.code, -32601);
  }
});

test("tool-list changes are advertised only where they can be sent", async () => {
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } };
  const stdio = await new McpServerCore(stubBridge(), { listChanged: true }).handle(initialize);
  const http = await new McpServerCore(stubBridge(), { listChanged: false }).handle(initialize);
  assert.equal(stdio.result.capabilities.tools.listChanged, true);
  assert.equal(http.result.capabilities.tools.listChanged, false);
});

test("unknown methods are method-not-found", async () => {
  const core = new McpServerCore(stubBridge());
  const response = await core.handle({ jsonrpc: "2.0", id: 1, method: "tools/create" });
  assert.equal(response.error.code, -32601);
});

test("tools/call without a name is invalid params", async () => {
  const core = new McpServerCore(stubBridge());
  const response = await core.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
  assert.equal(response.error.code, -32602);
});

const callScript = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_script", arguments: { script: "1" } } };

test("a failed call is a tool result the model can read", async () => {
  const core = new McpServerCore(
    stubBridge({
      callTool: async () => {
        throw new Error("execute_script did not answer within 60s. It may still be running");
      },
    }),
  );
  const response = await core.handle(callScript);
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /may still be running/);
});

test("Affinity's own protocol errors pass through unchanged", async () => {
  const core = new McpServerCore(
    stubBridge({
      callTool: async () => {
        throw new AffinityRpcError(-32602, "Tool not found: no_such_tool");
      },
    }),
  );
  const response = await core.handle(callScript);
  assert.equal(response.error.code, -32602);
  assert.equal(response.error.message, "Tool not found: no_such_tool");
});

test("batches return one response per request and drop notifications", async () => {
  const core = new McpServerCore(stubBridge());
  const responses = await core.handleMany([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  assert.deepEqual(
    responses.map((response) => response.id),
    [1, 2],
  );
});
