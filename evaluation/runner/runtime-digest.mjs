/**
 * Deterministic manifest digest for executable runtime trees.
 *
 * Covers a whole runtime package including its bundled executable
 * dependencies: every entry under the runtime root is walked with
 * readdir(3) plus lstat(2), never following symlinks during the walk.
 * The manifest records, per entry sorted by relative path:
 * - regular files: type marker, mode, relative path, SHA-256 of contents;
 * - symlinks: type marker, mode, relative path, and the link target
 *   string (recorded, not followed).
 *
 * Fail-closed: special files (FIFOs, sockets, devices) and symlinks
 * whose target resolves outside the runtime root are refused. The
 * returned digest pins the exact executable bytes, not a version
 * number. No credential material is involved anywhere in this module.
 */

import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const READ_CHUNK_BYTES = 1024 * 1024;

/** Stream one file through SHA-256 without buffering it whole. */
function sha256FileChunks(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    for (;;) {
      const read = readSync(fd, buffer, 0, READ_CHUNK_BYTES, null);
      if (read === 0) break;
      hash.update(read === READ_CHUNK_BYTES ? buffer : buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function modeText(mode) {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/** True when the resolved real path sits outside the runtime root. */
function resolvedEscapes(root, resolved) {
  const rel = relative(root, resolved);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel);
}

function walk(root, current, entries) {
  for (const dirent of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, dirent.name);
    let info;
    try {
      info = lstatSync(absolute);
    } catch (error) {
      throw new Error(`runtime manifest cannot stat an entry (${error?.code ?? "unknown"}); refusing`);
    }
    const relativePath = relative(root, absolute).split(sep).join("/");
    if (info.isDirectory()) {
      walk(root, absolute, entries);
      continue;
    }
    if (info.isSymbolicLink()) {
      let target;
      try {
        target = readlinkSync(absolute);
      } catch {
        throw new Error("runtime manifest cannot read a symlink target; refusing");
      }
      if (isAbsolute(target)) {
        throw new Error("runtime manifest contains an absolute symlink target; refusing");
      }
      // Resolve the full chain: cyclic links surface as ELOOP and are
      // refused; the fully resolved target decides containment. The
      // contents the link points at are hashed exactly once under their
      // canonical physical path, so links never duplicate traversal.
      let resolved;
      try {
        resolved = realpathSync(absolute);
      } catch (error) {
        if (error?.code === "ELOOP") {
          throw new Error("runtime manifest contains a cyclic symlink; refusing");
        }
        throw new Error(`runtime manifest cannot resolve a symlink (${error?.code ?? "unknown"}); refusing`);
      }
      if (resolvedEscapes(root, resolved)) {
        throw new Error("runtime manifest contains a symlink escaping the runtime root; refusing");
      }
      entries.push({ path: relativePath, line: `l ${modeText(info.mode)} ${relativePath} ${target}\n` });
      continue;
    }
    if (!info.isFile()) {
      throw new Error("runtime manifest contains a special file; refusing");
    }
    entries.push({ path: relativePath, line: `f ${modeText(info.mode)} ${relativePath} ${sha256FileChunks(absolute)}\n` });
  }
}

/**
 * Compute the deterministic manifest digest for one runtime root.
 * Returns { schemaVersion, algorithm, entryCount, digest }.
 */
export function computeRuntimeDigest({ runtimeDir }) {
  // Canonicalize the root: the walk records non-canonical prefixes
  // (for example /var versus /private/var), while link resolution
  // always returns real paths, so containment needs a real root.
  const root = realpathSync(resolve(runtimeDir));
  const entries = [];
  walk(root, root, entries);
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const digest = createHash("sha256")
    .update(entries.map((entry) => entry.line).join(""))
    .digest("hex");
  return { schemaVersion: 1, algorithm: "sha256", entryCount: entries.length, digest };
}
