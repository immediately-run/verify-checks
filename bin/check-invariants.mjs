#!/usr/bin/env node
// check-invariants (R3-1170) — run the invariant registry over one repo.
//
//   node bin/check-invariants.mjs [--repo <name>] [--cwd <dir>]
//                                  [--baseline <path>] [--write-baseline]
//
// The repo is named by --repo or derived from the origin remote (the
// immediately-run- prefix is folded away). The baseline defaults to
// verify-baselines/invariants.json under the target repo; --write-baseline
// seeds it once, as with every other ratchet here.

import { checkInvariants } from '../src/check-invariants.mjs';

const OWN_FLAGS = ['--repo', '--cwd', '--baseline'];

const args = process.argv.slice(2);

function valueOf(flag) {
  const at = args.indexOf(flag);
  return at === -1 ? null : args[at + 1] ?? null;
}

await checkInvariants({
  cwd: valueOf('--cwd') ?? process.cwd(),
  repo: valueOf('--repo'),
  baselinePath: valueOf('--baseline') ?? 'verify-baselines/invariants.json',
  argv: args.filter((arg, index) => !OWN_FLAGS.includes(arg) && !OWN_FLAGS.includes(args[index - 1])),
});
