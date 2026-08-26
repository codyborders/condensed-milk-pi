#!/usr/bin/env node
/**
 * v1.10.0 — profile resolution + thinking-block masking tests.
 *
 * Runs against the actual TS sources via tsx so the test sees what
 * production sees (no inline reimpl). Exit 0 = pass.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { exit, cwd } from "node:process";

// Harness must live inside the repo so its relative imports resolve
// against the repo's filters/. Cleaned up after run.
const HARNESS_PATH = join(cwd(), `.cm-profile-test-harness-${Date.now()}.mjs`);

// tsx (without `"type": "module"` in pkg) emits named exports under
// .default — destructure to access. Production load via pi works
// normally (pi's ESM loader handles real named imports).
const HARNESS = `
import profilesMod from "./filters/profiles.ts";
import contextMod from "./filters/context-compress.ts";
const { resolveProfile, BUILT_IN_PROFILES, renderPlaceholder } = profilesMod;
const { compressStaleToolResults, decideCutoff } = contextMod;

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
}
function eqArr(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 1. Built-in profiles exist with expected shapes.
{
  const dflt = BUILT_IN_PROFILES["default"];
  const qwen = BUILT_IN_PROFILES["qwen-vllm"];
  assert(dflt && qwen, "both built-in profiles exist");
  assert(eqArr(dflt.thresholds, [0.30, 0.45, 0.60]), "default thresholds match v1.9.0");
  assert(eqArr(dflt.coverage, [0.60, 0.80, 0.95]), "default coverage match v1.9.0");
  assert(dflt.effectiveContextCap === null, "default cap is null (use model default)");
  assert(dflt.maskOldThinking === "off", "default thinking mask off");
  assert(eqArr(qwen.thresholds, [0.20, 0.35, 0.55]), "qwen thresholds shifted earlier");
  assert(qwen.effectiveContextCap === 131072, "qwen cap is 131072");
  assert(qwen.maskOldThinking === "with-coverage", "qwen thinking mask with-coverage");
}

// 2. Built-in labels must not make unsupported tuning or validation claims.
{
  const claimPattern = /\\b(?:tuned|proven|recommended|validated)\\b/i;
  for (const [name, profile] of Object.entries(BUILT_IN_PROFILES)) {
    assert(!claimPattern.test(profile.label), \`\${name} label avoids unsupported claims\`);
  }
}

// 3. Invalid threshold values must fall back to base values.
{
  const r = resolveProfile("default", { default: { thresholds: null, coverage: [0.9, 0.2, 0.8] } }, {});
  assert(r.profile.thresholds.join(",") === "0.3,0.45,0.6", "null thresholds keep base");
  assert(r.profile.coverage.join(",") === "0.6,0.8,0.95", "invalid thresholds keep base coverage");
  assert(r.warnings.some((w) => w.includes("thresholds")), "invalid thresholds warning");
}

// 3. resolveProfile picks built-in by name.
{
  const r = resolveProfile("qwen-vllm", undefined, {});
  assert(r.activeName === "qwen-vllm", "resolves qwen-vllm by name");
  assert(r.profile.effectiveContextCap === 131072, "qwen-vllm cap preserved");
  assert(r.warnings.length === 0, "no warnings for clean qwen-vllm resolution");
}

// 3. Unknown profile name falls back to default with a warning.
{
  const r = resolveProfile("does-not-exist", undefined, {});
  assert(r.activeName === "default", "unknown name falls back to default");
  assert(r.warnings.length === 1, "unknown name produces a warning");
  assert(r.warnings[0].includes("does-not-exist"), "warning mentions the bad name");
}

// 4. Legacy top-level overrides apply only to default profile.
{
  const r = resolveProfile("default", undefined, {
    thresholds: [0.10, 0.20, 0.30],
    coverage:   [0.40, 0.60, 0.80],
  });
  assert(eqArr(r.profile.thresholds, [0.10, 0.20, 0.30]), "legacy thresholds applied to default");
  assert(eqArr(r.profile.coverage,   [0.40, 0.60, 0.80]), "legacy coverage applied to default");
}
{
  const r = resolveProfile("qwen-vllm", undefined, {
    thresholds: [0.05, 0.10, 0.15],
    coverage:   [0.20, 0.30, 0.40],
  });
  assert(eqArr(r.profile.thresholds, [0.20, 0.35, 0.55]),
    "legacy thresholds DO NOT override qwen-vllm (would silently undo profile)");
}

// 5. Custom profile under user config — built on top of default.
{
  const r = resolveProfile("my-custom", {
    "my-custom": { thresholds: [0.10, 0.20, 0.30], coverage: [0.40, 0.60, 0.80], maskOldThinking: "above-cutoff" },
  }, {});
  assert(r.activeName === "my-custom", "custom profile name preserved");
  assert(eqArr(r.profile.thresholds, [0.10, 0.20, 0.30]), "custom thresholds applied");
  assert(r.profile.maskOldThinking === "above-cutoff", "custom thinking policy applied");
}

// 6. User override on built-in profile merges.
{
  const r = resolveProfile("qwen-vllm", {
    "qwen-vllm": { effectiveContextCap: 65536 },
  }, {});
  assert(r.profile.effectiveContextCap === 65536, "qwen-vllm cap overridden to 65536");
  assert(eqArr(r.profile.thresholds, [0.20, 0.35, 0.55]), "non-overridden fields preserved from base");
}

// 7. Invalid override (mismatched lengths) keeps base, logs warning.
{
  const r = resolveProfile("default", {
    "default": { thresholds: [0.1, 0.2, 0.3, 0.4], coverage: [0.5, 0.6] },
  }, {});
  assert(r.warnings.some((w) => w.includes("length")), "length mismatch warning");
  assert(eqArr(r.profile.thresholds, [0.30, 0.45, 0.60]), "base thresholds preserved on invalid override");
}

// 8. Invalid maskOldThinking value rejected with warning.
{
  const r = resolveProfile("default", {
    "default": { maskOldThinking: "wat" },
  }, {});
  assert(r.warnings.some((w) => w.includes("maskOldThinking")), "thinking-policy warning");
  assert(r.profile.maskOldThinking === "off", "default thinking mask preserved");
}

// 9. Non-monotonic thresholds rejected.
{
  const r = resolveProfile("default", {
    "default": { thresholds: [0.5, 0.3, 0.7], coverage: [0.6, 0.7, 0.8] },
  }, {});
  assert(r.warnings.some((w) => w.includes("increasing")), "monotonic warning");
}

// 10. Out-of-range threshold rejected.
{
  const r = resolveProfile("default", {
    "default": { thresholds: [0.3, 0.5, 1.5], coverage: [0.6, 0.7, 0.8] },
  }, {});
  assert(r.warnings.some((w) => w.includes("[0, 1]")), "range warning");
}

// 11. renderPlaceholder substitutes correctly.
{
  const out = renderPlaceholder("[cm-masked read] {path} ({n} lines, {size})", {
    path: "/foo/bar.ts", n: 42, size: "1.2KB",
  });
  assert(out === "[cm-masked read] /foo/bar.ts (42 lines, 1.2KB)", "read placeholder substitution");
}
{
  const xml = renderPlaceholder('<elided tool="bash" cmd="{cmd}"/>', { cmd: "git status" });
  assert(xml === '<elided tool="bash" cmd="git status"/>', "XML placeholder substitution");
}
{
  // Unknown placeholder kept literal — never throws.
  const out = renderPlaceholder("foo {unknown} bar", { cmd: "x" });
  assert(out === "foo {unknown} bar", "unknown placeholder kept literal");
}

// 12. Thinking-block masking — content blocks of type "thinking" wiped to empty.
{
  const messages = [
    // 0: user
    { role: "user", content: [{ type: "text", text: "hi" }] },
    // 1: assistant with thinking + text
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Lots of internal reasoning here that should be wiped." },
        { type: "text", text: "Hello!" },
      ],
    },
    // 2: tool result (small — not masked by tool-result rules)
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] },
  ];
  // High pressure forces zone advance with default qwen thresholds.
  const result = compressStaleToolResults(messages, {
    thresholds: [0.2, 0.35, 0.55],
    coverage: [0.5, 0.75, 0.92],
    contextUsage: 0.8,
    previousCutoff: 0,
    zoneEntered: -1,
    maskOldThinking: "with-coverage",
  });
  assert(result !== null, "thinking mask produced a result");
  assert(result.masksApplied >= 1, "at least one mask applied");
  const assistantOut = result.messages[1];
  const thinkBlock = assistantOut.content.find((b) => b.type === "thinking");
  assert(thinkBlock && thinkBlock.thinking === "", "thinking content wiped to empty string");
  const textBlock = assistantOut.content.find((b) => b.type === "text");
  assert(textBlock && textBlock.text === "Hello!", "text content preserved verbatim");
}

// 13. maskOldThinking="off" leaves thinking alone.
{
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "should NOT be wiped" },
        { type: "text", text: "Hello!" },
      ],
    },
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] },
  ];
  const result = compressStaleToolResults(messages, {
    thresholds: [0.2, 0.35, 0.55],
    coverage: [0.5, 0.75, 0.92],
    contextUsage: 0.8,
    previousCutoff: 0,
    zoneEntered: -1,
    maskOldThinking: "off",
  });
  // Either null (no masks) or result without thinking change.
  if (result !== null) {
    const a = result.messages[1];
    const tb = a.content.find((b) => b.type === "thinking");
    assert(tb && tb.thinking === "should NOT be wiped", "thinking preserved when policy=off");
  }
}

// 14. Inline <think>...</think> in text is also stripped.
{
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Reply: <think>internal</think>visible part" },
      ],
    },
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] },
  ];
  const result = compressStaleToolResults(messages, {
    thresholds: [0.2, 0.35, 0.55],
    coverage: [0.5, 0.75, 0.92],
    contextUsage: 0.8,
    previousCutoff: 0,
    zoneEntered: -1,
    maskOldThinking: "with-coverage",
  });
  assert(result !== null, "inline <think> mask produced a result");
  const a = result.messages[1];
  const t = a.content[0];
  assert(t.text === "Reply: visible part", "inline <think>...</think> stripped");
}

// 15. Custom placeholder format applied.
{
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_1", arguments: { command: "git status" } },
      ],
    },
    {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "call_1",
      content: [{ type: "text", text: "x".repeat(500) }],
    },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ];
  const result = compressStaleToolResults(messages, {
    thresholds: [0.2, 0.35, 0.55],
    coverage: [0.5, 0.75, 0.92],
    contextUsage: 0.8,
    previousCutoff: 0,
    zoneEntered: -1,
    placeholderFormat: {
      bash: '<elided tool="bash" cmd="{cmd}"/>',
      read: '<elided tool="read" path="{path}" lines="{n}" size="{size}"/>',
    },
  });
  assert(result !== null, "custom placeholder produced a result");
  // Find the masked tool result.
  const masked = result.messages.find((m) =>
    m.role === "toolResult" && m.content?.[0]?.text?.startsWith("<elided"));
  assert(masked, "tool result was masked with custom XML format");
  assert(masked.content[0].text.includes('cmd="git status"'), "custom format includes command");
}

// 16. Malicious JSON-shaped runtime profile values never throw or poison the result.
{
  const malformedMaps = [null, [], 7];
  for (const map of malformedMaps) {
    const r = resolveProfile("default", map, {});
    assert(r.profile.placeholderFormat && typeof r.profile.placeholderFormat.bash === "string", "malformed profile map keeps safe templates");
    assert(r.warnings.some((w) => w.includes("plain object")), "malformed profile map warns");
  }
  for (const entry of [[], null, 4]) {
    const r = resolveProfile("custom", { custom: entry }, {});
    assert(r.warnings.some((w) => w.includes("plain object")), "malformed profile entry warns");
    assert(typeof r.profile.placeholderFormat.bash === "string", "malformed profile entry keeps safe template");
  }
  const malformed = [
    { thresholds: [], coverage: [0.5, 0.6, 0.7] },
    { thresholds: [0.2, Infinity, 0.5], coverage: [0.5, 0.6, 0.7] },
    { thresholds: [0.2, 0.3], coverage: [0.5, 0.6, 0.7] },
    { thresholds: [0.2, 0.2, 0.5], coverage: [0.5, 0.6, 0.7] },
    { thresholds: [0.2, NaN, 0.5], coverage: [0.5, 0.6, 0.7] },
    { thresholds: [0.2, 0.3, 0.5], coverage: [0.5, NaN, 0.7] },
    { effectiveContextCap: Infinity },
    { effectiveContextCap: NaN },
    { effectiveContextCap: 0 },
    { label: 12 },
    { maskOldThinking: "unsupported" },
    { placeholderFormat: { bash: 12, read: null } },
    { placeholderFormat: [] },
    { placeholderFormat: null },
    { placeholderFormat: { bash: "{cmd} {stderr}", read: "{path} {bad}" } },
  ];
  for (const override of malformed) {
    let r;
    try { r = resolveProfile("default", { default: override }, {}); }
    catch (error) { assert(false, "malformed override threw: " + String(error)); continue; }
    assert(typeof r.profile.label === "string", "malformed override keeps string label");
    assert(Array.isArray(r.profile.thresholds) && r.profile.thresholds.length > 0, "malformed override keeps thresholds");
    assert(Array.isArray(r.profile.coverage) && r.profile.coverage.length === r.profile.thresholds.length, "malformed override keeps aligned coverage");
    assert(typeof r.profile.placeholderFormat.bash === "string" && typeof r.profile.placeholderFormat.read === "string", "malformed override keeps string templates");
    assert(r.warnings.length > 0, "malformed override warns");
  }
  const stable = { default: { label: "stable", effectiveContextCap: 4096, placeholderFormat: { bash: "{cmd}", read: "{path} {n} {size}" } } };
  const first = resolveProfile("default", stable, {});
  const second = resolveProfile("default", stable, {});
  assert(JSON.stringify(first) === JSON.stringify(second), "repeated resolution is deterministic");
}

if (failures > 0) {
  console.error(\`\\n\${failures} test(s) failed\`);
  process.exit(1);
}
console.log("\\nAll v1.10.0 profile + thinking-mask tests passed.");
`;

writeFileSync(HARNESS_PATH, HARNESS);
let status = 1;
try {
  const result = spawnSync("npx", ["tsx", HARNESS_PATH], {
    cwd: cwd(),
    stdio: "inherit",
  });
  status = result.status ?? 1;
} finally {
  try { unlinkSync(HARNESS_PATH); } catch { /* best-effort */ }
}
exit(status);
