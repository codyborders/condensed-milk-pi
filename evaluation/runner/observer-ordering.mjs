/**
 * Exact-runtime observer ordering verification.
 *
 * Builds pre/mutator/post handlers against the real ExtensionRunner and
 * runtime from the resolved Pi package bytes. Verifies tool_result and
 * context chaining order. Throws on any violation. Callers must run
 * this before any reservation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function makeExtension(name, handlers) {
  return {
    path: name,
    resolvedPath: name,
    sourceInfo: "observer-ordering-verify",
    handlers: new Map(Object.entries(handlers)),
    tools: new Map(),
    messageRenderers: new Map(),
  };
}

/**
 * Verify handler chaining with the exact runtime exports. `loadRuntime`
 * resolves { ExtensionRunner, createExtensionRuntime } from the pinned
 * Pi package bytes (dist). Throws on any ordering violation.
 */
export async function verifyObserverOrdering({ loadRuntime }) {
  if (typeof loadRuntime !== "function") {
    throw new Error("verifyObserverOrdering needs a loadRuntime function over the resolved runtime bytes");
  }
  const { ExtensionRunner, createExtensionRuntime } = await loadRuntime();
  if (typeof ExtensionRunner !== "function" || typeof createExtensionRuntime !== "function") {
    throw new Error("resolved runtime does not export ExtensionRunner and createExtensionRuntime");
  }
  const calls = [];
  const pre = makeExtension("pre", {
    tool_result: [async () => { calls.push("pre:tool_result"); }],
    context: [async () => { calls.push("pre:context"); }],
  });
  const SENTINEL_TEXT = "observer-ordering-mutator";
  const mutator = makeExtension("mutator", {
    tool_result: [
      async (event) => {
        calls.push("mutator:tool_result");
        return { content: `${event.content}:${SENTINEL_TEXT}` };
      },
    ],
    context: [
      async (event) => {
        calls.push("mutator:context");
        return { messages: event.messages.map((message) => ({ ...message, mutated: true })) };
      },
    ],
  });
  let postSawText = null;
  let postSawMutatedMessage = false;
  const post = makeExtension("post", {
    tool_result: [
      async (event) => {
        calls.push("post:tool_result");
        postSawText = event?.content ?? null;
      },
    ],
    context: [
      async (event) => {
        calls.push("post:context");
        postSawMutatedMessage = event.messages.every((message) => message.mutated === true);
      },
    ],
  });
  const runner = new ExtensionRunner([pre, mutator, post], createExtensionRuntime(), process.cwd(), null, null);
  const toolResult = await runner.emitToolResult({
    type: "tool_result",
    toolCallId: "call-0",
    toolName: "bash",
    content: "original",
    isError: false,
  });
  const contextMessages = await runner.emitContext([{ role: "user", content: [{ type: "text", text: "m" }] }]);
  const expectedToolOrder = ["pre:tool_result", "mutator:tool_result", "post:tool_result"];
  const expectedContextOrder = ["pre:context", "mutator:context", "post:context"];
  for (let index = 0; index < expectedToolOrder.length; index += 1) {
    if (calls[index] !== expectedToolOrder[index]) {
      throw new Error(`tool_result ordering violation at ${index}: ${calls[index]} != ${expectedToolOrder[index]}`);
    }
  }
  const contextCalls = calls.filter((call) => call.endsWith(":context"));
  for (let index = 0; index < expectedContextOrder.length; index += 1) {
    if (contextCalls[index] !== expectedContextOrder[index]) {
      throw new Error(`context ordering violation at ${index}`);
    }
  }
  if (!postSawText || !postSawText.includes(SENTINEL_TEXT)) {
    throw new Error("post observer did not observe the mutator's tool_result transform");
  }
  if (!postSawMutatedMessage) {
    throw new Error("post observer did not observe the mutator's context transform");
  }
  if (toolResult && toolResult.content !== undefined && !String(toolResult.content).includes(SENTINEL_TEXT)) {
    throw new Error("tool_result chaining lost the mutator transform");
  }
  if (contextMessages.length !== 1 || contextMessages[0].mutated !== true) {
    throw new Error("context chaining lost the mutator transform");
  }
  return { ok: true, checked: ["tool_result", "context"] };
}

/** Runtime loader over the resolved Pi package dist bytes. */
export function runtimeLoaderFromDist(runtimeDir) {
  return async () => {
    const modulePath = join(runtimeDir, "dist", "index.js");
    if (!existsSync(modulePath)) {
      throw new Error(`resolved runtime has no dist/index.js at ${runtimeDir}`);
    }
    return import(modulePath);
  };
}

/**
 * Cached ordering verification: one passing record per runtime digest.
 * The cache only ever stores passing records keyed by the digest of
 * the exact runtime tree manifest. A non-passing cached record
 * refuses instead of re-running.
 */
export async function verifyObserverOrderingCached({ runtimeDir, runtimeManifest, cacheDir }) {
  const digest = runtimeManifest?.digest ?? null;
  if (!digest) {
    throw new Error("verifyObserverOrderingCached needs a runtime manifest digest");
  }
  const cachePath = join(cacheDir, "observer-ordering");
  mkdirSync(cachePath, { recursive: true });
  const recordPath = join(cachePath, `${digest}.json`);
  if (existsSync(recordPath)) {
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    if (record?.passing === true && record?.digest === digest) {
      return { ok: true, cached: true };
    }
    throw new Error("observer ordering cache holds a non-passing record; refusing");
  }
  const result = await verifyObserverOrdering({ loadRuntime: runtimeLoaderFromDist(runtimeDir) });
  writeFileSync(
    recordPath,
    `${JSON.stringify({ passing: true, digest, checked: result.checked, at: new Date().toISOString() })}\n`,
    "utf8",
  );
  return { ok: true, cached: false };
}
