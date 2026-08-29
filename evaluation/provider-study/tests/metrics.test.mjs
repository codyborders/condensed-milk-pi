/**
 * Provider-study attempt metrics (grown test-first).
 *
 * Provider usage is preserved verbatim: every field the provider sent
 * survives unchanged, unknown fields included, and the summed provider
 * total is computed from the numeric token fields only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeProviderUsage, providerTotalTokens, proxyRequestAccounting, providerTrafficAnomaly } from "../runner/metrics.mjs";

test("usage preservation: raw provider fields survive verbatim and the total sums numeric token fields", () => {
  const raw = {
    input: 1000,
    output: 200,
    cacheRead: 300,
    cacheWrite: 50,
    reasoningTokens: 12,
    unknownFutureField: "kept-as-is",
  };
  const normalized = normalizeProviderUsage(raw);
  assert.deepEqual(Object.keys(normalized).sort(), Object.keys(raw).sort());
  for (const [key, value] of Object.entries(raw)) {
    assert.deepEqual(normalized[key], value, `${key} must survive verbatim`);
  }
  assert.equal(providerTotalTokens(normalized), 1000 + 200 + 300 + 50 + 12);
});

test("usage nulls stay null and never feed the total", () => {
  const normalized = normalizeProviderUsage({ input: 10, output: null, cacheRead: undefined });
  assert.equal(normalized.input, 10);
  assert.equal(normalized.output, null);
  assert.equal(normalized.cacheRead, null);
  assert.equal(providerTotalTokens(normalized), 10);
});

test("missing provider token categories produce no total", () => {
  assert.equal(providerTotalTokens(normalizeProviderUsage({})), null);
  assert.equal(providerTotalTokens(normalizeProviderUsage({ input: null, output: "unknown" })), null);
});

test("non-numeric token fields never feed the total", () => {
  const normalized = normalizeProviderUsage({ input: 5, output: "7", cacheRead: true });
  assert.equal(normalized.output, "7");
  assert.equal(providerTotalTokens(normalized), 5);
});

test("proxy.json is the authority for request accounting and anomaly detection", () => {
  const accounting = proxyRequestAccounting({
    port: 1234,
    requests: [
      { status: 200, durationMs: 10, bytesIn: 5, bytesOut: 5 },
      { status: 200, durationMs: 10, bytesIn: 5, bytesOut: 5 },
      { status: 500, durationMs: 10, bytesIn: 5, bytesOut: 5 },
      { status: null, durationMs: 10, bytesIn: 5, bytesOut: 5 },
    ],
    rejected: [{ method: "GET", url: "/v1/messages" }, { method: "POST", url: "/v1/messages", reason: "invalid-dummy-auth" }],
  });
  assert.deepEqual(accounting, {
    proxyRequestCount: 4,
    proxyStatusCounts: { "200": 2, "500": 1 },
    proxyFailedRequestCount: 2,
    proxyRejectedCount: 2,
  });
  const missing = proxyRequestAccounting(null);
  assert.deepEqual(missing, {
    proxyRequestCount: 0,
    proxyStatusCounts: {},
    proxyFailedRequestCount: 0,
    proxyRejectedCount: 0,
  });
  const consistent = providerTrafficAnomaly({ proxyRequestCount: 3, assistantCompletions: 3 });
  assert.equal(consistent.anomaly, false);
  const retried = providerTrafficAnomaly({ proxyRequestCount: 5, assistantCompletions: 3 });
  assert.equal(retried.anomaly, true, "more proxy requests than completions flags retried or resumed traffic");
  assert.match(retried.reason, /retried or resumed/);
  const resumed = providerTrafficAnomaly({ proxyRequestCount: 1, assistantCompletions: 3 });
  assert.equal(resumed.anomaly, true, "fewer proxy requests than completions flags a count disagreement");
  assert.equal(providerTrafficAnomaly({ proxyRequestCount: null, assistantCompletions: 3 }).anomaly, null);
});
