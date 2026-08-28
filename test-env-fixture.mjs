#!/usr/bin/env node
/**
 * Focused env-secret filter fixture (privacy boundary).
 * Slice 1: token-aware redaction — [REDACTED] for sensitive names only.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "cm-env-"));
for (const name of ["dispatch", "env"]) {
  writeFileSync(join(tmp, `${name}.ts`), readFileSync(`filters/${name}.ts`, "utf8"));
}
const compile = spawnSync("./node_modules/.bin/tsc", [
  "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler",
  "--skipLibCheck", "--strict", "false", "--noImplicitAny", "false",
  "--outDir", tmp,
  ...["dispatch", "env"].map((name) => join(tmp, `${name}.ts`)),
], { encoding: "utf8" });
if (compile.status !== 0) {
  console.error(compile.stdout, compile.stderr);
  process.exit(1);
}
await import(join(tmp, "env.js"));
const { dispatch } = await import(join(tmp, "dispatch.js"));

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  PASS  ${name}`);
  else { console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); failures++; }
}

const syntheticGithubToken = ["gh", "p_", "fixtureValue", "1234567890abcdef"].join("");
const syntheticAwsSecret = ["AK", "IA", "123456789012345678"].join("");
const syntheticAwsId = ["AK", "IA", "IOSFODNN7EXAMPLE"].join("");
const syntheticLicenseKey = ["sk", "-live-", "1234567890"].join("");

const envInput = [
  "SHELL=/bin/zsh",
  `GITHUB_TOKEN=${syntheticGithubToken}`,
  "MONKEY=banana",
  "APIARY=honey",
  "PASSPORT=doc123",
  "AUTHORIZED=no",
  "TOKENS=many",
  "SECRETS=some",
  "my_private_key=x",
  `AWS_SECRET_ACCESS_KEY=${syntheticAwsSecret}`,
  `AWS_ACCESS_KEY_ID=${syntheticAwsId}`,
  "DB_PASSWORD=hunter2000",
  "SHORTHAND_PASS=1",
  "AUTH=basic abcdefabcdef",
  "CREDENTIAL=topsecretcredential",
  "api_key=lowercase-secret-value",
  "KEYBOARD=qwerty-uiop",
  `LICENSE_KEY=${syntheticLicenseKey}`,
  "LONG_VAL=" + "x".repeat(120),
  "",
  "not an assignment line",
  "=weird",
  "export NOTE=diagnostic text kept",
].join("\n");
const result = dispatch({ command: "env", stdout: envInput, isError: false, toolName: "bash" });
const out = result?.output ?? "";
check("token secret redacted to [REDACTED]", out.includes("GITHUB_TOKEN=[REDACTED]"), JSON.stringify(out));
check("MONKEY not a false positive", out.includes("MONKEY=banana"), JSON.stringify(out));
check("secret value not present", !out.includes(syntheticGithubToken), JSON.stringify(out));

// Preservation: non-sensitive values never truncated.
check("long value never truncated", out.includes("LONG_VAL=" + "x".repeat(120)), JSON.stringify(out));

// Preservation: unknown lines, blank lines, and diagnostics kept verbatim.
// Exact equality also pins line order and every byte.
const expectedOut = [
  "SHELL=/bin/zsh",
  "GITHUB_TOKEN=[REDACTED]",
  "MONKEY=banana",
  "APIARY=honey",
  "PASSPORT=doc123",
  "AUTHORIZED=no",
  "TOKENS=many",
  "SECRETS=some",
  "my_private_key=[REDACTED]",
  "AWS_SECRET_ACCESS_KEY=[REDACTED]",
  "AWS_ACCESS_KEY_ID=[REDACTED]",
  "DB_PASSWORD=[REDACTED]",
  "SHORTHAND_PASS=[REDACTED]",
  "AUTH=[REDACTED]",
  "CREDENTIAL=[REDACTED]",
  "api_key=[REDACTED]",
  "KEYBOARD=qwerty-uiop",
  "LICENSE_KEY=[REDACTED]",
  "LONG_VAL=" + "x".repeat(120),
  "",
  "not an assignment line",
  "=weird",
  "export NOTE=diagnostic text kept",
].join("\n");
check("output exactly equals expected redaction (bytes and order)", out === expectedOut, JSON.stringify(out));

// Token boundaries: every sensitive token form redacted, false positives kept.
check("lowercase private key redacted", out.includes("my_private_key=[REDACTED]"), JSON.stringify(out));
check("aws secret access key redacted", out.includes("AWS_SECRET_ACCESS_KEY=[REDACTED]"));
check("password redacted", out.includes("DB_PASSWORD=[REDACTED]"));
check("underscore-boundary pass redacted", out.includes("SHORTHAND_PASS=[REDACTED]"));
check("auth redacted", out.includes("AUTH=[REDACTED]"));
check("credential redacted", out.includes("CREDENTIAL=[REDACTED]"));
check("lowercase api_key redacted", out.includes("api_key=[REDACTED]"));
check("underscore-bounded KEY segment redacts AWS_ACCESS_KEY_ID", out.includes("AWS_ACCESS_KEY_ID=[REDACTED]"));
check("LICENSE_KEY redacted", out.includes("LICENSE_KEY=[REDACTED]"));
check("KEYBOARD untouched (KEY not at boundary)", out.includes("KEYBOARD=qwerty-uiop"));
check("MONKEY untouched", out.includes("MONKEY=banana"));
check("APIARY untouched", out.includes("APIARY=honey"));
check("PASSPORT untouched", out.includes("PASSPORT=doc123"));
check("AUTHORIZED untouched", out.includes("AUTHORIZED=no"));
check("TOKENS untouched", out.includes("TOKENS=many"));
check("SECRETS untouched", out.includes("SECRETS=some"));

// Mandatory redaction: applies even when [REDACTED] makes output longer
// than input (the central shorter-output gate must not block privacy).
const tinySecrets = Array.from({ length: 12 }, (_, i) => `T${i}_TOKEN=1`).join("\n"); // 131 chars, redacted form is longer
const tinyResult = dispatch({ command: "env", stdout: tinySecrets, isError: false, toolName: "bash" });
check("redaction survives longer-than-input output", tinyResult !== null && tinyResult.output.includes("T0_TOKEN=[REDACTED]"), JSON.stringify(tinyResult));
const manyVars = Array.from({ length: 60 }, (_, i) => `VAR_${i}=value${i}`);
const manyResult = dispatch({ command: "env", stdout: [...manyVars, "SESSION_TOKEN=tok"].join("\n"), isError: false, toolName: "bash" });
const manyOut = manyResult?.output ?? "";
check("no 50-var cap and 61st var still redacted", manyOut.split("\n").filter((l) => l.startsWith("VAR_")).length === 60 && manyOut.includes("SESSION_TOKEN=[REDACTED]"), JSON.stringify(manyResult));

// Nothing sensitive → output untouched (dispatch returns null, filter
// must not rewrite clean output).
const cleanEnv = ["A=1", "B=2", "MONKEY=banana", "PATH=/usr/bin:/bin:/usr/sbin", "EDITOR=vim"].join("\n");
check("clean env output untouched", dispatch({ command: "env", stdout: cleanEnv, isError: false, toolName: "bash" }) === null);

// printenv shares the same redaction (same filter function, same ID).
const printenvInput = ["TOKEN=abc", "HOME=/home/user", "SHELL=/bin/zsh", "TERM=xterm-256color", "LANG=en_US.UTF-8"].join("\n");
check("printenv secrets redacted too", dispatch({ command: "printenv", stdout: printenvInput, isError: false, toolName: "bash" })?.output.includes("TOKEN=[REDACTED]") === true);

// Failed env results still redact secrets while preserving every error
// and diagnostic line. Only environment-secrets supports error output.
const failedEnvInput = [
  "env: invalid option -- z",
  "usage: env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]",
  "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE",
  "Try env --help for more information.",
].join("\n");
const failedEnv = dispatch({ command: "env", stdout: failedEnvInput, isError: true, toolName: "bash" });
check("failed env output still redacts secrets",
  failedEnv?.output.includes("AWS_SECRET_ACCESS_KEY=[REDACTED]") === true, JSON.stringify(failedEnv));
check("failed env output preserves error diagnostics",
  failedEnv?.output.includes("env: invalid option -- z") === true &&
  failedEnv?.output.includes("usage: env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]") === true &&
  failedEnv?.output.includes("Try env --help for more information.") === true, JSON.stringify(failedEnv));
check("failed printenv output still redacts secrets",
  dispatch({ command: "printenv", stdout: failedEnvInput, isError: true, toolName: "bash" })?.output.includes("AWS_SECRET_ACCESS_KEY=[REDACTED]") === true);

// Every other semantic filter must still decline failed output.
check("failed non-env output still passes through",
  dispatch({ command: "pytest", stdout: "================ FAILURES =================\nFAILED test_x\n".repeat(10), isError: true, toolName: "bash" }) === null);

// Compound commands: env or printenv plus another producer still gets the
// environment redactor on the combined text (it preserves every unknown
// line). Semantic filters stay disabled for multi-producer compounds.
const compoundCmd = 'env && printf "deploy step done"';
const combinedStdout = [
  "SHELL=/bin/zsh",
  "HOME=/home/user",
  "DB_PASSWORD=hunter2000",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "deploy step done",
].join("\n");
const compound = dispatch({ command: compoundCmd, stdout: combinedStdout, isError: false, toolName: "bash" });
check("compound env && printf masks the assignment",
  compound?.output.includes("DB_PASSWORD=[REDACTED]") === true, JSON.stringify(compound));
check("compound env && printf preserves printf text",
  compound?.output.includes("deploy step done") === true &&
  compound?.output.includes("SHELL=/bin/zsh") === true &&
  compound?.output.includes("PATH=/usr/local/bin:/usr/bin:/bin") === true, JSON.stringify(compound));
check("compound printenv && echo still redacts",
  dispatch({ command: "printenv && echo ready", stdout: combinedStdout, isError: false, toolName: "bash" })?.output.includes("DB_PASSWORD=[REDACTED]") === true);
check("compound multi-producer semantic filters stay off",
  dispatch({ command: "env && git status", stdout: ["DB_PASSWORD=hunter2000", "On branch main", "nothing to commit, working tree clean"].join("\n"), isError: false, toolName: "bash" })?.output.includes("DB_PASSWORD=[REDACTED]") === true &&
  dispatch({ command: "env && git status", stdout: ["DB_PASSWORD=hunter2000", "On branch main", "nothing to commit, working tree clean"].join("\n"), isError: false, toolName: "bash" })?.output.includes("On branch main") === true);

if (failures > 0) {
  console.error(`\nFAIL — ${failures} env check(s) failed.`);
  process.exit(1);
}
console.log("env fixture checks passed");
