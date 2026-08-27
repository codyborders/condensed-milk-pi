/**
 * Credential boundary for the real provider path.
 *
 * Contract:
 * - reads only the z-ai provider entry of an existing models.json;
 *   every other provider entry is ignored.
 * - the resolved key lives in memory only: this module never writes it
 *   to disk, argv, environment, journal entries, reports, or error text,
 *   and resolution failures never echo key material.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";

export const PROVIDER_ID = "z-ai";
/** The known-good model entry the eval model config copies compatibility from. */
export const SAFE_TEMPLATE_MODEL_ID = "glm-5.3";
const KEY_COMMAND_TIMEOUT_MS = 10_000;
const PROXY_CLOSE_BOUND_MS = 1_500;
/** Hard request-body bound: 20 MiB. Overflow is refused with 413. */
export const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
/** Fixed maximum header size the proxy relies on (Node's fixed default). */
export const MAX_HEADER_BYTES = 16 * 1024;
/** Default upstream request timeout: 60 seconds of socket idleness. */
export const UPSTREAM_TIMEOUT_MS = 60_000;

/**
 * Resolve { apiKey, baseUrl } from the z-ai provider config. The key is
 * returned to the caller for in-memory use only.
 */
export function loadProviderCredential({ sourcePath }) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch (error) {
    throw new Error(`credential source is not readable JSON: ${error.code ?? error.message}`);
  }
  const provider = parsed?.providers?.[PROVIDER_ID];
  if (!provider || typeof provider !== "object") {
    throw new Error(`credential source has no ${PROVIDER_ID} provider config`);
  }
  const apiKeySpec = provider.apiKey;
  if (typeof apiKeySpec !== "string" || apiKeySpec.length === 0) {
    throw new Error(`${PROVIDER_ID} provider config has no apiKey`);
  }
  const apiKey = resolveKeySpec(apiKeySpec);
  const baseUrl = provider.baseUrl;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new Error(`${PROVIDER_ID} provider config has no baseUrl`);
  }
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, "") };
}

function resolveKeySpec(spec) {
  if (spec.startsWith("!")) {
    return runKeyCommand(spec.slice(1));
  }
  return spec;
}

/**
 * Load the safe glm-5.3 model template from the z-ai provider entry,
 * reduced to the compatibility fields the eval model may copy.
 * Returns null when the credential source has no such model entry.
 * Cost claims, credentials, and endpoints never leave this function.
 */
export function loadSafeModelTemplate({ sourcePath }) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch {
    return null;
  }
  const entry = parsed?.providers?.[PROVIDER_ID]?.models?.find((model) => model?.id === SAFE_TEMPLATE_MODEL_ID);
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const template = {};
  for (const field of ["thinkingLevelMap", "samplingParams", "compat"]) {
    if (entry[field] !== undefined) template[field] = structuredClone(entry[field]);
  }
  return template;
}

function runKeyCommand(command) {
  const result = spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    timeout: KEY_COMMAND_TIMEOUT_MS,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  if (result.error || result.status !== 0) {
    throw new Error("credential command failed; no key was obtained");
  }
  const key = (result.stdout ?? "").trim();
  if (key.length === 0) {
    throw new Error("credential command produced no key");
  }
  return key;
}

/**
 * Start the parent-owned loopback credential proxy for one attempt.
 *
 * - listens only on 127.0.0.1 with an ephemeral port.
 * - holds the real key in memory and never writes it anywhere.
 * - accepts only POST /v1/messages; other method/path combinations are
 *   rejected (405 for the right path, 404 otherwise) and counted.
 * - accepts POST /v1/messages only when the x-api-key header exactly
 *   equals the per-attempt dummy key the caller generated (compared in
 *   constant time once lengths match). Missing or wrong dummy auth is
 *   answered 401 before any forwarding and counted as safe rejection
 *   metadata (method, url, reason) without the offered key value.
 * - relies on a fixed maximum header size (MAX_HEADER_BYTES) and bounds
 *   request bodies to MAX_REQUEST_BODY_BYTES: overflow is answered with
 *   413 before any forwarding, buffering stops at rejection, and the
 *   excess bytes are never held or forwarded.
 * - forwards the request body verbatim to the fixed upstream base URL
 *   with dummy authentication replaced by the real key, then streams
 *   the upstream response through without storing it. An upstream
 *   request idle beyond the timeout (60 s default) is destroyed, the
 *   client gets 504, and terminal stats are recorded without bodies.
 * - records status, duration, and byte counts only; request and
 *   response bodies never reach memory-external state.
 * - close() stops listening, destroys every tracked socket and the
 *   upstream keep-alive agent, and resolves within a fixed bound so a
 *   lingering keep-alive connection can never hang teardown.
 */
