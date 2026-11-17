import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { AffinityBridge } from "../dist/bridge.js";
import { FAKE_DOCUMENT, FAKE_TOOLS, startFakeAffinity } from "./fake-affinity.js";

let fake;

before(async () => {
  fake = await startFakeAffinity();
});

beforeEach(() => {
  fake.state.calls.length = 0;
  fake.state.documents = [];
  fake.state.onScript = () => {};
});

after(async () => {
  await fake.close();
});

const withBridge = async (options, run) => {
  const bridge = new AffinityBridge({ url: fake.url, timeoutMs: 2000, ...options });
  try {
    return await run(bridge);
  } finally {
    bridge.close();
  }
};

test("primes the preamble before a script runs", async () => {
  await withBridge({}, async (bridge) => {
    const result = await bridge.callTool("execute_script", { script: "console.log(1)" });
    assert.equal(result.isError, false);
    assert.deepEqual(fake.state.calls, ["read_sdk_documentation_topic(preamble)", "execute_script"]);
  });
});

test("primes the preamble before the first documentation topic read", async () => {
  await withBridge({}, async (bridge) => {
    const result = await bridge.callTool("read_sdk_documentation_topic", { filename: "document.js" });
    assert.equal(result.content[0].text, "documentation for document.js");
    assert.deepEqual(fake.state.calls, [
      "read_sdk_documentation_topic(preamble)",
      "read_sdk_documentation_topic(document.js)",
    ]);
  });
});

test("a client reading the preamble itself is not primed twice", async () => {
  await withBridge({}, async (bridge) => {
    await bridge.callTool("read_sdk_documentation_topic", { filename: "preamble" });
    assert.deepEqual(fake.state.calls, ["read_sdk_documentation_topic(preamble)"]);
  });
});

test("a script refused mid-session is re-primed and retried once", async () => {
  await withBridge({}, async (bridge) => {
    await bridge.callTool("execute_script", { script: "1" });
    fake.forgetPriming();
    fake.state.calls.length = 0;

    const result = await bridge.callTool("execute_script", { script: "2" });
    assert.equal(result.isError, false);
    assert.deepEqual(fake.state.calls, [
      "execute_script",
      "read_sdk_documentation_topic(preamble)",
      "execute_script",
    ]);
  });
});

test("a topic read refused mid-session is re-primed and retried once", async () => {
  await withBridge({}, async (bridge) => {
    await bridge.callTool("execute_script", { script: "1" });
    fake.forgetPriming();

    const result = await bridge.callTool("read_sdk_documentation_topic", { filename: "shapes.js" });
    assert.equal(result.content[0].text, "documentation for shapes.js");
  });
});

test("tools/list is fetched once per bridge", async () => {
  const before = fake.state.toolsListCalls;
  await withBridge({}, async (bridge) => {
    const [first, second] = [await bridge.listTools(), await bridge.listTools()];
    assert.equal(first.length, FAKE_TOOLS.length);
    assert.deepEqual(first, second);
    assert.equal(fake.state.toolsListCalls - before, 1);
  });
});

test("a read-only call that times out is retried once on a fresh session", async () => {
  const connectionsBefore = fake.state.connections;
  await withBridge({ timeoutMs: 300 }, async (bridge) => {
    fake.state.stall.list_library_scripts = 1;
    const result = await bridge.callTool("list_library_scripts", {});
    assert.equal(result.isError, false);
    assert.equal(fake.state.connections - connectionsBefore, 2);
  });
});

test("a script that times out is never sent twice", async () => {
  await withBridge({ timeoutMs: 300 }, async (bridge) => {
    await bridge.callTool("execute_script", { script: "warm up" });
    const executionsBefore = fake.state.executions;
    fake.state.stall.execute_script = 1;

    await assert.rejects(
      bridge.callTool("execute_script", { script: "slow, adds a node" }),
      /may still be running/,
    );
    assert.equal(fake.state.executions - executionsBefore, 1);

    const next = await bridge.callTool("execute_script", { script: "next" });
    assert.equal(next.isError, false);
  });
});

test("after Affinity restarts, the next call opens a new session at once", async () => {
  await withBridge({ timeoutMs: 5000 }, async (bridge) => {
    await bridge.callTool("list_library_scripts", {});
    fake.closeStreams();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const deadPostsBefore = fake.state.deadPosts;
    const result = await bridge.callTool("list_library_scripts", {});
    assert.equal(result.isError, false);
    assert.equal(fake.state.deadPosts - deadPostsBefore, 0);
  });
});

