import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const workflow = await readFile(join(root, ".github/workflows/manual-release.yml"), "utf8");

assert.match(workflow, /^name: Manual release gate/m);
assert.match(workflow, /on:\n  workflow_dispatch:/);
assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule):/m);
assert.match(workflow, /expected_commit:\n\s+description:/);
assert.match(workflow, /version:\n\s+description:/);
assert.match(workflow, /confirmation:\n\s+description:/);
assert.match(workflow, /permissions:\n  contents: read/);
assert.match(workflow, /jobs:\n  verify:/);
assert.match(workflow, /fetch-depth: 0/);
assert.match(workflow, /refs\/heads\/main/);
assert.match(workflow, /HEAD_SHA.*git rev-parse HEAD/);
assert.match(workflow, /HEAD_SHA.*EXPECTED_COMMIT/);
assert.match(workflow, /HEAD_SHA.*MAIN_SHA/);
assert.match(workflow, /git fetch origin main --tags/);
assert.match(workflow, /RELEASE/);
assert.match(workflow, /package\.json/);
assert.match(workflow, /package-lock\.json/);
assert.match(workflow, /git status --porcelain/);
assert.equal((workflow.match(/^\s+npm test$/gm) ?? []).length, 3, "verification runs npm test three times");
for (const command of [
  "npm ci",
  "npm run typecheck",
  "npm run evaluation:validate",
  "npm run evaluation:fixtures",
  "npm run evaluation:test",
  "npm run evaluation:dry-run",
  "npm run masking:validate",
  "npm run masking:fixtures",
  "npm run masking:prepare",
  "npm run masking:dry-run",
  "npm run benchmark:test",
  "npm run benchmark:archive",
  "npm audit --omit=dev",
  "npm pack --dry-run --json",
]) assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(workflow, /--run-id release-masking-unpaid/);
assert.match(workflow, /package[/\\]evaluation|evaluation[/\\]packages|benchmarks|tests|workflows|credentials|node_modules/);
assert.match(workflow, /Recheck clean worktree|recheck clean tree/i);
assert.match(workflow, /release:\n\s+needs: verify/);
assert.match(workflow, /release:[\s\S]*permissions:\n\s+contents: write/);
assert.match(workflow, /environment:\n\s+name: corrective-prerelease/);
assert.match(workflow, /checkout[^\n]*exact verified SHA|ref: \$\{\{ needs\.verify\.outputs\.verified_sha \}\}/i);
assert.match(workflow, /tag_exists: \$\{\{ steps\.verify-head\.outputs\.tag_exists \}\}/);
assert.match(workflow, /existing tag targets a different commit/);
assert.match(workflow, /GitHub release already exists/);
assert.match(workflow, /if: needs\.verify\.outputs\.tag_exists != 'true'/);
assert.match(workflow, /git tag --annotate/);
assert.match(workflow, /git push origin "\$TAG"/);
assert.match(workflow, /gh release create/);
assert.doesNotMatch(workflow, /npm publish/);

console.log("manual release workflow safety checks passed");
