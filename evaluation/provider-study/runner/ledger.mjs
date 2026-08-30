/**
 * Provider-study holdout access ledger (growing test-first).
 *
 * Every holdout-phase execution appends one entry under the run root:
 * the command, the phase, and the task ids whose holdout material was
 * read. The development phase never reaches this ledger because it
 * refuses holdout task ids before any fixture read.
 */

import { join } from "node:path";

/** Ledger path under the run root: <runsRoot>/holdout-access-ledger.jsonl */
export function providerStudyHoldoutLedgerPath(runsRoot) {
  return join(runsRoot, "holdout-access-ledger.jsonl");
}
