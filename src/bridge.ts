/**
 * The bridge: one long-lived Affinity session, shared by every downstream call.
 *
 * Responsibilities, in the order they matter:
 *  - keep exactly one upstream SSE session (Affinity allows a single stream per session),
 *  - prime the SDK documentation gate before gated tools, transparently,
 *  - re-prime and retry once when the gate trips anyway,
 *  - open a new session when the stream ends (Affinity quit or restarted),
 *  - re-read the tool list on every new session and emit `toolsChanged` when it differs,
 *  - on timeout, drop the session; re-send the call once only if it is read-only,
 *  - serialise calls, because the upstream session is a single request/response channel,
 *  - with `ownDocuments`, know which documents its scripts opened, to close exactly those when it stops.
 */

import { EventEmitter } from "node:events";

import { AffinityClient, AffinityError, AffinityTimeoutError, flatten } from "./client.js";
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_URL,
  GATE_REFUSAL,
  GATED_TOOLS,
  PREAMBLE_TOOL,
  PREAMBLE_TOPIC,
  READ_ONLY_TOOLS,
} from "./protocol.js";

const isGateRefusal = (result: Record<string, unknown>): boolean =>
  GATE_REFUSAL.test(flatten(result).trim());

const SCRIPT_TOOL = "execute_script";

const OPEN_DOCUMENTS_SCRIPT = [
  "const { Document } = require('/document.js');",
  "console.log(JSON.stringify(Document.all.map((d) => d.sessionUuid)));",
].join("\n");

const closeDocumentsScript = (uuids: string[]): string =>
  [
    "const { Document } = require('/document.js');",
    `const own = new Set(${JSON.stringify(uuids)});`,
    "const closed = [];",
    "for (const d of Document.all.filter((d) => own.has(d.sessionUuid))) { closed.push(d.sessionUuid); d.close(); }",
    "console.log(JSON.stringify(closed));",
  ].join("\n");

export type BridgeOptions = {
  url: string;
  timeoutMs?: number;
  debug?: boolean;
  /**
   * Track the documents this bridge's scripts open (`--close-documents`), so `closeDocuments()` closes those and
   * no document a person opened in the app. One bridge then serves one agent's work.
   */
  ownDocuments?: boolean;
};

export class AffinityBridge extends EventEmitter {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly debug: boolean;
  private client?: AffinityClient;
  private primed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private tools?: Array<Record<string, unknown>>;
  private readonly ownDocuments: boolean;
  /** Documents a script of this bridge opened and has not closed. */
  private readonly owned = new Set<string>();
  /** Documents that were open before, or appeared between this bridge's scripts: somebody else's. */
  private readonly others = new Set<string>();
  /** A script of this bridge never answered: what it opened is still unrecorded. */
  private unsettled = false;

  constructor(options: BridgeOptions) {
    super();
    this.url = options.url || DEFAULT_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.debug = options.debug ?? false;
    this.ownDocuments = options.ownDocuments ?? false;
  }

  private log(...parts: unknown[]): void {
    if (this.debug) console.error("[pi-affinity-mcp]", ...parts);
  }

  private async ensure(): Promise<AffinityClient> {
    if (this.client?.isClosed) this.drop();
    if (this.client) return this.client;
    const client = new AffinityClient({
      url: this.url,
      timeoutMs: this.timeoutMs,
      debug: this.debug,
    });
    await client.connect();
    const info = (await client.handshake()) as {
      serverInfo?: Record<string, unknown>;
      protocolVersion?: string;
    };
    this.log("connected", JSON.stringify(info.serverInfo ?? {}), "protocol", info.protocolVersion);
    this.client = client;
    this.primed = false;
    if (this.tools) await this.refreshTools(client);
    return client;
  }

  /** A new session may be a new Affinity version; tell listeners when its tools differ. */
  private async refreshTools(client: AffinityClient): Promise<void> {
    const tools = await client.listTools();
    if (JSON.stringify(tools) === JSON.stringify(this.tools)) return;
    this.tools = tools;
    this.log("tool list changed");
    this.emit("toolsChanged");
  }

  private drop(): void {
    this.client?.close();
    this.client = undefined;
    this.primed = false;
  }

