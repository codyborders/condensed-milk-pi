import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const PROVIDER_STUDY_RUNTIME_DEPENDENCIES = Object.freeze([
  "graceful-fs",
  "proper-lockfile",
  "retry",
  "signal-exit",
  "typebox",
]);

function filesUnder(root, prefix = "") {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesUnder(path, relative));
    } else if (entry.isFile() && statSync(path).isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

function directorySha256(root) {
  const files = filesUnder(root);
  const hash = createHash("sha256");
  hash.update(`${files.length}\n`);
  for (const relative of files) {
    hash.update(`${relative}:`);
    hash.update(createHash("sha256").update(readFileSync(join(root, relative))).digest("hex"));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function providerStudyDependencySpecs(repoRoot) {
  return PROVIDER_STUDY_RUNTIME_DEPENDENCIES.map((name) => {
    const sourcePath = join(repoRoot, "node_modules", name);
    if (!existsSync(join(sourcePath, "package.json"))) {
      throw new Error(`provider-study runtime dependency ${name} is not installed`);
    }
    return { name, sourcePath, sha256: directorySha256(sourcePath) };
  });
}

export function providerStudyDependenciesSha256(repoRoot) {
  const specs = providerStudyDependencySpecs(repoRoot);
  const hash = createHash("sha256");
  for (const spec of specs) hash.update(`${spec.name}:${spec.sha256}\n`);
  return hash.digest("hex");
}
