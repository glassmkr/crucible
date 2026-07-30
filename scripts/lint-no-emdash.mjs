#!/usr/bin/env node
// Fail the build on an em-dash (U+2014) or en-dash (U+2013) anywhere under src/.
//
// WHY. The no-em-dash convention covers code, comments and customer-facing copy
// alike, but until 2026-07-30 only the DASHBOARD repo enforced it
// (`pnpm lint:emdash` over apps/site/src and the alert rules). This repo had 29
// of them, and one had shipped into a customer-visible payload: the
// `raw_summary` string in collect/hardware-raid.ts, which travels in the
// snapshot to the dashboard. Comments are cheap to fix but the convention exists
// precisely so nobody has to judge case by case which strings escape.
//
// Deliberately scans ALL of src/, not just string literals. A comment em-dash is
// the thing that eventually gets copied into a message.
//
// Mirrors the dashboard guard's behaviour: prose should use ": " or "; " instead
// (YAML prefers "; ", since ": " is significant there).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src";
const BANNED = [
  { ch: "—", name: "em-dash" },
  { ch: "–", name: "en-dash" },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|mts|cts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

const findings = [];
let scanned = 0;
for (const file of walk(ROOT)) {
  scanned++;
  const lines = readFileSync(file, "utf-8").split("\n");
  lines.forEach((line, i) => {
    for (const { ch, name } of BANNED) {
      if (line.includes(ch)) findings.push({ file, line: i + 1, name, text: line.trim().slice(0, 100) });
    }
  });
}

if (findings.length > 0) {
  console.error(`[lint:emdash] FAIL: ${findings.length} dash character(s) found in ${ROOT}/`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line} (${f.name}): ${f.text}`);
  }
  console.error('\nUse ": " or "; " instead. This applies to comments as well as strings.');
  process.exit(1);
}

console.log(`[lint:emdash] OK; no em-dashes or en-dashes in ${scanned} file(s) under ${ROOT}/`);
