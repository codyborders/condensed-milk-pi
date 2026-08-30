/**
 * Provider-study arm definitions (grown test-first).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  providerStudyArm,
  PROVIDER_STUDY_ARMS,
  PROVIDER_STUDY_ARM_NAMES,
  providerStudyArmIdentitySha256,
  providerStudyArmIdentityMap,
  computeProviderStudyArmIdentitySha256,
} from "../runner/arms.mjs";
import * as arms from "../runner/arms.mjs";

const providerStudyArmExtensions = arms.providerStudyArmExtensions;
const providerStudyRetrievalSurface = arms.providerStudyRetrievalSurface;
const NEUTRAL_RETRIEVAL_EXTENSION = arms.NEUTRAL_RETRIEVAL_EXTENSION;

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

test("four immutable arms exist with pinned commits and roles", () => {
  assert.deepEqual(
    PROVIDER_STUDY_ARMS.map((arm) => arm.name),
    ["none", "upstream", "remediated-defaults", "remediated-archive"],
  );
  const none = providerStudyArm("none");
  assert.equal(none.commit, null);
  assert.equal(none.kind, "no-extension");
  assert.equal(providerStudyArm("remediated-archive").archiveEnabled, true);
  assert.throws(() => providerStudyArm("fork"), /unknown provider-study arm/);
});

test("arm identity hashes are distinct, stable, and bind config bytes", () => {
  const map = providerStudyArmIdentityMap(repoRoot);
  assert.equal(new Set(Object.values(map)).size, 4);
  for (const name of PROVIDER_STUDY_ARM_NAMES) {
    assert.match(map[name], /^[0-9a-f]{64}$/);
    assert.equal(providerStudyArmIdentitySha256(repoRoot, name), map[name]);
  }
  assert.notEqual(map["remediated-defaults"], map["remediated-archive"]);
});

test("neutral retrieval bytes are part of every applicable arm identity", () => {
  const none = providerStudyArm("none");
  const upstream = providerStudyArm("upstream");
  const remediated = providerStudyArm("remediated-defaults");
  const config = { sha256: "c".repeat(64) };
  const first = computeProviderStudyArmIdentitySha256({ arm: none, configSha256: config.sha256, neutralStubSha256: "1".repeat(64) });
  const second = computeProviderStudyArmIdentitySha256({ arm: none, configSha256: config.sha256, neutralStubSha256: "2".repeat(64) });
  assert.notEqual(first, second, "the none arm identity binds the neutral stub bytes");
  const upstreamFirst = computeProviderStudyArmIdentitySha256({ arm: upstream, configSha256: config.sha256, neutralStubSha256: "1".repeat(64) });
  const upstreamSecond = computeProviderStudyArmIdentitySha256({ arm: upstream, configSha256: config.sha256, neutralStubSha256: "2".repeat(64) });
  assert.notEqual(upstreamFirst, upstreamSecond, "the upstream arm identity binds the neutral stub bytes");
  const remediatedFirst = computeProviderStudyArmIdentitySha256({ arm: remediated, configSha256: config.sha256, neutralStubSha256: "1".repeat(64) });
  const remediatedSecond = computeProviderStudyArmIdentitySha256({ arm: remediated, configSha256: config.sha256, neutralStubSha256: "2".repeat(64) });
  assert.equal(remediatedFirst, remediatedSecond, "remediated arms load their own retrieval and do not bind the neutral stub");
});

test("none arm loads no Condensed Milk production extension and every arm shares the retrieval surface", () => {
  const extensions = providerStudyArmExtensions("none");
  assert.equal(extensions.length, 1);
  assert.equal(extensions[0], NEUTRAL_RETRIEVAL_EXTENSION);
  assert.ok(existsSync(extensions[0]), "the neutral retrieval stub must be checked in");
  assert.equal(
    extensions.some((path) => path.endsWith("index.ts")),
    false,
    "the none arm must never load a production index.ts",
  );
  const surface = providerStudyRetrievalSurface();
  assert.equal(surface.toolsArgv, "read,bash,edit,write,grep,find,ls,condensed_milk_retrieve");
  assert.equal(surface.retrievalToolName, "condensed_milk_retrieve");
  const stub = readFileSync(NEUTRAL_RETRIEVAL_EXTENSION, "utf8");
  assert.ok(stub.includes("condensed_milk_retrieve"));
  assert.ok(stub.includes("unavailable"));
});
