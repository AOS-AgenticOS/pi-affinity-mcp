import assert from "node:assert/strict";
import { test } from "node:test";

import { AffinityClient, AffinityError, flatten } from "../dist/client.js";
import { startFakeAffinity } from "./fake-affinity.js";

test("flatten joins text, summarises images and keeps structured output", () => {
  const text = flatten({
    content: [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
      { type: "image", mimeType: "image/jpeg", data: "AAAAAA" },
    ],
    structuredContent: { ok: true },
  });
  assert.match(text, /first\nsecond/);
  assert.match(text, /<image content, 6 b64 chars>/);
  assert.match(text, /"ok": true/);
});

test("flatten tolerates empty and undefined results", () => {
  assert.equal(flatten(undefined), "");
  assert.equal(flatten({}), "");
});

test("a stream that ends before the endpoint event fails at once", async () => {
  const fake = await startFakeAffinity();
  try {
    fake.state.dropNextStreams = 1;
    const client = new AffinityClient({ url: fake.url, timeoutMs: 3000 });
    await assert.rejects(
      () => client.connect(),
      (error) => error instanceof AffinityError && /closed before the endpoint event/.test(error.message),
    );
  } finally {
    await fake.close();
  }
});

test("connecting to a dead endpoint explains the likely cause", async () => {
  const client = new AffinityClient({ url: "http://127.0.0.1:1/sse", timeoutMs: 500 });
  await assert.rejects(
    () => client.connect(),
    (error) => error instanceof AffinityError && /Is Affinity running/.test(error.message),
  );
});
