/**
 * Append-only JSONL prediction log. This file is the actual research
 * artifact — unlike cache/ in the other modules, it's NOT reproducible
 * (it's real predictions made at real moments in time) and IS meant to be
 * committed to git as evidence accumulates.
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const LOG_PATH = join(__dirname, "..", "log", "predictions.jsonl");

export function readAll() {
  if (!existsSync(LOG_PATH)) return [];
  return readFileSync(LOG_PATH, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export function append(entry) {
  appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
}

export function rewriteAll(entries) {
  writeFileSync(LOG_PATH, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
}
