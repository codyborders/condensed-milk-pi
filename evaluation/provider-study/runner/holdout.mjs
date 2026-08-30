/**
 * Encrypted holdout bundle (grown test-first).
 *
 * The repository carries only public task ids, coverage categories,
 * per-task plaintext hashes, and the encrypted bundle envelope with
 * its frozen digest. The holdout key is 32 random bytes held in an
 * external private .env (mode 0600) under the external study cache;
 * it is never printed, never persisted inside the repository, and
 * never written into run metadata, journals, receipts, or reports.
 *
 * Encryption is authenticated AES-256-GCM with a fresh random nonce
 * and a fresh random scrypt salt per envelope. Deterministic
 * encryption would leak plaintext-equality patterns across
 * regenerations, so the authenticated random-nonce form is used and
 * the resulting ciphertext digest is frozen in the freeze lock
 * instead. Decryption fails closed on any tag, digest, or shape
 * mismatch and never echoes key material.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { providerStudyHoldoutLedgerPath } from "./ledger.mjs";

const KEY_BYTES = 32;
const KDF_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: KEY_BYTES });

export const HOLDOUT_KEY_ENV_NAME = "CM_PROVIDER_STUDY_HOLDOUT_KEY";

/**
 * The documented external key location: an .env file under the
 * external study cache, outside this repository. The runner never
 * reads this path implicitly; holdout commands require the explicit
 * --holdout-key-source flag.
 */
export function providerStudyHoldoutKeyDefaultPath() {
  const base = process.env.XDG_CACHE_HOME
    ?? (process.platform === "darwin" ? join(homedir(), "Library", "Caches") : join(homedir(), ".cache"));
  return join(base, "condensed-milk-eval", "provider-study-holdout", "holdout.env");
}

/**
 * Write the holdout key .env with mode 0600 (directory 0700). The
 * return value carries only the path; the key value never leaves the
 * file and the caller's memory.
 */
export function writeHoldoutKeyFile(path, keyHex = generateHoldoutKey()) {
  if (typeof keyHex !== "string" || !/^[0-9a-f]{64}$/.test(keyHex)) {
    throw new Error("the holdout key must be 64 lowercase hex characters");
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${HOLDOUT_KEY_ENV_NAME}=${keyHex}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path };
}

/**
 * Ensure exactly one holdout key entry exists in an external .env.
 * Unrelated values and comments already present are preserved
 * verbatim; a missing named entry is generated once and then reused,
 * never replaced. The result never carries the key value.
 */
