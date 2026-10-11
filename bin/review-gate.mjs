#!/usr/bin/env node
// review-gate (R3-1166) — compute the gate verdict for one PR and write the
// `review-gate` check run on its head SHA. Runs in the base-branch workflow
// (pull_request_target), never on PR code.
//
//   GH_TOKEN=… node bin/review-gate.mjs <owner> <repo> <pr>

import { collectGateFacts, deriveGateVerdict, checkRunFor, existingRunUpdate, CHECK_NAME } from '../src/review-gate.mjs';

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
  return request('POST', path, payload);
}

async function get(path) {
  return request('GET', path);
}

async function patch_(path, payload) {
  return request('PATCH', path, payload);
}

async function request(method, path, payload) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { ...HEADERS, authorization: `bearer ${token}` },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(BUDGET_MS),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // A 200 with an unparseable body is not "no data": the GET's caller would read
    // null as "no existing runs" and POST a twin beside the runs the broken list hid.
    throw new Error(`${path}: ${res.status} with an unparseable body`);
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

// At most one OPEN check run per head: the gate dispatches per post/reply round, so a
// POST-per-run would accumulate in_progress twins beside the success and the per-head
// verdict would read ambiguous forever. Update the head's OPEN review-gate run in place
// when one exists; a completed run stays as history and a post-completion dispatch
// creates a new one (round-2 closure on the five workflow PRs).
const runBody = checkRunFor(verdict, reason, facts.head);
// filter=all, never the default: `latest` would hide an older open twin from every
// later run, and the twin would read as pending forever.
const existing = await get(`/repos/${owner}/${name}/commits/${facts.head}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=all&per_page=100`);
const plan = existingRunUpdate(existing?.check_runs, runBody);
if (plan.create) {
  await post(`/repos/${owner}/${name}/check-runs`, plan.create);
} else {
  for (const c of plan.cancel ?? []) await patch_(`/repos/${owner}/${name}/check-runs/${c.id}`, c.body);
  await patch_(`/repos/${owner}/${name}/check-runs/${plan.patch.id}`, plan.patch.body);
}
process.exit(verdict === 'error' ? 1 : 0);
