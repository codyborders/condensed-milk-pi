/**
 * Shared fake infrastructure for real-attempt execution tests.
 * Not a test file: helpers only. Fake Pi runtime, loopback fake z.ai
 * upstream, and a sentinel credential source. Never contacts the real
 * provider.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";

export const SENTINEL_KEY = "sentinel-zai-key-do-not-leak-0123456789abcdef";

/** Loopback fake z.ai upstream: verifies auth, streams SSE. */
export function startFakeUpstream({ mode = "ok" } = {}) {
  const seen = [];
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
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not the anthropic messages endpoint" }));
        return;
      }
      if (mode === "reject") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized", marker: "UPSTREAM-ERROR-MARKER" }));
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
        res.write(`event: stream-chunk-${index}\ndata: {"index":${index},"marker":"STREAM-CHUNK-MARKER-${index}"}\n\n`);
        setTimeout(writeNext, 10);
      };
      writeNext();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        seen,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

export function writeCredentialSource(path, baseUrl) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      providers: {
        "z-ai": {
          api: "anthropic-messages",
          apiKey: SENTINEL_KEY,
          baseUrl,
          models: [{ id: "glm-5.3" }],
        },
        "unrelated-provider": { apiKey: "other-key", baseUrl: "http://127.0.0.1:9/v1" },
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

const FAKE_PI_SOURCE = String.raw`
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const { behavior } = JSON.parse(readFileSync(join(here, "..", "behavior.json"), "utf8"));
const solution = JSON.parse(readFileSync(join(here, "..", "solution.json"), "utf8"));
const argv = process.argv.slice(2);
const sessionDir = argv[argv.indexOf("--session-dir") + 1];
const prompt = argv[argv.length - 1];
mkdirSync(sessionDir, { recursive: true });
writeFileSync(join(sessionDir, "record-argv.json"), JSON.stringify({ argv: process.argv, cwd: process.cwd() }, null, 2));
writeFileSync(join(sessionDir, "record-env.json"), JSON.stringify({ env: process.env }, null, 2));

const models = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), "utf8"));
const provider = models.providers["z-ai-eval"];
const emit = (line) => process.stdout.write(JSON.stringify(line) + "\n");
const applySolution = () => {
  for (const file of solution.files) {
    const target = join(process.cwd(), file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
};

function requestUpstream() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: provider.models[0].id, stream: true, max_tokens: 64, messages: [{ role: "user", content: prompt }] });
    const req = http.request(new URL(provider.baseUrl + "/v1/messages"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": provider.apiKey, accept: "text/event-stream" },
    }, (res) => {
      let bytes = 0;
      res.on("data", (chunk) => { bytes += chunk.length; });
      res.on("end", () => resolve({ status: res.statusCode, bytes }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

if (behavior === "hang") {
  emit({ type: "agent_start" });
  process.on("SIGTERM", () => {});
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(join(sessionDir, "record-tree.json"), JSON.stringify({ pid: process.pid, childPid: child.pid }, null, 2));
  setInterval(() => {}, 1000);
} else {
  const upstream = await requestUpstream();
  if (upstream.status !== 200) {
    process.stderr.write("upstream rejected with " + upstream.status + "\n");
    process.exit(4);
  }
  const first = { role: "assistant", content: [{ type: "text", text: "turn one" }], usage: { input: 1100, output: 260, cacheWrite: 40 } };
  const second = { role: "assistant", content: [{ type: "text", text: "turn two" }], usage: { input: 50, output: 10 } };
  emit({ type: "session", version: 3, id: "fake-session", timestamp: new Date().toISOString(), cwd: process.cwd() });
  emit({ type: "agent_start" });
  emit({ type: "message_end", message: first });
  emit({ type: "message_end", message: second });
  emit({ type: "agent_end", messages: [first, second] });
  applySolution();
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (behavior === "nonzero") process.exit(3);
  process.exit(0);
}
`;

/** Fake Pi 0.84.2 runtime: speaks the CLI contract the runner relies on. */
export function makeFakePiRuntime(cacheDir, { behavior = "ok", solution }) {
  const runtimeDir = join(cacheDir, "fake-pi-runtime");
  mkdirSync(join(runtimeDir, "dist"), { recursive: true });
  writeFileSync(
    join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: "fake-pi-runtime", version: "0.84.2", type: "module", engines: { node: ">=22.19.0" } }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(runtimeDir, "behavior.json"), `${JSON.stringify({ behavior })}\n`, "utf8");
  writeFileSync(join(runtimeDir, "solution.json"), `${JSON.stringify(solution)}\n`, "utf8");
  writeFileSync(join(runtimeDir, "dist", "cli.js"), FAKE_PI_SOURCE, "utf8");
  return join(runtimeDir, "dist", "cli.js");
}
