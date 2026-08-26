#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { exit, cwd } from "node:process";

const harnessPath = join(cwd(), `.cm-profile-validation-${Date.now()}.mjs`);
const harness = `
import profilesMod from "./filters/profiles.ts";
const { resolveProfile } = profilesMod;
let failures = 0;
try {
  const result = resolveProfile(null, undefined, {});
  if (result.activeName !== "default") {
    console.error("FAIL: invalid active profile name did not fall back");
    failures++;
  }
  if (!result.warnings.some((warning) => warning.includes("active profile name") && warning.includes("string"))) {
    console.error("FAIL: invalid active profile name produced no warning");
    failures++;
  }

} catch (error) {
  console.error("FAIL: non-plain profile map must be safe", error);
  failures++;
}
if (failures) process.exit(1);
console.log("Profile runtime map validation test passed.");
`;
writeFileSync(harnessPath, harness);
let status = 1;
try {
  const result = spawnSync("npx", ["tsx", harnessPath], { cwd: cwd(), stdio: "inherit" });
  status = result.status ?? 1;
} finally {
  try { unlinkSync(harnessPath); } catch { /* best effort */ }
}
exit(status);