export function ensureHoldoutKeyFile(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("holdout key source path is required");
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    writeFileSync(path, "", { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  const lines = readFileSync(path, "utf8").split("\n");
  let keyLine = null;
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    if (line.substring(0, separator).trim() !== HOLDOUT_KEY_ENV_NAME) continue;
    keyLine = line;
    break;
  }
  let generated = false;
  if (keyLine === null) {
    keyLine = `${HOLDOUT_KEY_ENV_NAME}=${generateHoldoutKey()}`;
    generated = true;
    const endsWithNewline = lines.length === 0 || lines[lines.length - 1] === "";
    const body = `${lines.join("\n")}${endsWithNewline ? "" : "\n"}${keyLine}\n`;
    writeFileSync(path, body, { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  const kept = readFileSync(path, "utf8").match(new RegExp(`^${HOLDOUT_KEY_ENV_NAME}=`, "m"));
  if (kept === null) {
    throw new Error("the holdout key entry did not persist; refusing without echoing anything");
  }
  return { path, generated };
}

/**
 * Read the holdout key from an explicit .env path. Failures describe
 * the file, never the key value.
 */
export function readHoldoutKey({ keySourcePath }) {
  if (typeof keySourcePath !== "string" || keySourcePath.length === 0) {
    throw new Error("holdout key source path is required");
  }
  if (!existsSync(keySourcePath)) {
    throw new Error(`holdout key source is missing: ${keySourcePath}`);
  }
  let text;
  try {
    text = readFileSync(keySourcePath, "utf8");
  } catch (error) {
    throw new Error(`holdout key source is not readable: ${error?.code ?? "unknown"}`);
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const name = trimmed.substring(0, separator).trim();
    if (name !== HOLDOUT_KEY_ENV_NAME) continue;
    const rawValue = trimmed.substring(separator + 1).trim();
    const value = (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))
      ? rawValue.substring(1, rawValue.length - 1)
      : rawValue;
    if (!isHoldoutKey(value)) {
      throw new Error("holdout key source holds a malformed key value; refusing without echoing it");
    }
    return value;
  }
  throw new Error(`holdout key source has no ${HOLDOUT_KEY_ENV_NAME} entry`);
}

/** A fresh 32-byte holdout key as lowercase hex, for in-memory use only. */
export function generateHoldoutKey() {
  return randomBytes(KEY_BYTES).toString("hex");
}

function isHoldoutKey(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function deriveKey(keyHex, salt) {
  return scryptSync(keyHex, salt, KDF_PARAMS.keylen, { N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p });
}

/**
 * Encrypt one holdout bundle plaintext into an authenticated
 * aes-256-gcm envelope with fresh random salt and nonce. The envelope
 * also carries the plaintext digest so decryption can verify both the
 * GCM tag and the recovered bytes.
 */
export function encryptHoldoutBundle({ plainText, keyHex }) {
  if (typeof plainText !== "string" || plainText.length === 0) {
    throw new Error("the holdout bundle plaintext must be a non-empty string");
  }
  if (!isHoldoutKey(keyHex)) {
    throw new Error("the holdout key must be 64 lowercase hex characters");
  }
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = deriveKey(keyHex, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    schemaVersion: 1,
    algorithm: "aes-256-gcm",
    authenticated: true,
    kdf: { name: "scrypt", ...KDF_PARAMS },
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: authTag.toString("base64"),
    plainSha256: createHash("sha256").update(plainText, "utf8").digest("hex"),
  };
}

function envelopeFieldBase64(envelope, field) {
  const value = envelope?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`the holdout bundle envelope has no ${field}; refusing`);
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.toString("base64") !== value) {
    throw new Error(`the holdout bundle envelope ${field} is not valid base64; refusing`);
  }
  return buffer;
}

/**
 * Decrypt one holdout bundle envelope. Fails closed on any schema,
 * algorithm, authentication-tag, or plaintext-digest mismatch. Never
 * echoes key material.
 */
export function decryptHoldoutBundle({ envelope, keyHex }) {
  if (!isHoldoutKey(keyHex)) {
    throw new Error("the holdout key must be 64 lowercase hex characters");
  }
  if (envelope?.schemaVersion !== 1) {
    throw new Error("the holdout bundle envelope schema is unsupported; refusing");
  }
  if (envelope.algorithm !== "aes-256-gcm" || envelope.authenticated !== true) {
    throw new Error("the holdout bundle envelope is not authenticated aes-256-gcm; refusing");
  }
  const salt = envelopeFieldBase64(envelope, "salt");
  const nonce = envelopeFieldBase64(envelope, "nonce");
  const ciphertext = envelopeFieldBase64(envelope, "ciphertext");
  const authTag = envelopeFieldBase64(envelope, "authTag");
  if (authTag.length !== 16) {
    throw new Error("the holdout bundle auth tag has the wrong length; refusing");
  }
  if (nonce.length !== 12) {
    throw new Error("the holdout bundle nonce has the wrong length; refusing");
  }
  const key = deriveKey(keyHex, salt);
  let plainBuffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(authTag);
    plainBuffer = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("the holdout bundle failed authenticated decryption; refusing");
  }
  const plainText = plainBuffer.toString("utf8");
  const digest = createHash("sha256").update(plainText, "utf8").digest("hex");
  if (typeof envelope.plainSha256 !== "string" || !timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(envelope.plainSha256, "hex"))) {
    throw new Error("the holdout bundle plaintext digest does not match the envelope; refusing");
  }
  return plainText;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

/** The frozen digest over one holdout bundle envelope's canonical bytes. */
export function holdoutBundleEnvelopeSha256(envelope) {
  return createHash("sha256").update(stableStringify(envelope), "utf8").digest("hex");
}

export function holdoutTaskSha256(privateTask) {
  return createHash("sha256").update(stableStringify(privateTask), "utf8").digest("hex");
}

/** Frozen digest over any decrypted holdout object (scorer, solution, fixture). */
export function holdoutObjectSha256(value) {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

/** The committed holdout bundle path inside the provider-study tree. */
export function providerStudyHoldoutBundlePath(repoRoot) {
  return join(repoRoot, "evaluation", "provider-study", "holdout.enc");
}

/** Read and shape-check the committed holdout bundle envelope. */
export function readHoldoutBundleEnvelope(repoRoot) {
  const path = providerStudyHoldoutBundlePath(repoRoot);
  if (!existsSync(path)) {
    throw new Error(`the encrypted holdout bundle is missing at ${path}`);
  }
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("the encrypted holdout bundle is not valid JSON; refusing");
  }
  if (envelope?.algorithm !== "aes-256-gcm" || typeof envelope?.ciphertext !== "string") {
    throw new Error("the encrypted holdout bundle envelope is malformed; refusing");
  }
  return envelope;
}

export async function withHoldoutTasks({ repoRoot, runsRoot, command, keySourcePath, taskIds, fn }) {
  const { providerStudyRejectInsideRepo } = await import("./paid.mjs");
  if (typeof keySourcePath !== "string" || keySourcePath.length === 0) {
    throw new Error(`${command} needs --holdout-key-source PATH; refusing before any holdout byte is read`);
  }
  providerStudyRejectInsideRepo(runsRoot, repoRoot);
  const ledgerPath = providerStudyHoldoutLedgerPath(runsRoot);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(
    ledgerPath,
    `${JSON.stringify({ at: new Date().toISOString(), command, phase: "holdout", taskIds })}\n`,
    "utf8",
  );
  const privateDir = mkdtempSync(join(tmpdir(), "cm-holdout-"));
  chmodSync(privateDir, 0o700);
  try {
    const keyHex = readHoldoutKey({ keySourcePath });
    const envelope = readHoldoutBundleEnvelope(repoRoot);
    const plainText = decryptHoldoutBundle({ envelope, keyHex });
    const privatePath = join(privateDir, "holdout-private.json");
    writeFileSync(privatePath, plainText, { mode: 0o600 });
    chmodSync(privatePath, 0o600);
    let parsed;
    try {
      parsed = JSON.parse(plainText);
    } catch {
      throw new Error("the decrypted holdout bundle is not valid JSON; refusing");
    }
    const tasks = new Map();
    for (const task of parsed?.tasks ?? []) {
      tasks.set(task.id, task);
    }
    const { loadProviderStudyManifestFile } = await import("./manifest.mjs");
    const loaded = loadProviderStudyManifestFile(repoRoot, { phase: "holdout" });
    for (const publicTask of loaded.tasks) {
      const privateTask = tasks.get(publicTask.id);
      if (privateTask === undefined) {
        throw new Error(`the holdout bundle has no task ${publicTask.id}; refusing`);
      }
      if (holdoutTaskSha256(privateTask) !== publicTask.taskSha256) {
        throw new Error(`holdout task ${publicTask.id} does not match its public hash; refusing`);
      }
      for (const [field, publicField] of [
        ["scorer", "scorerSha256"],
        ["solution", "solutionSha256"],
        ["fixture", "fixtureSha256"],
      ]) {
        if (holdoutObjectSha256(privateTask[field]) !== publicTask[publicField]) {
          throw new Error(`holdout task ${publicTask.id} ${field} hash does not match; refusing`);
        }
      }
      tasks.set(publicTask.id, {
        ...privateTask,
        scorerSha256: publicTask.scorerSha256,
        solutionSha256: publicTask.solutionSha256,
        fixtureSha256: publicTask.fixtureSha256,
      });
    }
    return await fn({ tasks, privateDir });
  } finally {
    rmSync(privateDir, { recursive: true, force: true });
  }
}
