/**
 * Neutral unavailable retrieval stub for the provider study.
 *
 * Used by the none arm (no Condensed Milk production extension loads)
 * and by the upstream arm (upstream has no archive retrieval).
 * Registers the exact canonical condensed_milk_retrieve tool schema so
 * every arm exposes an identical retrieval surface, then always fails
 * with one bounded deterministic message. Reads nothing, writes
 * nothing, keeps no state.
 */

const TOOL_NAME = "condensed_milk_retrieve";
const UNAVAILABLE_MESSAGE =
  "condensed_milk_retrieve: archive storage unavailable in this arm; rerun the command or reread the file instead";

const PARAMETERS = {
  type: "object",
  properties: {
    id: { type: "string", description: "Legacy cm- or rolling cm2- reference from a [cm-archive ...] placeholder" },
    offset: { type: "integer", minimum: 0, maximum: 524288, description: "Page mode: UTF-8 byte offset" },
    limit: { type: "integer", minimum: 1, maximum: 65536, description: "Page mode: bytes to return" },
    tail: { type: "integer", minimum: 1, maximum: 65536, description: "Tail mode: trailing bytes" },
    literal: { type: "string", description: "Literal search: lines containing this substring" },
    regex: { type: "string", description: "Regex search: restricted pattern, no backreferences or lookarounds" },
    flags: { type: "string", description: "Regex flags, subset of i m s u" },
  },
  required: ["id"],
  additionalProperties: false,
};

export default function neutralRetrieval(pi) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Retrieve archived output",
    description:
      "Recover tool output archived by condensed-milk before semantic compression or historical masking. " +
      "Modes: page (offset/limit over UTF-8 bytes), tail (last N bytes), literal search, or regex search (flags i, m, s, u only). " +
      "Modes are mutually exclusive. Use the cm- or cm2- reference from a [cm-archive ...] placeholder.",
    promptSnippet: "Recover archived tool output by reference with paging, tail, literal, or regex search",
    executionMode: "sequential",
    parameters: PARAMETERS,
    async execute() {
      throw new Error(UNAVAILABLE_MESSAGE);
    },
  });
}
