#!/usr/bin/env bun
/** Validates shared/data/*.json and emits the merged shared/game-data.json. */
import { writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGameData } from "./validate-game-data.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(ROOT, "shared", "game-data.json");
const data = buildGameData();
writeFileSync(out, JSON.stringify(data, null, 2) + "\n");
const count = Object.keys(data.units as Record<string, unknown>).length;
console.log(`✓ wrote shared/game-data.json — ${(data.races as unknown[]).length} races, ${count} entities, ${(data.maps as unknown[]).length} maps`);
