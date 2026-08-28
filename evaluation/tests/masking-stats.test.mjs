/**
 * Masking study confidence interval tests (known values).
 *
 * Paired t interval uses an exact t critical value for small samples;
 * the deterministic paired bootstrap is seeded and stable, and a
 * constant difference set yields an exact zero-width interval.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pairedTInterval, pairedBootstrapInterval } from "../runner/masking-stats.mjs";

describe("masking study intervals", () => {
  test("paired t interval on diffs [1, 2, 3] uses the exact t critical value", () => {
    const interval = pairedTInterval([1, 2, 3], 0.95);
    // mean 2, sample sd 1, se 1/sqrt(3), t(0.975, df=2) = 4.3026527299322755
    const halfWidth = (1 / Math.sqrt(3)) * 4.3026527299322755;
    assert.ok(Math.abs(interval.mean - 2) < 1e-12);
    assert.ok(Math.abs(interval.low - (2 - halfWidth)) < 1e-9);
    assert.ok(Math.abs(interval.high - (2 + halfWidth)) < 1e-9);
    assert.equal(interval.method, "paired-t");
    assert.equal(interval.n, 3);
  });

  test("deterministic paired bootstrap is seed-stable and exact for constant diffs", () => {
    const constant = pairedBootstrapInterval([5, 5, 5], 0.95, { iterations: 500, seed: "masking" });
    assert.equal(constant.low, 5);
    assert.equal(constant.high, 5);
    assert.equal(constant.method, "paired-bootstrap-percentile");
    const first = pairedBootstrapInterval([1, 2, 3, 4], 0.95, { iterations: 1000, seed: "masking" });
    const second = pairedBootstrapInterval([1, 2, 3, 4], 0.95, { iterations: 1000, seed: "masking" });
    assert.deepEqual(first, second);
    assert.ok(first.low <= first.mean && first.mean <= first.high);
    assert.equal(first.n, 4);
  });
});
