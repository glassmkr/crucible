#!/usr/bin/env node

// Preflight entry: this file is package.json `bin`, so it is what runs when
// the CLI is invoked. Its whole job is to fail GRACEFULLY on an unsupported
// Node before anything that imports undici is loaded.
//
// Why a separate entry instead of a guard inside index.ts: ESM `import`
// statements are hoisted and evaluated before any top-level code in the
// module. src/index.ts transitively imports undici (via endpoint-policy),
// and undici@8 crashes at import time on a Node below its own declared
// floor ("webidl.util.markAsUncloneable is not a function"). A version check
// placed after that import can never run, so the check has to live in a
// module that does not (even transitively) import undici, and only
// dynamic-import the real entry once the check passes.
//
// This file must stay runnable on old Node too: it imports only the pure,
// dependency-free node-version helpers and uses no syntax newer than the
// oldest Node we might land on.
import { MIN_NODE_VERSION, nodeMeetsMinimum, oldNodeMessage } from "./lib/node-version.js";

if (!nodeMeetsMinimum(process.versions.node, MIN_NODE_VERSION)) {
  console.error(oldNodeMessage(process.versions.node, MIN_NODE_VERSION));
  process.exit(1);
}

await import("./index.js");
