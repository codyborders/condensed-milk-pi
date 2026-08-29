/**
 * Encrypted holdout bundle (grown test-first).
 *
 * The repository carries only public task ids, coverage categories,
 * per-task hashes, and the encrypted bundle with its digest. The key
 * lives in an external private .env (mode 0600) and is never printed
 * or persisted inside the repository or run metadata. Decryption goes
 * through an external ledger append and lands only in a private
 * temporary directory that is removed afterwards. Tests use temporary
 * keys and fixtures, never the real key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as holdoutModule from "../runner/holdout.mjs";

const generateHoldoutKey = holdoutModule.generateHoldoutKey;
const encryptHoldoutBundle = holdoutModule.encryptHoldoutBundle;
const decryptHoldoutBundle = holdoutModule.decryptHoldoutBundle;
const holdoutBundleEnvelopeSha256 = holdoutModule.holdoutBundleEnvelopeSha256;
const writeHoldoutKeyFile = holdoutModule.writeHoldoutKeyFile;
const ensureHoldoutKeyFile = holdoutModule.ensureHoldoutKeyFile;
const readHoldoutKey = holdoutModule.readHoldoutKey;
const providerStudyHoldoutKeyDefaultPath = holdoutModule.providerStudyHoldoutKeyDefaultPath;

test("the holdout key module exports its key-file surface", () => {
  assert.equal(typeof writeHoldoutKeyFile, "function");
  assert.equal(typeof ensureHoldoutKeyFile, "function");
  assert.equal(typeof readHoldoutKey, "function");
  assert.equal(typeof providerStudyHoldoutKeyDefaultPath, "function");
});

test("the holdout key writer preserves unrelated env values and never duplicates or echoes the key", () => {
  const work = mkdtempSync(join(tmpdir(), "cm-ps-holdout-keymerge-"));
  try {
    const keyPath = join(work, "nested", "holdout.env");
    mkdirSync(join(work, "nested"), { recursive: true });
    writeFileSync(keyPath, "# operator notes\nOTHER_TOKEN=abc123\nSECOND=x y\n", { mode: 0o600 });
    const ensured = ensureHoldoutKeyFile(keyPath);
    assert.equal(ensured.path, keyPath);
    assert.equal(ensured.generated, true, "a missing key entry is generated");
    assert.equal(ensured.key, undefined, "the ensure result never carries the key value");
    assert.equal(statSync(keyPath).mode & 0o777, 0o600, "the merged key file keeps mode 0600");
    const body = readFileSync(keyPath, "utf8");
    assert.equal(body.includes("OTHER_TOKEN=abc123"), true, "unrelated values survive");
    assert.equal(body.includes("SECOND=x y"), true, "unrelated values survive");
    assert.equal(body.includes("# operator notes"), true, "comments survive");
    assert.equal(body.match(/CM_PROVIDER_STUDY_HOLDOUT_KEY=/g)?.length, 1, "exactly one named key entry");
    const firstKey = readHoldoutKey({ keySourcePath: keyPath });
    assert.match(firstKey, /^[0-9a-f]{64}$/);
    const again = ensureHoldoutKeyFile(keyPath);
    assert.equal(again.generated, false, "an existing key entry is reused, never replaced");
    assert.equal(readHoldoutKey({ keySourcePath: keyPath }), firstKey, "the key value is stable across ensures");
    const rebody = readFileSync(keyPath, "utf8");
    assert.equal(rebody.match(/CM_PROVIDER_STUDY_HOLDOUT_KEY=/g)?.length, 1, "still exactly one named key entry");
    assert.equal(rebody.includes("OTHER_TOKEN=abc123"), true, "unrelated values still survive");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the holdout key lives in an external private env file with mode 0600 and never leaks through errors", () => {
  const work = mkdtempSync(join(tmpdir(), "cm-ps-holdout-key-"));
  try {
    const keyPath = join(work, "holdout.env");
    const written = writeHoldoutKeyFile(keyPath);
    assert.equal(written.path, keyPath);
    assert.equal(written.key, undefined, "the write result never carries the key value");
    const mode = statSync(keyPath).mode & 0o777;
    assert.equal(mode, 0o600, "the key file is created with mode 0600");
    const key = readHoldoutKey({ keySourcePath: keyPath });
    assert.match(key, /^[0-9a-f]{64}$/);
    const body = readFileSync(keyPath, "utf8");
    assert.equal(body.includes(key), true, "the env file holds the key for the external operator");
    assert.equal(body.startsWith("CM_PROVIDER_STUDY_HOLDOUT_KEY="), true, "the env file uses the documented key name");
    assert.equal(
      providerStudyHoldoutKeyDefaultPath().includes(join("condensed-milk-eval", "provider-study-holdout")),
      true,
      "the default key path sits under the external study cache",
    );
    const missing = join(work, "missing.env");
    assert.throws(() => readHoldoutKey({ keySourcePath: missing }), /holdout key source is missing/i);
    const badFormat = join(work, "bad.env");
    writeFileSync(badFormat, "CM_PROVIDER_STUDY_HOLDOUT_KEY=not-hex\n", "utf8");
    assert.throws(() => readHoldoutKey({ keySourcePath: badFormat }), /holdout key source/i, "an invalid key refuses without echoing the value");
    const empty = join(work, "empty.env");
    writeFileSync(empty, "OTHER=x\n", "utf8");
    assert.throws(() => readHoldoutKey({ keySourcePath: empty }), /holdout key source/i);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the holdout bundle module exports its crypto surface", () => {
  assert.equal(typeof generateHoldoutKey, "function");
  assert.equal(typeof encryptHoldoutBundle, "function");
  assert.equal(typeof decryptHoldoutBundle, "function");
  assert.equal(typeof holdoutBundleEnvelopeSha256, "function");
});

test("authenticated random-nonce encryption round-trips and fails closed on tampering or wrong key", () => {
  const key = generateHoldoutKey();
  assert.match(key, /^[0-9a-f]{64}$/, "the holdout key is 32 random bytes in hex");
  assert.notEqual(key, generateHoldoutKey(), "every generated key is fresh randomness");
  const plain = JSON.stringify({ schemaVersion: 1, tasks: [{ id: "holdout-task-01", prompt: "hidden" }] });
  const envelope = encryptHoldoutBundle({ plainText: plain, keyHex: key });
  assert.equal(envelope.algorithm, "aes-256-gcm");
  assert.equal(envelope.authenticated, true);
  assert.equal(typeof envelope.nonce, "string");
  assert.notEqual(envelope.nonce, encryptHoldoutBundle({ plainText: plain, keyHex: key }).nonce, "the nonce is random per encryption");
  const digest = holdoutBundleEnvelopeSha256(envelope);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(decryptHoldoutBundle({ envelope, keyHex: key }), plain);
  assert.throws(() => decryptHoldoutBundle({ envelope, keyHex: generateHoldoutKey() }), /authentic|decrypt/i);
  const tampered = { ...envelope, ciphertext: envelope.ciphertext.substring(0, envelope.ciphertext.length - 4) + (envelope.ciphertext.endsWith("AAAA") ? "BBBB" : "AAAA") };
  assert.throws(() => decryptHoldoutBundle({ envelope: tampered, keyHex: key }), /authentic|decrypt/i);
  const truncated = JSON.parse(JSON.stringify(envelope));
  truncated.plainSha256 = "0".repeat(64);
  assert.throws(() => decryptHoldoutBundle({ envelope: truncated, keyHex: key }), /plain.*digest|digest.*plain/i);
});
