#!/usr/bin/env node
//
// Known-bad fixture for the em-dash guard, per the standing rule that every CI gate
// ships with a fixture proving it FAILS on a real defect. Without one the guard only
// ever demonstrates that today's clean tree is clean, and a no-op regression in it
// (a broken regex, a changed scan root, an early return) stays green forever.
// Adversarial review round 5, finding #6.
//
// The guard scans src/ and exits non-zero on a finding, so each case is exercised by
// writing a fixture into src/, running the guard as a subprocess, and deleting it.
// The fixture path is removed in a finally block so a failed assertion cannot leave
// the tree dirty or, worse, leave an em-dash behind that breaks the real CI run.

import { writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const guard = resolve(here, "lint-no-emdash.mjs");
const fixture = resolve(repoRoot, "src", "__emdash_guard_fixture__.ts");

let pass = 0;
let fail = 0;

function runGuard() {
  try {
    execFileSync(process.execPath, [guard], { cwd: repoRoot, stdio: "pipe" });
    return { exitCode: 0, output: "" };
  } catch (err) {
    return { exitCode: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function check(label, cond, detail) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}${detail ? `\n  ${detail}` : ""}`);
  }
}

function expectRejected(label, contents) {
  writeFileSync(fixture, contents);
  try {
    const r = runGuard();
    check(label, r.exitCode !== 0, `guard exited 0 on: ${JSON.stringify(contents.slice(0, 80))}`);
  } finally {
    rmSync(fixture, { force: true });
  }
}

try {
  // Baseline. If the clean tree does not pass, nothing below is meaningful.
  const clean = runGuard();
  check("clean tree passes", clean.exitCode === 0, `exit=${clean.exitCode} ${clean.output.slice(0, 200)}`);

  // The literal characters, in a comment and in a customer-visible string. The
  // hardware-raid.ts raw_summary em-dash that shipped was the string case.
  expectRejected(
    "literal em-dash in a comment is rejected",
    `// a comment with an em${String.fromCharCode(0x2014)}dash\nexport const x = 1;\n`,
  );
  expectRejected(
    "literal em-dash in a string is rejected",
    `export const s = "status${String.fromCharCode(0x2014)}ok";\n`,
  );
  expectRejected(
    "literal en-dash is rejected",
    `export const s = "1${String.fromCharCode(0x2013)}2";\n`,
  );

  // The ESCAPED forms, which leave the source pure ASCII while still emitting the
  // banned character at runtime. Round 3 finding #10 added the leading-zero variant.
  expectRejected("\\u2014 escape is rejected", 'export const s = "a\\u2014b";\n');
  expectRejected("\\u{2014} escape is rejected", 'export const s = "a\\u{2014}b";\n');
  expectRejected("leading-zero \\u{0002014} escape is rejected", 'export const s = "a\\u{0002014}b";\n');
  expectRejected("HTML entity &mdash; is rejected", 'export const s = "a&mdash;b";\n');

  // And the negative control: the approved replacements must NOT trip it, or the
  // guard would be unusable and would get bypassed.
  writeFileSync(fixture, 'export const s = "cause: effect; and more";\n');
  try {
    const r = runGuard();
    check("approved ': ' and '; ' separators pass", r.exitCode === 0, r.output.slice(0, 200));
  } finally {
    rmSync(fixture, { force: true });
  }
} finally {
  rmSync(fixture, { force: true });
}

check("fixture removed", !existsSync(fixture));

console.log(`[lint:emdash:test] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
