/**
 * Provider-study attempt metrics.
 *
 * Provider usage is preserved verbatim: every field the provider sent
 * survives unchanged, unknown fields included. The summed provider
 * total uses only numeric token fields; nulls stay null and non-numeric
 * values are preserved but never coerced into the total.
 */

const TOKEN_TOTAL_FIELDS = Object.freeze(["input", "output", "cacheRead", "cacheWrite"]);

/**
 * Normalize one provider usage object. Missing token fields become
 * null; every other field is copied verbatim, including unknown ones.
 */
export function normalizeProviderUsage(raw) {
  const source = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {};
  const normalized = {};
  for (const [key, value] of Object.entries(source)) {
    normalized[key] = value;
  }
  for (const field of TOKEN_TOTAL_FIELDS) {
    if (normalized[field] === undefined) normalized[field] = null;
  }
  return normalized;
}

/**
 * Summed provider total over every numeric token field: the four base
 * categories plus any other field whose name ends in "token" or
 * "tokens" (for example reasoningTokens). Null, undefined,
 * non-numeric, and non-finite values are skipped, never coerced.
 */
export function providerTotalTokens(usage) {
  const source = typeof usage === "object" && usage !== null && !Array.isArray(usage) ? usage : {};
  let total = 0;
  let observed = false;
  for (const [key, value] of Object.entries(source)) {
    const isTokenField = TOKEN_TOTAL_FIELDS.includes(key) || /tokens?$/i.test(key);
    if (!isTokenField) continue;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      total += value;
      observed = true;
    }
  }
  return observed ? total : null;
}

/**
 * Proxy-authoritative request accounting from the persisted proxy.json.
 * The loopback proxy observed every provider request the attempt made,
 * so its counts are the authority: request count, per-status counts,
 * failed request count (non-numeric or >= 400 statuses), and rejected
 * count (requests the proxy refused before forwarding).
 */
export function proxyRequestAccounting(proxy) {
  const requests = Array.isArray(proxy?.requests) ? proxy.requests : [];
  const rejected = Array.isArray(proxy?.rejected) ? proxy.rejected : [];
  const statusCounts = {};
  let failed = 0;
  for (const request of requests) {
    const status = typeof request?.status === "number" && Number.isFinite(request.status)
      ? Math.trunc(request.status)
      : null;
    if (status === null) {
      failed += 1;
      continue;
    }
    const key = String(status);
    statusCounts[key] = (typeof statusCounts[key] === "number" ? statusCounts[key] : 0) + 1;
    if (status >= 400) failed += 1;
  }
  return {
    proxyRequestCount: requests.length,
    proxyStatusCounts: statusCounts,
    proxyFailedRequestCount: failed,
    proxyRejectedCount: rejected.length,
  };
}

/**
 * Detect resumed or retried provider traffic by comparing the
 * proxy-authoritative request count with the count of successful
 * assistant completions in the session. Equal counts are consistent;
 * more proxy requests than completions flags retried or resumed
 * provider traffic; any other mismatch flags a count disagreement.
 * Unavailable counts stay null rather than guessing.
 */
export function providerTrafficAnomaly({ proxyRequestCount, assistantCompletions }) {
  if (
    typeof proxyRequestCount !== "number" || !Number.isFinite(proxyRequestCount)
    || typeof assistantCompletions !== "number" || !Number.isFinite(assistantCompletions)
  ) {
    return { anomaly: null, reason: "proxy or completion counts are unavailable" };
  }
  if (proxyRequestCount === assistantCompletions) {
    return { anomaly: false, reason: null };
  }
  if (proxyRequestCount > assistantCompletions) {
    return {
      anomaly: true,
      reason: `the proxy saw ${proxyRequestCount} requests but ${assistantCompletions} assistant completions: retried or resumed provider traffic`,
    };
  }
  return {
    anomaly: true,
    reason: `the proxy saw ${proxyRequestCount} requests but ${assistantCompletions} assistant completions: counts disagree`,
  };
}