const NEW_TOOL = { name: "new_tool", description: "Added by an app update.", inputSchema: { type: "object" } };

test("after a restart with new tools, the bridge serves them and announces the change", async () => {
  await withBridge({}, async (bridge) => {
    let changes = 0;
    bridge.on("toolsChanged", () => {
      changes += 1;
    });
    await bridge.listTools();
    fake.state.tools = [...FAKE_TOOLS, NEW_TOOL];
    fake.closeStreams();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await bridge.callTool("list_library_scripts", {});
    assert.equal(changes, 1);
    assert.deepEqual(
      (await bridge.listTools()).map((tool) => tool.name),
      [...FAKE_TOOLS, NEW_TOOL].map((tool) => tool.name),
    );
  });
  fake.state.tools = [...FAKE_TOOLS];
});

test("after a restart with the same tools, nothing is announced", async () => {
  await withBridge({}, async (bridge) => {
    let changes = 0;
    bridge.on("toolsChanged", () => {
      changes += 1;
    });
    await bridge.listTools();
    fake.closeStreams();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await bridge.callTool("list_library_scripts", {});
    assert.equal(changes, 0);
  });
});

test("a refused preamble read reconnects once and then works", async () => {
  const connectionsBefore = fake.state.connections;
  await withBridge({}, async (bridge) => {
    fake.state.failPrimingOnce = 1;
    const result = await bridge.callTool("execute_script", { script: "4" });
    assert.equal(result.isError, false);
    assert.equal(fake.state.connections - connectionsBefore, 2);
  });
});

test("image results survive the round trip", async () => {
  await withBridge({}, async (bridge) => {
    const result = await bridge.callTool("render_spread", {
      document_session_uuid: FAKE_DOCUMENT,
      spread_index: 0,
    });
    const image = result.content.find((item) => item.type === "image");
    assert.equal(image.mimeType, "image/jpeg");
  });
});

const script = (source) => ["execute_script", { script: source }];

test("closes the documents its scripts opened, and no document a person opened", async () => {
  fake.state.documents = ["PERSON-BEFORE"];
  await withBridge({ ownDocuments: true }, async (bridge) => {
    fake.state.onScript = () => fake.state.documents.push("AGENT-1");
    await bridge.callTool(...script("open a document"));
    fake.state.documents.push("PERSON-BETWEEN");
    fake.state.onScript = () => fake.state.documents.push("AGENT-2");
    await bridge.callTool(...script("open another"));

    assert.deepEqual((await bridge.closeDocuments()).sort(), ["AGENT-1", "AGENT-2"]);
    assert.deepEqual(fake.state.documents, ["PERSON-BEFORE", "PERSON-BETWEEN"]);
  });
});

test("a document its script closed itself is not closed again", async () => {
  await withBridge({ ownDocuments: true }, async (bridge) => {
    fake.state.onScript = () => fake.state.documents.push("AGENT-1");
    await bridge.callTool(...script("open"));
    fake.state.onScript = () => fake.state.documents.pop();
    await bridge.callTool(...script("close it"));
    assert.deepEqual(await bridge.closeDocuments(), []);
  });
});

test("a document opened by a script that never answered is still closed", async () => {
  await withBridge({ ownDocuments: true, timeoutMs: 300 }, async (bridge) => {
    await bridge.callTool(...script("warm up"));
    // The script runs in the app and opens its document; its answer never arrives.
    fake.state.onScript = () => {
      fake.state.documents.push("AGENT-LATE");
      fake.state.stall.execute_script = 1;
    };
    await assert.rejects(bridge.callTool(...script("opens, then hangs")), /did not answer/);
    assert.deepEqual(await bridge.closeDocuments(), ["AGENT-LATE"]);
    assert.deepEqual(fake.state.documents, []);
  });
});

test("without ownDocuments nothing is tracked or closed", async () => {
  await withBridge({}, async (bridge) => {
    fake.state.onScript = () => fake.state.documents.push("SOMEONE");
    await bridge.callTool(...script("open"));
    assert.equal(fake.state.executions > 0, true);
    assert.deepEqual(await bridge.closeDocuments(), []);
    assert.deepEqual(fake.state.documents, ["SOMEONE"]);
  });
});
