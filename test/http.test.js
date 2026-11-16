import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { AffinityBridge } from "../dist/bridge.js";
import { assertBindIsSafe, isLoopback, startHttpServer } from "../dist/http.js";
import { McpServerCore } from "../dist/mcp.js";
import { FAKE_TOOLS, startFakeAffinity } from "./fake-affinity.js";

let fake;
/** The remote-client setup: bearer token required. */
let secured;
/** The default `--http` setup: loopback, no token. */
let open;
const token = "test-token";

const start = async (serverToken) => {
  const bridge = new AffinityBridge({ url: fake.url, timeoutMs: 2000 });
  const server = await startHttpServer(new McpServerCore(bridge), {
    host: "127.0.0.1",
    port: 0,
    token: serverToken,
    upstreamUrl: fake.url,
  });
  return { server, bridge, base: `http://127.0.0.1:${server.address().port}` };
};

before(async () => {
  fake = await startFakeAffinity();
  secured = await start(token);
  open = await start(undefined);
});

after(async () => {
  for (const { server, bridge } of [secured, open]) {
    await new Promise((resolve) => server.close(resolve));
    bridge.close();
  }
  await fake.close();
});

const post = (body, headers = {}) =>
  fetch(`${secured.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });

const runScript = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "execute_script", arguments: { script: "console.log('from a web page')" } },
};

test("rejects requests without the bearer token", async () => {
  const response = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "" });
  assert.equal(response.status, 401);
});

test("serves initialize and tools/list over HTTP", async () => {
  const initialized = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25" },
  });
  assert.equal(initialized.status, 200);
  const initBody = await initialized.json();
  assert.equal(initBody.result.serverInfo.name, "pi-affinity-mcp");

  const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const listBody = await listed.json();
  assert.equal(listBody.result.tools.length, FAKE_TOOLS.length);
});

test("a web page on another origin cannot run a script", async () => {
  fake.state.calls.length = 0;
  // What any page can send without a CORS preflight.
  const response = await fetch(`${open.base}/mcp`, {
    method: "POST",
    headers: { origin: "https://evil.example", "content-type": "text/plain" },
    body: JSON.stringify(runScript),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(fake.state.calls, []);
});

test("a page served from this machine can call", async () => {
  const response = await fetch(`${open.base}/mcp`, {
    method: "POST",
    headers: { origin: "http://localhost:5173", "content-type": "application/json" },
    body: JSON.stringify(runScript),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.isError, false);
});

test("notifications are accepted without a body", async () => {
  const response = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(response.status, 202);
});

test("a broken body is a 400 parse error", async () => {
  const response = await fetch(`${secured.base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: "{not json",
  });
  assert.equal(response.status, 400);
});

test("GET is refused because there is no server-initiated stream", async () => {
  const response = await fetch(`${secured.base}/mcp`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

test("healthz is public and names the upstream", async () => {
  const response = await fetch(`${secured.base}/healthz`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.upstream, fake.url);
});

test("binding beyond loopback requires a token", () => {
  assert.throws(() => assertBindIsSafe("0.0.0.0", undefined), /refusing to listen/);
  assert.doesNotThrow(() => assertBindIsSafe("0.0.0.0", token));
  assert.doesNotThrow(() => assertBindIsSafe("127.0.0.1", undefined));
  assert.equal(isLoopback("::1"), true);
});
