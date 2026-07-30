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
  { ch: "\u2014", name: "em-dash" },
  { ch: "\u2013", name: "en-dash" },
];

// Also catch the ESCAPED forms, which produce the banned character at runtime while
// the source file contains only ASCII. A literal-character scan passes
// `const s = "\u2014"` and the customer still sees an em-dash. Adversarial review
// 2026-07-30, finding #10. Covers JS/TS unicode escapes in both notations plus the
// HTML entities, since these strings reach both a terminal and a web page.
const BANNED_ESCAPES = [
  { re: /\\u2014|\\u\{2014\}/i, name: "escaped em-dash (\\u2014)" },
  { re: /\\u2013|\\u\{2013\}/i, name: "escaped en-dash (\\u2013)" },
  { re: /&mdash;|&#8212;|&#x2014;/i, name: "HTML em-dash entity" },
  { re: /&ndash;|&#8211;|&#x2013;/i, name: "HTML en-dash entity" },
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
    for (const { re, name } of BANNED_ESCAPES) {
      // Skip this file's own pattern table, which necessarily contains them.
      if (file.endsWith("lint-no-emdash.mjs")) break;
      if (re.test(line)) findings.push({ file, line: i + 1, name, text: line.trim().slice(0, 100) });
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
