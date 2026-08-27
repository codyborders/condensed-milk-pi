/**
 * Credential module tests (boundary: evaluation/runner/real-credentials.mjs).
 *
 * Fake-only: a sentinel key standing in for the real z.ai key. The
 * module must resolve it into memory and never echo it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SENTINEL_KEY = "sentinel-zai-key-do-not-leak-0123456789abcdef";

function writeSource(path, providers) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ providers }, null, 2)}\n`, "utf8");
}

function startUpstream(work, seen) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
      if (req.method !== "POST" || req.url !== "/v1/messages") {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      let index = 0;
      const writeNext = () => {
        if (index >= 3) {
          res.end();
          return;
        }
        index += 1;
        res.write(`event: stream-chunk-${index}\ndata: {"i":${index}}\n\n`);
        setTimeout(writeNext, 15);
      };
      writeNext();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function postJson(url, payload, apiKey) {
  const body = JSON.stringify(payload);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body,
  });
  const text = await response.text();
  return { status: response.status, body: text, sentBytes: Buffer.byteLength(body) };
}

function httpGet(url, done) {
  http.get(url, (response) => {
    response.resume();
    response.on("end", () => done({ status: response.statusCode }));
  });
}

describe("real credential loading", () => {
  test("loads only the z-ai provider entry and keeps the key out of errors", async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-cred-"));
    try {
      const source = join(work, "models.json");
      writeSource(source, {
        "z-ai": {
          api: "anthropic-messages",
          apiKey: SENTINEL_KEY,
          baseUrl: "https://api.z.ai/api/anthropic",
          models: [{ id: "glm-5.3" }],
        },
        "other-provider": { apiKey: "not-read", baseUrl: "http://127.0.0.1:9" },
      });
      const { loadProviderCredential } = await import(join(repoRoot, "evaluation", "runner", "real-credentials.mjs"));
      const credential = loadProviderCredential({ sourcePath: source });
      assert.equal(credential.apiKey, SENTINEL_KEY);
      assert.equal(credential.baseUrl, "https://api.z.ai/api/anthropic");

      const missing = join(work, "no-zai.json");
      writeSource(missing, { "other-provider": { apiKey: "x", baseUrl: "https://example.invalid" } });
      assert.throws(
        () => loadProviderCredential({ sourcePath: missing }),
        (error) => {
          assert.match(error.message, /no z-ai provider config/);
          assert.ok(!error.message.includes(SENTINEL_KEY), "errors must never echo the key");
          return true;
        },
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("resolves !command apiKey syntax without echoing command output", async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-cred-cmd-"));
    try {
      const secretFile = join(work, "secret-file");
      writeFileSync(secretFile, `${SENTINEL_KEY}\n`, "utf8");
      const source = join(work, "models-cmd.json");
      writeSource(source, {
        "z-ai": {
          api: "anthropic-messages",
          apiKey: `!cat ${secretFile}`,
          baseUrl: "https://api.z.ai/api/anthropic/",
        },
      });
      const { loadProviderCredential } = await import(join(repoRoot, "evaluation", "runner", "real-credentials.mjs"));
      const credential = loadProviderCredential({ sourcePath: source });
      assert.equal(credential.apiKey, SENTINEL_KEY);
      assert.equal(credential.baseUrl, "https://api.z.ai/api/anthropic", "trailing slash is normalized");

      const failing = join(work, "models-failing.json");
      writeSource(failing, {
        "z-ai": { apiKey: "!printf 'partial-secret-%s\\n' failed >&2; exit 1", baseUrl: "https://api.z.ai/api/anthropic" },
      });
      assert.throws(
        () => loadProviderCredential({ sourcePath: failing }),
        (error) => {
          assert.match(error.message, /credential command failed/);
          assert.ok(!error.message.includes("partial-secret"), "command output must never be logged");
          return true;
        },
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("loopback proxy forwards only the messages endpoint and records no bodies", { timeout: 5_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-cred-proxy-"));
    let upstream = null;
    try {
      const upstreamSeen = [];
      upstream = await startUpstream(work, upstreamSeen);
      const { startCredentialProxy } = await import(join(repoRoot, "evaluation", "runner", "real-credentials.mjs"));
      const proxy = await startCredentialProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: SENTINEL_KEY, dummyApiKey: "eval-dummy-key" });
      try {
        const response = await postJson(`${proxy.baseUrl}/v1/messages`, { model: "glm-5.3-flash", marker: "REQ-BODY-MARKER" }, "eval-dummy-key");
        assert.equal(response.status, 200);
        assert.ok(response.body.includes("event: stream-chunk-1"), "streamed chunks must arrive");
        assert.ok(response.body.includes("event: stream-chunk-3"), "the whole stream must arrive");

        assert.equal(upstreamSeen.length, 1);
        assert.equal(upstreamSeen[0].headers["x-api-key"], SENTINEL_KEY, "dummy auth must be replaced");
        assert.equal(upstreamSeen[0].headers.authorization, undefined, "no bearer auth is forwarded");
        assert.equal(upstreamSeen[0].body.marker, "REQ-BODY-MARKER", "request body must be forwarded verbatim");

        const wrongPath = await postJson(`${proxy.baseUrl}/v1/complete`, {}, "eval-dummy-key");
        assert.equal(wrongPath.status, 404);
        const wrongMethod = await new Promise((resolve) => {
          httpGet(`${proxy.baseUrl}/v1/messages`, resolve);
        });
        assert.equal(wrongMethod.status, 405);

        const stats = proxy.stats();
        assert.equal(stats.requests.length, 1);
        assert.equal(stats.requests[0].status, 200);
        assert.equal(typeof stats.requests[0].durationMs, "number");
        assert.equal(stats.requests[0].bytesIn, response.sentBytes, "request byte count is recorded");
        assert.ok(stats.requests[0].bytesOut >= response.body.length, "response byte count is recorded");
        assert.equal(stats.rejected.length, 2, "non-messages requests are counted as rejected");
        const serialized = JSON.stringify(stats);
        assert.ok(!serialized.includes(SENTINEL_KEY), "stats must never contain the key");
        assert.ok(!serialized.includes("REQ-BODY-MARKER"), "request bodies must never be stored");
        assert.ok(!serialized.includes("stream-chunk"), "response bodies must never be stored");
        assert.ok(!serialized.includes("z-ai"), "stats must not name the upstream");
      } finally {
        await proxy.close();
      }
      await assert.rejects(
        () => postJson(`${proxy.baseUrl}/v1/messages`, {}, "eval-dummy-key"),
        /fetch failed|ECONNREFUSED/,
        "close must stop accepting connections",
      );
    } finally {
      if (upstream) await upstream.close();
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("credential proxy request-body bound", () => {
  const MAX = 20 * 1024 * 1024;

  function startByteUpstream(seen) {
    const sockets = new Set();
    const server = http.createServer((req, res) => {
      let bytes = 0;
      req.on("data", (chunk) => {
        bytes += chunk.length;
      });
      req.on("end", () => {
        seen.push({ url: req.url, bytes });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("event: done\ndata: {}\n\n");
      });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            const bound = setTimeout(done, 1_500);
            server.close(() => {
              clearTimeout(bound);
              done();
            });
            for (const socket of sockets) socket.destroy();
          }),
      }));
    });
  }

  function postRaw(port, size) {
    return new Promise((resolve) => {
      const body = Buffer.alloc(size, 97);
      let settled = false;
      const finish = (result) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/v1/messages",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": String(size), "x-api-key": "eval-dummy-key" },
        },
        (res) => {
          finish({ status: res.statusCode });
          res.resume();
        },
      );
      req.on("error", () => finish({ status: null, error: true }));
      req.end(body);
    });
  }

  test("forwards exactly 20 MiB and rejects 20 MiB + 1 with 413 before forwarding", { timeout: 10_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-cred-bound-"));
    const seen = [];
    let upstream = null;
    let proxy = null;
    try {
      const { startCredentialProxy, MAX_REQUEST_BODY_BYTES } = await import(join(repoRoot, "evaluation", "runner", "real-credentials.mjs"));
      assert.equal(MAX_REQUEST_BODY_BYTES, MAX, "the bound is exactly 20 MiB");
      upstream = await startByteUpstream(seen);
      proxy = await startCredentialProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: SENTINEL_KEY, dummyApiKey: "eval-dummy-key" });

      const boundary = await postRaw(proxy.port, MAX);
      assert.equal(boundary.status, 200, "the exact 20 MiB boundary must forward");
      assert.equal(seen.length, 1);
      assert.equal(seen[0].bytes, MAX, "the upstream received every boundary byte");

      const overflow = await postRaw(proxy.port, MAX + 1);
      assert.equal(overflow.status, 413, `20 MiB + 1 must get 413, got ${overflow.status}`);
      assert.equal(seen.length, 1, "the overflow must never be forwarded");
      const stats = proxy.stats();
      assert.equal(
        stats.rejected.filter((entry) => entry.reason === "request-body-over-limit").length,
        1,
        "the rejection is recorded with its reason",
      );
      assert.ok(!JSON.stringify(stats).includes(SENTINEL_KEY), "stats must never contain the key");
    } finally {
      if (proxy) await proxy.close();
      if (upstream) await upstream.close();
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("credential proxy upstream timeout", () => {
  function startHangingUpstream() {
    const sockets = new Set();
    const server = http.createServer(() => {
      // Accept the request and never respond.
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            const bound = setTimeout(done, 1_500);
            server.close(() => {
              clearTimeout(bound);
              done();
            });
            for (const socket of sockets) socket.destroy();
          }),
      }));
    });
  }

  test("a hung upstream gets 504, terminal stats, and a close that does not hang", { timeout: 15_000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), "cm-cred-upstream-timeout-"));
    let upstream = null;
    let proxy = null;
    try {
      const { startCredentialProxy, UPSTREAM_TIMEOUT_MS } = await import(join(repoRoot, "evaluation", "runner", "real-credentials.mjs"));
      assert.equal(UPSTREAM_TIMEOUT_MS, 60_000, "the default upstream timeout is 60 seconds");
      upstream = await startHangingUpstream();
      proxy = await startCredentialProxy({
        upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
        apiKey: SENTINEL_KEY,
        dummyApiKey: "eval-dummy-key",
        upstreamTimeoutMs: 300,
      });
      const deadline = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("upstream request hung: no timeout handling")), 3_000),
      );
      const response = await Promise.race([
        fetch(`${proxy.baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "eval-dummy-key" },
          body: JSON.stringify({ marker: "HANG-BODY" }),
        }),
        deadline,
      ]);
      assert.equal(response.status, 504, `the hung upstream must answer 504, got ${response.status}`);
      const text = await response.text();
      assert.ok(!text.includes(SENTINEL_KEY), "the 504 body must not leak the key");
      const stats = proxy.stats();
      assert.equal(stats.requests.length, 1, "the timeout must reach terminal proxy stats");
      assert.equal(stats.requests[0].status, 504);
      assert.ok(stats.requests[0].durationMs >= 300, "the recorded duration covers the timeout window");
      const flat = JSON.stringify(stats);
      assert.ok(!flat.includes("HANG-BODY"), "stats must never store bodies");
      assert.ok(!flat.includes(SENTINEL_KEY), "stats must never store the key");
    } finally {
      if (proxy) await proxy.close();
      if (upstream) await upstream.close();
      rmSync(work, { recursive: true, force: true });
    }
  });
});
