/**
 * Provider-study schedule (grown test-first).
 *
 * Randomized complete blocks: five preallocated repetitions per task,
 * each block holding all four arms in a seeded permutation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { providerStudySchedule, providerStudyPlannedBlocks, providerStudyPlannedSlots } from "../runner/schedule.mjs";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

test("development schedule is a seeded randomized complete block design", () => {
  const schedule = providerStudySchedule(repoRoot, "development");
  assert.equal(schedule.tasks.length, 12);
});

test("planned blocks enumerate base plus conditional slots through one shared function", () => {
  const schedule = providerStudySchedule(repoRoot, "development");
  const task = schedule.tasks[0];
  const planned = providerStudyPlannedBlocks(task);
  assert.equal(planned.length, 10, "five preallocated plus five conditional blocks");
  assert.deepEqual(planned.map((block) => block.rep), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(
    planned.map((block) => block.conditional),
    [false, false, false, false, false, true, true, true, true, true],
  );
  for (const block of planned) {
    assert.deepEqual([...block.arms].sort(), ["none", "remediated-archive", "remediated-defaults", "upstream"]);
  }
  const slots = providerStudyPlannedSlots(repoRoot, "development");
  assert.equal(slots.length, 12 * 10 * 4, "every task, base plus conditional rep, and arm");
  assert.equal(slots.filter((slot) => slot.conditional).length, 12 * 5 * 4);
  assert.deepEqual(
    slots
      .filter((slot) => slot.taskId === schedule.tasks[0].taskId && slot.rep === 6)
      .map((slot) => slot.arm)
      .sort(),
    ["none", "remediated-archive", "remediated-defaults", "upstream"],
  );
});
