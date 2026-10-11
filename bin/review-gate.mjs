#!/usr/bin/env node
// review-gate (R3-1166) — compute the gate verdict for one PR and write the
// `review-gate` check run on its head SHA. Runs in the base-branch workflow
// (pull_request_target), never on PR code.
//
//   GH_TOKEN=… node bin/review-gate.mjs <owner> <repo> <pr>
//
// Verdict → check run: pass → success; hold → failure; wait → in_progress ("no review
// on <sha7>"); error → failure titled "error" (never a pass).

import { collectGateFacts, deriveGateVerdict } from '../src/review-gate.mjs';

const [owner, name, pr] = process.argv.slice(2);
if (!owner || !name || !pr) {
  console.error('usage: review-gate.mjs <owner> <repo> <pr>');
  process.exit(2);
}

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GH_TOKEN (or GITHUB_TOKEN) is required');
  process.exit(2);
}

const fetchImpl = async (query, variables) => {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'immediately-run-review-gate' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`graphql ${res.status}`);
  const j = await res.json();
  if (j.errors) throw new Error(`graphql: ${j.errors.map((e) => e.message).join('; ')}`);
  return j;
};

const facts = await collectGateFacts({ owner, name, pr: Number(pr) }, fetchImpl);
const { verdict, reason } = deriveGateVerdict(facts);
console.log(`review-gate: ${verdict} — ${reason}`);

const CONCLUSION = { pass: 'success', hold: 'failure', wait: null, error: 'failure' };
const body = {
  name: 'review-gate',
  head_sha: facts.head,
  ...(CONCLUSION[verdict] ? { status: 'completed', conclusion: CONCLUSION[verdict] } : { status: 'in_progress' }),
  output: { title: verdict === 'error' ? 'error' : verdict, summary: reason },
};
const res = await fetch(`https://api.github.com/repos/${owner}/${name}/check-runs`, {
  method: 'POST',
  headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'immediately-run-review-gate' },
  body: JSON.stringify(body),
});
if (!res.ok) {
  console.error(`check-runs POST: ${res.status} ${await res.text()}`);
  process.exit(1);
}
process.exit(verdict === 'error' ? 1 : 0);
