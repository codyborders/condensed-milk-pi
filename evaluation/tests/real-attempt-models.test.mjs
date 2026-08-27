/**
 * Generated eval model config tests
 * (boundary: evaluation/runner/real-attempt.mjs buildEvalProviderModels).
 *
 * The glm-5.3-flash entry must pass Pi 0.84.2 model validation with
 * maxTokens 65536, the pinned reasoning/input/contextWindow values,
 * and z-ai compatibility fields copied from the safe glm-5.3 template
 * when present. Cost claims and credentials are never copied.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SAFE_TEMPLATE = {
  id: "glm-5.3",
  name: "GLM-5.3",
  reasoning: true,
  input: ["text"],
  contextWindow: 200000,
  maxTokens: 8192,
  cost: { input: 1.5, output: 6, cacheRead: 0.2, cacheWrite: 2 },
  compat: { supportsTemperature: true, allowEmptySignature: true },
  thinkingLevelMap: { high: "think" },
  samplingParams: { temperature: 0.7 },
};

describe("generated eval model config", () => {
  test("builder emits maxTokens 65536, preserves pins, copies compat, drops cost", async () => {
    const attempt = await import(join(repoRoot, "evaluation", "runner", "real-attempt.mjs"));
    assert.equal(typeof attempt.buildEvalProviderModels, "function", "builder must be exported");
    const config = attempt.buildEvalProviderModels({ proxyBaseUrl: "http://127.0.0.1:1", template: SAFE_TEMPLATE, dummyApiKey: "eval-dummy-key" });
    const provider = config.providers["z-ai-eval"];
    assert.equal(provider.baseUrl, "http://127.0.0.1:1", "the proxy base URL is used, never the template endpoint");
    assert.equal(provider.apiKey, "eval-dummy-key", "only the dummy key is written");
    assert.equal(provider.api, "anthropic-messages");
    const model = provider.models[0];
    assert.equal(model.id, "glm-5.3-flash");
    assert.equal(model.maxTokens, 65536, "maxTokens must be 65536");
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.input, ["text", "image"]);
    assert.equal(model.contextWindow, 1000000);
    assert.deepEqual(model.compat, SAFE_TEMPLATE.compat, "compat must be copied from the safe template");
    assert.deepEqual(model.thinkingLevelMap, SAFE_TEMPLATE.thinkingLevelMap);
    assert.deepEqual(model.samplingParams, SAFE_TEMPLATE.samplingParams);
    assert.equal(model.cost, undefined, "cost claims must never be copied");
    const flat = JSON.stringify(config);
    assert.ok(!flat.includes("1.5"), "template cost numbers must not leak");
    assert.ok(!/"cost"/.test(flat), "no cost claims may be written");
    assert.equal(
      attempt.buildEvalProviderModels({ proxyBaseUrl: "http://127.0.0.1:1", template: null, dummyApiKey: "eval-dummy-key" }).providers["z-ai-eval"].models[0].maxTokens,
      65536,
      "the builder works without a template",
    );
  });
});
