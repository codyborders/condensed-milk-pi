import assert from "node:assert/strict";
import { dispatch, configureFilters } from "./filters/dispatch.js";
configureFilters({ "git-diff": true });
import "./filters/git-status.js";
import "./filters/git-diff.js";
import "./filters/git-log.js";
import "./filters/git-mutations.js";
configureFilters({ "git-log-verbose": true, "git-add": true, "git-commit": true, "git-push": true });

const input = [
  "## main...origin/main",
  "M  src/alpha.ts",
  "M  src/bravo.ts",
  "M  src/charlie.ts",
  "M  src/delta.ts",
  "R  src/legacy-config.ts -> src/config.ts",
  " M test/alpha.test.ts",
  " M test/bravo.test.ts",
  " M test/charlie.test.ts",
  " M test/delta.test.ts",
  " M test/epsilon.test.ts",
  "?? docs/alpha.md",
  "?? docs/bravo.md",
  "?? docs/charlie.md",
  "?? docs/delta.md",
  "?? docs/epsilon.md",
].join("\n");
const result = dispatch({ command: "git status --porcelain=v1", stdout: input, isError: false, toolName: "bash" });
assert.ok(result, `result=${JSON.stringify(result)} input=${input.length}`);
assert.equal(result.output, "on main: 5 staged, 5 modified, 5 untracked [src/alpha.ts, src/bravo.ts, src/charlie.ts, src/delta.ts, src/config.ts, test/alpha.test.ts, test/bravo.test.ts, test/charlie.test.ts, test/delta.test.ts, test/epsilon.test.ts, docs/alpha.md, docs/bravo.md, docs/charlie.md, docs/delta.md, docs/epsilon.md]");
assert.ok(result.output.length < input.length);
const v2 = [
  "# branch.oid abcdef1234567890",
  "# branch.head main",
  "1 .M N... 100644 100644 100644 abc abc src/tracked.ts",
  "2 R. N... 100644 100644 100644 abc def R100 src/renamed.ts\tsrc/old.ts",
  "u UU N... 100644 100644 100644 100644 abc def ghi src/conflict.ts",
  "? src/untracked.ts",
].join("\n");
const v2Result = dispatch({ command: "git status --porcelain=v2", stdout: v2, isError: false, toolName: "bash" });
assert.ok(v2Result);
assert.equal(v2Result.output, "on main: 1 staged, 1 modified, 1 untracked, 1 conflicted [src/tracked.ts, src/renamed.ts, src/conflict.ts, src/untracked.ts]");
assert.ok(v2Result.output.length < v2.length);
const v2Spaced = [
  "# branch.oid abcdef1234567890",
  "# branch.head feature/spaces",
  "1 .M N... 100644 100644 100644 abc abc src/tracked file.ts",
  "2 R. N... 100644 100644 100644 abc def R100 destination file.ts\toriginal file.ts",
  "u UU N... 100644 100644 100644 100644 abc def ghi conflict file.ts",
  "? untracked file.ts",
].join("\n");
const v2SpacedResult = dispatch({ command: "git status --porcelain=v2", stdout: v2Spaced, isError: false, toolName: "bash" });
assert.ok(v2SpacedResult);
assert.equal(v2SpacedResult.output, "on feature/spaces: 1 staged, 1 modified, 1 untracked, 1 conflicted [src/tracked file.ts, destination file.ts, conflict file.ts, untracked file.ts]");
const v2MalformedQuote = v2Spaced.replace("src/tracked file.ts", '"src/tracked file.ts');
assert.equal(dispatch({ command: "git status --porcelain=v2", stdout: v2MalformedQuote, isError: false, toolName: "bash" }), null);
const shortStatus = [
  "## feature/spaces...origin/feature/spaces",
  " M path with many spaces and a long filename.ts",
  "?? another untracked path with spaces.md",
  "A  staged path with spaces.txt",
  ...Array.from({ length: 20 }, (_, i) => `!! extra-${i}.txt`),
].join("\n");
const shortStatusResult = dispatch({ command: "git status -s", stdout: shortStatus, isError: false, toolName: "bash" });
assert.ok(shortStatusResult);
assert.ok(shortStatusResult.output.startsWith("on feature/spaces: 1 staged, 1 modified, 1 untracked [path with many spaces and a long filename.ts, another untracked path with spaces.md, staged path with spaces.txt"));
const diff = [
  "diff --git a/old.txt b/new.txt",
  "old mode 100644",
  "new mode 100755",
  "similarity index 90%",
  "rename from old.txt",
  "rename to new.txt",
  "--- a/old.txt",
  "+++ b/new.txt",
  "@@ -1,40 +1,40 @@",
  ...Array.from({ length: 4 }, (_, i) => ` context ${i + 1} ${"x".repeat(100)}`),
  "-removed",
  "+added",
  ...Array.from({ length: 3 }, (_, i) => ` after ${i + 1} ${"y".repeat(100)}`),
  "\\ No newline at end of file",
].join("\n");
const diffResult = dispatch({ command: "git diff", stdout: diff, isError: false, toolName: "bash" });
assert.ok(diffResult);
assert.ok(diffResult.output.includes("--- a/old.txt"));
assert.ok(diffResult.output.includes("+++ b/new.txt"));
assert.ok(diffResult.output.includes(" context 3 "));
assert.ok(diffResult.output.includes(" context 4 "));
assert.ok(!diffResult.output.split("\n").some((line) => line.startsWith(" context 1 ")));
assert.ok(diffResult.output.includes("... 2 unchanged lines ..."));
assert.ok(diffResult.output.includes("\\ No newline at end of file"));
const trailingContextDiff = [
  "diff --git a/context.txt b/context.txt",
  "index abc..def 100644",
  "--- a/context.txt",
  "+++ b/context.txt",
  "@@ -1,10 +1,11 @@",
  " before",
  "-old",
  "+new",
  ...Array.from({ length: 6 }, (_, i) => ` after ${i + 1}`),
].join("\n");
const trailingContextResult = dispatch({ command: "git diff", stdout: trailingContextDiff, isError: false, toolName: "bash" });
assert.ok(trailingContextResult);
assert.ok(trailingContextResult.output.includes(" after 1"));
assert.ok(trailingContextResult.output.includes(" after 2"));
assert.ok(!trailingContextResult.output.includes(" after 3"));
assert.ok(!trailingContextResult.output.includes(" after 6"));
assert.ok(trailingContextResult.output.includes("  ... 4 unchanged lines ..."));
const separatedContextDiff = [
  "diff --git a/separated.txt b/separated.txt",
  "index abc..def 100644",
  "--- a/separated.txt",
  "+++ b/separated.txt",
  "@@ -1,14 +1,16 @@",
  " before",
  "-old one",
  "+new one",
  ...Array.from({ length: 6 }, (_, i) => ` middle ${i + 1} ${"m".repeat(30)}`),
  "-old two",
  "+new two",
  " after",
].join("\n");
const separatedContextResult = dispatch({ command: "git diff", stdout: separatedContextDiff, isError: false, toolName: "bash" });
assert.ok(separatedContextResult);
assert.ok(separatedContextResult.output.includes(" middle 1"));
assert.ok(separatedContextResult.output.includes(" middle 2"));
assert.ok(!separatedContextResult.output.includes(" middle 3"));
assert.ok(!separatedContextResult.output.includes(" middle 4"));
assert.ok(separatedContextResult.output.includes(" middle 5"));
assert.ok(separatedContextResult.output.includes(" middle 6"));
assert.ok(separatedContextResult.output.includes("  ... 2 unchanged lines ..."));
const shortSeparatedDiff = [
  "diff --git a/short-separated.txt b/short-separated.txt",
  "index abc..def 100644",
  "--- a/short-separated.txt",
  "+++ b/short-separated.txt",
  "@@ -1,10 +1,12 @@",
  " before",
  "-old one",
  "+new one",
  ...Array.from({ length: 4 }, (_, i) => ` middle ${i + 1} ${"m".repeat(30)}`),
  "-old two",
  "+new two",
  ...Array.from({ length: 5 }, (_, i) => ` trailing ${i + 1} ${"t".repeat(30)}`),
].join("\n");
const shortSeparatedResult = dispatch({ command: "git diff", stdout: shortSeparatedDiff, isError: false, toolName: "bash" });
assert.ok(shortSeparatedResult);
assert.ok(shortSeparatedResult.output.includes("middle 1"));
assert.ok(shortSeparatedResult.output.includes("middle 2"));
assert.ok(shortSeparatedResult.output.includes("middle 3"));
assert.ok(shortSeparatedResult.output.includes("middle 4"));
assert.equal(shortSeparatedResult.output.split("\n").filter((line) => line.includes("unchanged lines")).length, 1);
const combinedDiff = [
  "diff --cc combined.txt",
  "index abc,def..ghi",
  "--- a/combined.txt",
  "+++ b/combined.txt",
  "@@@ -1,2 -1,2 +1,2 @@@",
  "- ours",
  "+ theirs",
  "  combined output stays extractive",
].join("\n");
assert.equal(dispatch({ command: "git diff", stdout: combinedDiff, isError: false, toolName: "bash" }), null);
const log = [
  "commit 0123456789abcdef0123456789abcdef01234567",
  "Author: A <a@example.com>",
  "Date:   Thu Jan 1 00:00:00 1970 +0000",
  "",
  "    first subject",
  "",
  "    body",
  "commit fedcba9876543210fedcba9876543210fedcba98",
  "Author: B <b@example.com>",
  "Date:   Fri Jan 2 00:00:00 1970 +0000",
  "",
  "    second subject",
  "",
  "    body",
].join("\n");
const logResult = dispatch({ command: "git log", stdout: log, isError: false, toolName: "bash" });
assert.ok(logResult);
assert.equal(logResult.output, "0123456789abcdef0123456789abcdef01234567 first subject\nfedcba9876543210fedcba9876543210fedcba98 second subject");
assert.ok(logResult.output.length < log.length);
const decoratedLog = log.replace("commit 0123456789abcdef0123456789abcdef01234567", "commit 0123456789abcdef0123456789abcdef01234567 (HEAD -> main)");
assert.equal(dispatch({ command: "git log --decorate", stdout: decoratedLog, isError: false, toolName: "bash" }), null);
assert.equal(dispatch({ command: "git log", stdout: "not a git log\n".repeat(20), isError: false, toolName: "bash" }), null);
const commitResult = dispatch({ command: "git commit", stdout: "[main abc1234] add spaced paths\n 1 file changed, 1 insertion(+)\n".repeat(5), isError: false, toolName: "bash" });
assert.ok(commitResult);
assert.equal(commitResult.output, "commit abc1234 add spaced paths");
const pushResult = dispatch({ command: "git push", stdout: "To github.com:example/repo.git\n   abc1234..def5678  main -> main\n".repeat(3), isError: false, toolName: "bash" });
assert.ok(pushResult);
assert.equal(pushResult.output, "pushed To github.com:example/repo.git; main -> main");
const newPush = dispatch({ command: "git push", stdout: "To github.com:example/repo.git\n * [new branch]      main -> main\n".repeat(3), isError: false, toolName: "bash" });
assert.ok(newPush);
assert.equal(newPush.output, "pushed To github.com:example/repo.git; main -> main");
const upToDate = dispatch({ command: "git push", stdout: "Everything up-to-date\n".repeat(5), isError: false, toolName: "bash" });
assert.ok(upToDate);
assert.equal(upToDate.output, "Everything up-to-date");
const cleanCommit = dispatch({ command: "git commit", stdout: "On branch main\n\nnothing to commit, working tree clean\n".repeat(3), isError: false, toolName: "bash" });
assert.ok(cleanCommit);
assert.equal(cleanCommit.output, "nothing to commit, working tree clean");
const addResult = dispatch({ command: "git add src/new-file.ts", stdout: "create mode 100644 src/new-file.ts\n".repeat(10), isError: false, toolName: "bash" });
assert.equal(addResult, null);
assert.equal(dispatch({ command: "git status", stdout: "On branch main\n\nChanges not staged for commit:\n  modified: src/file.ts\n".repeat(3), isError: false, toolName: "bash" }), null);
assert.equal(dispatch({ command: "git status --porcelain=v1", stdout: "M  malformed.txt\nnoise\n".repeat(10), isError: false, toolName: "bash" }), null);
assert.equal(dispatch({ command: "git status --porcelain=v1", stdout: "M  src/error.txt\n".repeat(20), isError: true, toolName: "bash" }), null);
assert.equal(dispatch({ command: "git status --porcelain=v1", stdout: "M  short.txt\n", isError: false, toolName: "bash" }), null);
console.log("PASS git status, diff, log, and mutation focused fixture");
