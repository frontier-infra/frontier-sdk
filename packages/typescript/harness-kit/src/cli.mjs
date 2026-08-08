#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { JsonlEventStore, createHarnessFromGoal } from './index.mjs';

function usage() {
  return `Usage:
  frontier-harness run goal.json [--once]

Runs a proposal-only harness slice against a goal JSON document. Events are
persisted in .frontier-harness/events.jsonl next to the goal file. Receipts are
hash-chained, unsigned, and explicitly L3 local receipts, not AAR L4 signatures.`;
}

function parse(argv) {
  const [cmd, goalPath, ...rest] = argv;
  if (cmd !== 'run' || !goalPath) throw new Error(usage());
  const options = { cmd, goalPath, once: false };
  for (const arg of rest) {
    if (arg === '--once') options.once = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  const goalPath = path.resolve(options.goalPath);
  const goal = JSON.parse(fs.readFileSync(goalPath, 'utf8'));
  const eventPath = path.join(path.dirname(goalPath), '.frontier-harness', 'events.jsonl');
  const harness = createHarnessFromGoal(goal, { store: new JsonlEventStore(eventPath), now: goal.now });
  const result = await harness.runOnce();
  console.log(`frontier-harness: status ${result.status}`);
  console.log(`frontier-harness: wrote ${eventPath}`);
  console.log(`frontier-harness: receipt ${harness.store.lastReceiptHash()}`);
  if (!options.once && result.report.can_mutate) {
    console.log('frontier-harness: --once omitted; this vertical slice still executes one deterministic move.');
  }
  if (result.report.status === 'invalid') process.exit(1);
  if (!result.report.can_mutate && result.report.status !== 'propose_only') process.exit(2);
} catch (error) {
  console.error(`frontier-harness: ${error.message}`);
  process.exit(1);
}
