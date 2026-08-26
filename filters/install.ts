/**
 * Package install output filter.
 *
 * Package-manager output varies too much for a safe summary. This filter
 * remains deliberately conservative until complete parsers have fixtures.
 */
import { registerFilter, type FilterContext, type FilterResult } from "./dispatch.js";

function filterInstall(_context: FilterContext): FilterResult | null {
  return null;
}

const INSTALL_COMMANDS = [
  "npm install", "npm i", "npm ci",
  "pnpm install", "pnpm i", "pnpm add",
  "yarn install", "yarn add", "yarn",
  "bun install", "bun add",
  "pip install", "pip3 install",
  "pip install -r", "pip3 install -r",
];

for (const cmd of INSTALL_COMMANDS) {
  registerFilter(cmd, filterInstall, "mutation", { context: true });
}
