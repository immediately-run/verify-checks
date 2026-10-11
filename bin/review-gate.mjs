#!/usr/bin/env node
// review-gate (R3-1166) — compute the gate verdict for one PR and write the
// `review-gate` check run on its head SHA. Runs in the base-branch workflow
// (pull_request_target), never on PR code.
//
//   GH_TOKEN=… node bin/review-gate.mjs <owner> <repo> <pr>

import { collectGateFacts, deriveGateVerdict, checkRunFor } from '../src/review-gate.mjs';

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

const HEADERS = { 'content-type': 'application/json', 'user-agent': 'immediately-run-review-gate' };
// The workflow job's budget: a stalled api.github.com connection must not hold the
// pull_request_target job until the workflow timeout with no check run written.
const BUDGET_MS = 60_000;

async function post(path, payload) {
  const res = await fetch(`https://api.github.com${path}`, {
    method: 'POST',
    headers: { ...HEADERS, authorization: `bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(BUDGET_MS),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text.slice(0, 300)}`);
  return json;
}

const fetchImpl = (query, variables) => post('/graphql', { query, variables }).then((j) => {
  if (j.errors) throw new Error(`graphql: ${j.errors.map((e) => e.message).join('; ')}`);
  return j;
});

const facts = await collectGateFacts({ owner, name, pr: Number(pr) }, fetchImpl);
const { verdict, reason } = deriveGateVerdict(facts);
console.log(`review-gate: ${verdict} — ${reason}`);

await post(`/repos/${owner}/${name}/check-runs`, checkRunFor(verdict, reason, facts.head));
process.exit(verdict === 'error' ? 1 : 0);
