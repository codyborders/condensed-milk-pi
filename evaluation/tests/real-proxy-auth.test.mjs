/**
 * Credential proxy dummy-auth gate tests
 * (boundary: evaluation/runner/real-credentials.mjs startCredentialProxy).
 *
 * The loopback proxy forwards POST /v1/messages only when x-api-key
 * exactly equals the dummy key the attempt generated. Missing or wrong
 * dummy auth is answered 401, never forwarded, and recorded as safe
 * rejection metadata only. Fake-only loopback upstream, sentinel key.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
function repeatedTestValue(label, character) {
  return `${label}-${character.repeat(40)}`;
}

const SENTINEL_KEY = repeatedTestValue("sentinel", "z");
const DUMMY_KEY = repeatedTestValue("eval-dummy", "d");

function startUpstream(seen) {
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("event: done\ndata: {}\n\n");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function postJson(url, apiKey) {
  const headers = { "content-type": "application/json" };
  if (apiKey !== undefined) headers["x-api-key"] = apiKey;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ marker: "GATE-BODY" }) });
  return { status: response.status, body: await response.text() };
}

describe("credential proxy dummy-auth gate", () => {
  test("a wrong dummy key gets 401 and is never forwarded", { timeout: 10_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-cred-gate-"));
    const seen = [];
    let upstream = null;
    let proxy = null;
    try {
      const { startCredentialProxy } = await import(join(repoRoot, "evaluation", "runner", "real-credentials.mjs"));
      upstream = await startUpstream(seen);
      proxy = await startCredentialProxy({
        upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
        apiKey: SENTINEL_KEY,
        dummyApiKey: DUMMY_KEY,
      });
      const wrong = await postJson(`${proxy.baseUrl}/v1/messages`, "eval-attacker-0123456789abcdef01234567");
      assert.equal(wrong.status, 401);
      const missing = await postJson(`${proxy.baseUrl}/v1/messages`, undefined);
      assert.equal(missing.status, 401, "a request without x-api-key must be refused the same way");
      assert.ok(!missing.body.includes(SENTINEL_KEY), "the 401 body must not echo the real key");
      assert.equal(seen.length, 0, "unauthenticated requests must never reach the upstream");
    } finally {
      if (proxy) await proxy.close();
      if (upstream) await upstream.close();
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("the proxy refuses to start without the attempt's dummy key", async () => {
    const { startCredentialProxy } = await import(join(repoRoot, "evaluation", "runner", "real-credentials.mjs"));
    await assert.rejects(
      async () => startCredentialProxy({ upstreamBaseUrl: "http://127.0.0.1:1", apiKey: SENTINEL_KEY }),
      /dummy/i,
      "a proxy without the expected dummy key must fail closed before listening",
    );
  });
});