  /**
   * Read the preamble in the current session; required before any SDK work.
   *
   * Observed on Affinity 3.3.3: a session can answer `File not found` for topics
   * while a freshly opened stream serves them, so a failed prime reconnects once
   * before the failure is reported.
   */
  private async prime(): Promise<void> {
    if (this.primed) return;
    for (let attempt = 1; ; attempt += 1) {
      const client = await this.ensure();
      const result = await client.call(PREAMBLE_TOOL, { filename: PREAMBLE_TOPIC });
      const text = flatten(result);
      if (!result.isError) {
        this.primed = true;
        this.log("preamble primed", `(${text.length} chars)`);
        return;
      }
      if (attempt === 2) {
        throw new AffinityError(
          `could not read the SDK preamble: ${text.slice(0, 300)}. ` +
            "Retry; if it persists, restart Affinity.",
        );
      }
      this.log("preamble read failed, reconnecting once:", text.slice(0, 120));
      this.drop();
    }
  }

  private async invoke(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const readsPreamble = name === PREAMBLE_TOOL && args.filename === PREAMBLE_TOPIC;
    if (GATED_TOOLS.has(name) && !readsPreamble) await this.prime();
    // Resolve the client after priming: priming may reconnect and replace it.
    let client = await this.ensure();
    let result = await client.call(name, args);
    if (isGateRefusal(result)) {
      this.log("preamble gate tripped -> re-priming and retrying", name);
      this.primed = false;
      await this.prime();
      client = await this.ensure();
      result = await client.call(name, args);
    }
    return result;
  }

  /**
   * Read which documents are open. One not seen before is this bridge's when `mine` (seen right after its own
   * script, or after a script of its own that never answered), somebody else's otherwise.
   */
  private async observe(mine: boolean): Promise<void> {
    const result = await this.invoke(SCRIPT_TOOL, { script: OPEN_DOCUMENTS_SCRIPT });
    if (result.isError) throw new AffinityError(`could not list the open documents: ${flatten(result).slice(0, 300)}`);
    const open = new Set(JSON.parse(flatten(result)) as string[]);
    for (const uuid of open) {
      if (!this.owned.has(uuid) && !this.others.has(uuid)) (mine ? this.owned : this.others).add(uuid);
    }
    for (const uuid of this.owned) if (!open.has(uuid)) this.owned.delete(uuid);
  }

  /** A script, with the documents it opens recorded as this bridge's. */
  private async runOwnScript(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.observe(this.unsettled);
    this.unsettled = true;
    const result = await this.invoke(SCRIPT_TOOL, args);
    await this.observe(true);
    this.unsettled = false;
    return result;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.serialize(async () => {
      try {
        if (this.ownDocuments && name === SCRIPT_TOOL) return await this.runOwnScript(args);
        return await this.invoke(name, args);
      } catch (error) {
        if (!(error instanceof AffinityTimeoutError)) throw error;
        // The session did not answer in time; nothing more is sent on it.
        this.drop();
        if (!READ_ONLY_TOOLS.has(name)) {
          throw new AffinityTimeoutError(
            `${name} did not answer within ${this.timeoutMs / 1000}s. It may still be running in ` +
              "Affinity, or have finished: inspect the document before running it again. " +
              "Long scripts need a longer --timeout (AFFINITY_MCP_TIMEOUT).",
          );
        }
        this.log("timeout, reconnecting once:", error.message);
        return await this.invoke(name, args);
      }
    });
  }

  async listTools(): Promise<Array<Record<string, unknown>>> {
    return await this.serialize(async () => {
      // Without a live session, reopen it first: that also refreshes a cached list.
      if (!this.tools || !this.client || this.client.isClosed) {
        const client = await this.ensure();
        this.tools ??= await client.listTools();
      }
      return this.tools;
    });
  }

  /** Close the documents this bridge's scripts opened and left open; returns their session UUIDs. */
  async closeDocuments(): Promise<string[]> {
    return await this.serialize(async () => {
      if (this.unsettled) await this.observe(true);
      if (this.owned.size === 0) return [];
      const result = await this.invoke(SCRIPT_TOOL, { script: closeDocumentsScript([...this.owned]) });
      if (result.isError) throw new AffinityError(`could not close the documents: ${flatten(result).slice(0, 300)}`);
      const closed = JSON.parse(flatten(result)) as string[];
      for (const uuid of closed) this.owned.delete(uuid);
      return closed;
    });
  }

  close(): void {
    this.drop();
  }
}