/** Constant-time equality for equal-length values; length is checked first. */
function secretEquals(provided, expected) {
  const left = Buffer.from(String(provided), "utf8");
  const right = Buffer.from(String(expected), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function startCredentialProxy({ upstreamBaseUrl, apiKey, dummyApiKey, upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS }) {
  if (typeof dummyApiKey !== "string" || dummyApiKey.length === 0) {
    throw new Error("startCredentialProxy needs the attempt's dummy api key; refusing to forward any request");
  }
  const upstream = new URL(`${upstreamBaseUrl.replace(/\/+$/, "")}/v1/messages`);
  const requests = [];
  const rejected = [];
  const sockets = new Set();
  const agents = new Map();
  const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
    const startedAt = Date.now();
    if (req.method !== "POST" || req.url !== "/v1/messages") {
      rejected.push({ method: req.method, url: req.url });
      res.writeHead(req.url === "/v1/messages" ? 405 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "rejected" }));
      return;
    }
    const providedKey = req.headers["x-api-key"];
    if (typeof providedKey !== "string" || !secretEquals(providedKey, dummyApiKey)) {
      rejected.push({
        method: req.method,
        url: req.url,
        reason: typeof providedKey === "string" ? "invalid-dummy-auth" : "missing-dummy-auth",
      });
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const chunks = [];
    let bytesIn = 0;
    let overLimit = false;
    req.on("data", (chunk) => {
      bytesIn += chunk.length;
      if (overLimit) return; // buffering stopped after rejection
      if (bytesIn > MAX_REQUEST_BODY_BYTES) {
        overLimit = true;
        chunks.length = 0;
        rejected.push({ method: req.method, url: req.url, reason: "request-body-over-limit", bytesIn });
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "request body exceeds the fixed limit" }));
        // Stop reading and buffering the rest of the oversized body.
        req.removeAllListeners("data");
        req.on("data", () => {});
        res.on("finish", () => req.socket.destroy());
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => {
      if (!res.writableEnded) res.end();
    });
    req.on("end", () => {
      if (overLimit || res.writableEnded) return;
      const headers = {};
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        const name = req.rawHeaders[index].toLowerCase();
        if (["x-api-key", "authorization", "host", "content-length", "connection", "transfer-encoding"].includes(name)) continue;
        headers[name] = req.rawHeaders[index + 1];
      }
      headers["x-api-key"] = apiKey;
      headers["content-length"] = String(bytesIn);
      const isTls = upstream.protocol === "https:";
      if (!agents.has(isTls)) {
        agents.set(isTls, new (isTls ? https.Agent : http.Agent)({ keepAlive: true }));
      }
      let upstreamTimedOut = false;
      const upstreamReq = (isTls ? https : http).request(
        upstream,
        { method: "POST", headers, agent: agents.get(isTls) },
        (upstreamRes) => {
          let bytesOut = 0;
          res.writeHead(upstreamRes.statusCode, responseHeaders(upstreamRes.headers));
          upstreamRes.on("data", (chunk) => {
            bytesOut += chunk.length;
            res.write(chunk);
          });
          upstreamRes.on("end", () => {
            res.end();
            requests.push({ status: upstreamRes.statusCode, durationMs: Date.now() - startedAt, bytesIn, bytesOut });
          });
          upstreamRes.on("error", () => {
            res.end();
            requests.push({ status: upstreamRes.statusCode, durationMs: Date.now() - startedAt, bytesIn, bytesOut });
          });
        },
      );
      upstreamReq.setTimeout(upstreamTimeoutMs, () => {
        upstreamTimedOut = true;
        upstreamReq.destroy(new Error("upstream timeout"));
      });
      upstreamReq.on("error", () => {
        const status = upstreamTimedOut ? 504 : 502;
        if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: upstreamTimedOut ? "upstream timeout" : "upstream unavailable" }));
        }
        requests.push({ status, durationMs: Date.now() - startedAt, bytesIn, bytesOut: 0 });
      });
      for (const chunk of chunks) upstreamReq.write(chunk);
      upstreamReq.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolveListen({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        stats: () => ({
          port,
          requests: requests.map(({ status, durationMs, bytesIn, bytesOut }) => ({ status, durationMs, bytesIn, bytesOut })),
          rejected: rejected.map((entry) => ({ ...entry })),
        }),
        close: () =>
          new Promise((resolveClose) => {
            const finish = () => resolveClose();
            const bound = setTimeout(finish, PROXY_CLOSE_BOUND_MS);
            server.close(() => {
              clearTimeout(bound);
              finish();
            });
            for (const socket of sockets) socket.destroy();
            for (const agent of agents.values()) agent.destroy();
          }),
      });
    });
  });
}

function responseHeaders(headers) {
  const clean = {};
  for (const [name, value] of Object.entries(headers)) {
    if (["transfer-encoding", "connection", "content-length", "keep-alive"].includes(name.toLowerCase())) continue;
    clean[name] = value;
  }
  return clean;
}
