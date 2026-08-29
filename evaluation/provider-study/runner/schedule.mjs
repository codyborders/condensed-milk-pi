/**
 * Four-arm provider study: seeded randomized complete block schedule.
 *
 * Five preallocated repetitions per task; each block holds all four
 * arms in one seeded permutation. Conditional repetitions 6-10 are
 * planned but never preallocated: they run only when the five-to-ten
 * rule triggers them. The plan is a pure function of the phase
 * manifest and seed, so its canonical bytes and hash reproduce
 * exactly across processes and runs.
 */

import { createHash } from "node:crypto";
import { loadProviderStudyManifestFile } from "./manifest.mjs";
import { PROVIDER_STUDY_ARM_NAMES, stableJson } from "./arms.mjs";

/** Deterministic 32-bit PRNG (mulberry32) seeded from a string. */
function seededRandom(seedText) {
  let hash = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    hash ^= seedText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let state = hash >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded permutation of the four arms for one (task, block). */
export function blockArmOrder(seed, taskId, block) {
  const random = seededRandom(`${seed}:${taskId}:block-${block}`);
  const arms = [...PROVIDER_STUDY_ARM_NAMES];
  for (let index = arms.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [arms[index], arms[swap]] = [arms[swap], arms[index]];
  }
  return arms;
}

/** The full phase schedule: tasks, blocks, and conditional slots. */
export function providerStudySchedule(repoRoot, phase) {
  const { tasks, seed, manifest } = loadProviderStudyManifestFile(repoRoot, { phase });
  const preallocated = manifest.evaluation.repetitionsPreallocated;
  const conditional = [...manifest.evaluation.conditionalRepetitions];
  return {
    schemaVersion: 1,
    study: "provider-study",
    phase,
    seed,
    repetitionsPreallocated: preallocated,
    conditionalRepetitions: conditional,
    tasks: tasks.map((task) => ({
      taskId: task.id,
      blocks: Array.from({ length: preallocated }, (_, index) => ({
        rep: index + 1,
        arms: blockArmOrder(seed, task.id, index + 1),
        conditional: false,
      })),
      conditionalBlocks: conditional.map((rep) => ({ rep, arms: blockArmOrder(seed, task.id, rep), conditional: true })),
    })),
  };
}

/** Canonical plan bytes: stable JSON of the schedule. */
export function providerStudyPlanBytes(repoRoot, phase) {
  return `${stableJson(providerStudySchedule(repoRoot, phase))}\n`;
}

/** Reproducible plan hash over the canonical plan bytes. */
export function providerStudyPlanHash(repoRoot, phase) {
  return createHash("sha256").update(providerStudyPlanBytes(repoRoot, phase), "utf8").digest("hex");
}

/**
 * The one shared enumeration of planned blocks for a task: the five
 * preallocated blocks first, then the conditional 6-10 blocks in rep
 * order. Every consumer that must see conditional slots whenever they
 * exist (judge export, judge run/import, reports, complete blocks,
 * statistics, status) walks this function instead of reaching into
 * `blocks` alone.
 */
export function providerStudyPlannedBlocks(taskSchedule) {
  return [...taskSchedule.blocks, ...taskSchedule.conditionalBlocks];
}

/**
 * The one shared enumeration of every planned slot in a phase: task in
 * manifest order, then planned blocks, then arms in seeded order.
 * Each slot carries { taskId, rep, arm, conditional }.
 */
export function providerStudyPlannedSlots(repoRoot, phase) {
  const schedule = providerStudySchedule(repoRoot, phase);
  const slots = [];
  for (const task of schedule.tasks) {
    for (const block of providerStudyPlannedBlocks(task)) {
      for (const arm of block.arms) {
        slots.push({ taskId: task.taskId, rep: block.rep, arm, conditional: block.conditional });
      }
    }
  }
  return slots;
}
