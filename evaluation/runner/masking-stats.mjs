/**
 * Confidence intervals for the masking study.
 *
 * Two deterministic methods over paired fork-minus-upstream
 * differences: an exact paired t interval (t critical values for small
 * degrees of freedom, normal approximation beyond the table) and a
 * seeded paired bootstrap percentile interval. Both return null bounds
 * for empty input; missing values are never imputed.
 */

/** Two-sided 95% t critical values by degrees of freedom (df 1..29). */
const T95 = [
  12.706204736432095, 4.3026527299322755, 3.182446305284263, 2.7764451051977987,
  2.5705818366147395, 2.4469118511449666, 2.3646242520102997, 2.306004135204179,
  2.2621571628540962, 2.228138851986273, 2.200985160082949, 2.178812829667226,
  2.160368656462012, 2.1447866879169273, 2.131449545559323, 2.119905299221253,
  2.1098155778331806, 2.10092204024096, 2.093024054408263, 2.085963447265837,
  2.079613844727681, 2.0738730679011127, 2.068657610419047, 2.0638985616280254,
  2.0595385527532963, 2.055529425540815, 2.051830516480914, 2.048407141795244,
  2.045229642132703,
];
const T95_LARGE = 1.959963984540054;

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStd(values, meanValue) {
  const sumSquares = values.reduce((sum, value) => sum + (value - meanValue) ** 2, 0);
  return Math.sqrt(sumSquares / (values.length - 1));
}

/** Paired t interval for fork-minus-upstream differences. */
export function pairedTInterval(differences, level = 0.95) {
  const values = differences.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) {
    return { method: "paired-t", n: 0, mean: null, low: null, high: null, level };
  }
  if (values.length === 1) {
    return { method: "paired-t", n: 1, mean: values[0], low: values[0], high: values[0], level };
  }
  const meanValue = mean(values);
  const df = values.length - 1;
  const critical = df <= T95.length ? T95[df - 1] : T95_LARGE;
  const halfWidth = (sampleStd(values, meanValue) / Math.sqrt(values.length)) * critical;
  return {
    method: "paired-t",
    n: values.length,
    mean: meanValue,
    low: meanValue - halfWidth,
    high: meanValue + halfWidth,
    level,
  };
}

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

/**
 * Deterministic paired bootstrap percentile interval. Resamples the
 * paired difference list with replacement using a seeded PRNG, so the
 * same inputs and seed always produce the same bounds. The interval
 * method is the 2.5th/97.5th percentile of resampled means.
 */
export function pairedBootstrapInterval(differences, level = 0.95, { iterations = 2000, seed = "masking" } = {}) {
  const values = differences.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) {
    return { method: "paired-bootstrap-percentile", n: 0, mean: null, low: null, high: null, level, iterations, seed };
  }
  const random = seededRandom(seed);
  const means = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
      sum += values[Math.floor(random() * values.length)];
    }
    means.push(sum / values.length);
  }
  means.sort((left, right) => left - right);
  const percentile = (fraction) => {
    const position = fraction * (means.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, means.length - 1);
    const weight = position - lower;
    return means[lower] * (1 - weight) + means[upper] * weight;
  };
  const alpha = (1 - level) / 2;
  return {
    method: "paired-bootstrap-percentile",
    n: values.length,
    mean: mean(values),
    low: percentile(alpha),
    high: percentile(1 - alpha),
    level,
    iterations,
    seed,
  };
}
