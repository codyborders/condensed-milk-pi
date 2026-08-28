import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const lockfile = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const readme = await readFile(join(root, "README.md"), "utf8");
const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
const docs = `${readme}\n${changelog}`;
const forkUrl = "https://github.com/codyborders/condensed-milk-pi";

assert.equal(packageJson.name, "@codyborders/condensed-milk-pi");
assert.equal(packageJson.version, "1.10.1-remediated.1");
assert.equal(packageJson.repository.url, `${forkUrl}.git`);
assert.equal(packageJson.homepage, `${forkUrl}#readme`);
assert.equal(packageJson.bugs.url, `${forkUrl}/issues`);
assert.equal(packageJson.author, "tomooshi", "upstream author credit must remain");
assert.equal(packageJson.dependencies["proper-lockfile"], "4.1.2", "runtime lock dependency stays pinned to the reviewed version");
assert.equal(packageJson.devDependencies["@types/proper-lockfile"], "4.1.4", "lock type declarations stay pinned");
assert.equal(lockfile.packages["node_modules/proper-lockfile"].version, "4.1.2", "lockfile pins the reviewed lock implementation");
assert.equal(packageJson.maintainer.name, "codyborders");
assert.equal(packageJson.maintainer.url, forkUrl);
assert.ok(packageJson.contributors.some((credit) => credit.name === "tomooshi"), "upstream credit must remain in contributors");
assert.equal(lockfile.name, packageJson.name);
assert.equal(lockfile.version, packageJson.version);
assert.equal(lockfile.packages[""].name, packageJson.name);
assert.equal(lockfile.packages[""].version, packageJson.version);

// Approved contract change: npm registry install lines are removed; the
// pinned GitHub-tag install is the documented installation path.
assert.doesNotMatch(readme, /npm install @codyborders\/condensed-milk-pi/, "npm registry install line must stay removed");
assert.doesNotMatch(readme, /pi install npm:@codyborders\/condensed-milk-pi/, "pi npm-registry install line must stay removed");
assert.match(readme, /pi install https:\/\/github\.com\/codyborders\/condensed-milk-pi@v1\.10\.1-remediated\.1/);
assert.match(readme, /v1\.10\.1-remediated\.0 stays unchanged/);
assert.match(readme, /git clone https:\/\/github\.com\/codyborders\/condensed-milk-pi\.git/);
assert.doesNotMatch(readme, /pi install npm:@tomooshi\/condensed-milk-pi/);
assert.doesNotMatch(readme, /git clone https:\/\/github\.com\/tomooshi\/condensed-milk-pi/);
assert.doesNotMatch(docs, /paid(?:-task)? evaluation was not run|paid-task study remains not run/i);
assert.match(readme, /20 valid task pairs and 40 selected attempts/);
assert.match(readme, /one stochastic run cannot establish causality|one completed sanitized Z\.AI run/i);
assert.match(readme, /This prerelease includes bounded output recovery/);
assert.match(readme, /condensed_milk_retrieve/);
assert.match(readme, /Safe defaults: `environment-secrets`, `pytest`, and `git-status-porcelain`/);
assert.match(readme, /Git log compression and generic log deduplication now require global opt-in/);
assert.match(readme, /upstream v1\.10\.0/);
assert.match(readme, /stable IDs/);
assert.match(readme, /~\/\.config\/condensed-milk\.json/);
assert.match(readme, /1\.10\.1-remediated\.1/);
assert.match(readme, /roll back/i);

console.log("package identity and fork documentation checks passed");
