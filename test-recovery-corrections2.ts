/**
 * Recovery metadata and directory tests.
 *
 * Run: npx tsx test-recovery-corrections2.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { packageVersion, recoveryAgentRoot, recoveryRoot } from "./filters/recovery.js";

let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`PASS ${name}`);
}

{
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  assert.equal(packageVersion(), manifest.version, "telemetry version comes from package.json");
  assert.notEqual(packageVersion(), "1.10.0", "stale hardcoded version is gone");
  ok("package version metadata");
}

{
  const expectedAgentRoot = join(homedir(), ".pi", "agent");
  assert.equal(recoveryAgentRoot({}), expectedAgentRoot, "default uses the normal Pi agent directory");
  assert.equal(recoveryAgentRoot({ PI_CODING_AGENT_DIR: "" }), expectedAgentRoot, "empty override uses the default");
  assert.equal(recoveryRoot({}), join(expectedAgentRoot, "condensed-milk-recovery"));

  const customAgentRoot = join(process.cwd(), "custom-pi-agent");
  assert.equal(
    recoveryAgentRoot({ PI_CODING_AGENT_DIR: customAgentRoot }),
    customAgentRoot,
    "custom Pi agent directory is used exactly",
  );
  assert.equal(
    recoveryRoot({ PI_CODING_AGENT_DIR: customAgentRoot }),
    join(customAgentRoot, "condensed-milk-recovery"),
    "archive root stays below the custom Pi agent directory",
  );
  ok("default and customized Pi agent directories");
}

console.log(`recovery corrections2 tests: ${passed} groups passed`);
