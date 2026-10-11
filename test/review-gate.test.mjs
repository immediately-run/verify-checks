// review-gate.test.mjs — R3-1166: deriveGateVerdict over fixtures cut from REAL review
// JSON of two merged gated PRs (platform-constants#31, site-main#758, captured by
// `gh api graphql` 2026-10-11 into test/fixtures/), plus collectGateFacts' pagination.
// The fixtures predate the record format, so the verdict cases SPLICE record fences
// into the captured real review bodies (the parser then reads what a reviewer posts,
// not a hand-built facts object).

import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGateVerdict, collectGateFacts, recordsFromBody, findingIdOf, checkRunFor, existingRunUpdate, RECORD_LANG } from '../src/review-gate.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const real = (f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')).data.repository.pullRequest;

const HEAD = 'a'.repeat(40);
const rec = (over = {}) =>
  `${'```'}${RECORD_LANG}\n${JSON.stringify({ schema: 1, head: HEAD, round: 1, reviewer: 'A', model: 'model-a', findings: [], ...over })}\n${'```'}`;

test('recordsFromBody: a well-formed record parses; a malformed one is parseError, never dropped', () => {
  const [r] = recordsFromBody(`prose\n${rec()}\nmore`);
  expect(r.head).toBe(HEAD);
  const [bad] = recordsFromBody(`${'```'}${RECORD_LANG}\n{not json}\n${'```'}`);
  expect(bad.parseError).toBe(true);
  expect(recordsFromBody('no record here')).toEqual([]);
});

test('findingIdOf reads only the LEADING rg: marker', () => {
  expect(findingIdOf('<!-- rg:1-A-0 --> comment')).toBe('1-A-0');
  expect(findingIdOf('plain comment')).toBe(null);
  expect(findingIdOf('quoted <!-- rg:1-A-0 --> mid-body')).toBe(null);
});

const facts = (records, threads = []) => ({ head: HEAD, records, threads });

// The pass and stale-head cases run on records spliced into the REAL captured review
// bodies (platform-constants#31's two round-1 reviews), not hand-built bodies.
const realBodies = real('gate-constants-31.json').reviews.nodes.map((n) => n.body);
const spliced = (body, record) => `${body}\n\n${record}`;

test('pass: two reviewers, two models, the head, a resolved blocking finding (records spliced into real review bodies)', () => {
  const records = [
    ...recordsFromBody(
      spliced(realBodies[0], rec({ reviewer: 'A', model: 'model-a', findings: [{ id: '1-A-0', severity: 'blocking', file: 'x', line: 1 }] })),
    ),
    ...recordsFromBody(spliced(realBodies[1], rec({ reviewer: 'B', model: 'model-b' }))),
  ];
  const f = facts(records, [{ findingId: '1-A-0', isResolved: true, hasReplyAfterFinding: false }]);
  expect(deriveGateVerdict(f).verdict).toBe('pass');
});

test('wait: no record on the PR head (a stale-head review, real body)', () => {
  const v = deriveGateVerdict(facts(recordsFromBody(spliced(realBodies[0], rec({ head: 'b'.repeat(40) })))));
  expect(v.verdict).toBe('wait');
  expect(v.reason).toMatch(/no review on a{7}/);
});

test('wait: round 1 with one reviewer', () => {
  expect(deriveGateVerdict(facts(recordsFromBody(rec()))).verdict).toBe('wait');
});

test('hold: two records on ONE model — a concluded but invalid round one', () => {
  const f = facts([...recordsFromBody(rec({ reviewer: 'A', model: 'same' })), ...recordsFromBody(rec({ reviewer: 'B', model: 'same' }))]);
  expect(deriveGateVerdict(f).verdict).toBe('hold');
});

test('hold: two records from ONE reviewer on two models — the reviewer set is compared too', () => {
  const f = facts([...recordsFromBody(rec({ reviewer: 'A', model: 'm1' })), ...recordsFromBody(rec({ reviewer: 'A', model: 'm2' }))]);
  expect(deriveGateVerdict(f).verdict).toBe('hold');
});

test('hold: an open blocking finding (thread unresolved, no reply)', () => {
  const f = facts(
    [
      ...recordsFromBody(rec({ reviewer: 'A', model: 'model-a', findings: [{ id: '1-A-0', severity: 'blocking', file: 'x', line: 1 }] })),
      ...recordsFromBody(rec({ reviewer: 'B', model: 'model-b' })),
    ],
    [{ findingId: '1-A-0', isResolved: false, hasReplyAfterFinding: false }],
  );
  expect(deriveGateVerdict(f).verdict).toBe('hold');
});

test('hold: an open ROUND-1 blocking finding still holds after a clean round-2 record lands on the same head', () => {
  const f = facts(
    [
      ...recordsFromBody(rec({ reviewer: 'A', model: 'model-a', findings: [{ id: '1-A-0', severity: 'blocking', file: 'x', line: 1 }] })),
      ...recordsFromBody(rec({ reviewer: 'B', model: 'model-b' })),
      ...recordsFromBody(rec({ reviewer: 'r2', model: 'model-a', round: 2 })),
    ],
    [{ findingId: '1-A-0', isResolved: false, hasReplyAfterFinding: false }],
  );
  expect(deriveGateVerdict(f).verdict).toBe('hold');
});

test('hold: a body-only blocking finding (no thread) is open by construction', () => {
  const f = facts(
    [
      ...recordsFromBody(rec({ reviewer: 'A', model: 'model-a', findings: [{ id: '1-A-0', severity: 'blocking', file: 'x', line: 1 }] })),
      ...recordsFromBody(rec({ reviewer: 'B', model: 'model-b' })),
    ],
    [],
  );
  expect(deriveGateVerdict(f).verdict).toBe('hold');
});

test('hold at round ≥ 3 says "decision packet"', () => {
  const f = facts(
    [
      ...recordsFromBody(rec({ reviewer: 'A', model: 'model-a' })),
      ...recordsFromBody(rec({ reviewer: 'B', model: 'model-b' })),
      ...recordsFromBody(rec({ reviewer: 'r3', model: 'model-a', round: 3, findings: [{ id: '3-r3-0', severity: 'blocking', file: 'x', line: 1 }] })),
    ],
    [{ findingId: '3-r3-0', isResolved: false, hasReplyAfterFinding: false }],
  );
  const v = deriveGateVerdict(f);
  expect(v.verdict).toBe('hold');
  expect(v.reason).toMatch(/decision packet/);
});

test('pass: a blocking finding replied to (unresolved thread, reply after the finding)', () => {
  const f = facts(
    [
      ...recordsFromBody(rec({ reviewer: 'A', model: 'model-a', findings: [{ id: '1-A-0', severity: 'blocking', file: 'x', line: 1 }] })),
      ...recordsFromBody(rec({ reviewer: 'B', model: 'model-b' })),
    ],
    [{ findingId: '1-A-0', isResolved: false, hasReplyAfterFinding: true }],
  );
  expect(deriveGateVerdict(f).verdict).toBe('pass');
});

test('error: a record that does not parse ON THE HEAD is never a pass; on a stale-head review it is not the head’s error', () => {
  const bad = { parseError: true, reviewHead: HEAD };
  expect(deriveGateVerdict(facts([bad, ...recordsFromBody(rec()), ...recordsFromBody(rec({ reviewer: 'B', model: 'model-b' }))])).verdict).toBe('error');
  const staleBad = { parseError: true, reviewHead: 'c'.repeat(40) };
  expect(
    deriveGateVerdict(facts([staleBad, ...recordsFromBody(rec()), ...recordsFromBody(rec({ reviewer: 'B', model: 'model-b' }))])).verdict,
  ).toBe('pass');
});

test('existingRunUpdate: no open run → create; one open run → patch it; twins → patch the newest-id, cancel the rest', () => {
  // The body comes from checkRunFor — the producer the bin feeds in with — so the
  // name/head_sha strip and the output pass-through are pinned at the join.
  const body = checkRunFor('pass', 'r', HEAD);
  expect(existingRunUpdate([], body)).toEqual({ create: body });
  expect(existingRunUpdate([{ id: 7, name: 'review-gate', status: 'in_progress' }], body)).toEqual({
    patch: { id: 7, body: { status: 'completed', conclusion: 'success', output: body.output } },
    cancel: [],
  });
  const twins = existingRunUpdate(
    [
      { id: 7, name: 'review-gate', status: 'in_progress' },
      { id: 9, name: 'review-gate', status: 'in_progress' },
      { id: 5, name: 'review-gate', status: 'completed' },
      { id: 8, name: 'other', status: 'in_progress' },
    ],
    body,
  );
  expect(twins.patch.id).toBe(9);
  expect(twins.cancel).toEqual([{ id: 7, body: { status: 'completed', conclusion: 'cancelled' } }]);
});

test('checkRunFor: pass → success, hold → failure, wait → in_progress, error → failure titled error', () => {
  expect(checkRunFor('pass', 'r', HEAD)).toMatchObject({ status: 'completed', conclusion: 'success', head_sha: HEAD });
  expect(checkRunFor('hold', 'r', HEAD)).toMatchObject({ status: 'completed', conclusion: 'failure' });
  expect(checkRunFor('wait', 'r', HEAD)).toMatchObject({ status: 'in_progress' });
  expect(checkRunFor('error', 'r', HEAD)).toMatchObject({ status: 'completed', conclusion: 'failure', output: { title: 'error' } });
});

test('the real fixtures carry the review surface the facts read (regression pin)', () => {
  for (const f of ['gate-constants-31.json', 'gate-site-main-758.json']) {
    const pr = real(f);
    expect(pr.headRefOid).toMatch(/^[0-9a-f]{40}$/);
    expect(pr.reviews.nodes.length).toBeGreaterThan(0);
    expect(pr.reviews.nodes.every((r) => typeof r.body === 'string')).toBe(true);
  }
  // site-main#758 had inline threads; constants#31's findings rode the review body.
  expect(real('gate-site-main-758.json').reviewThreads.nodes.length).toBeGreaterThan(0);
});

test('collectGateFacts reads BOTH review pages, and the stub enforces the query wiring', async () => {
  const pr758 = real('gate-site-main-758.json');
  const threads = pr758.reviewThreads.nodes;
  const mk = (revs, hasNext, endCursor, threadNodes) => ({
    data: {
      repository: {
        pullRequest: {
          headRefOid: pr758.headRefOid,
          reviews: { pageInfo: { hasNextPage: hasNext, endCursor }, nodes: revs },
          // The real server re-answers the thread page on every reviews page; the stub
          // repeats them (page 2 included), as production does.
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threadNodes },
        },
      },
    },
  });
  const calls = [];
  const fetchImpl = async (query, variables) => {
    // The stub honours GraphQL semantics where it matters: a declared-but-unwired
    // cursor variable is a server rejection (the variableNotUsed class the first cut
    // shipped). Pages are served by call order; the calls[1] === 'c1' assertion is
    // what keys the second page to the after argument.
    for (const v of ['cursor', 'threadCursor']) {
      if (query.includes(`$${v}:`) && !query.includes(`after:$${v}`)) throw new Error(`variableNotUsed: $${v}`);
    }
    calls.push(variables.cursor ?? null);
    return calls.length === 1 ? mk(pr758.reviews.nodes.slice(0, 1), true, 'c1', threads) : mk(pr758.reviews.nodes.slice(1), false, null, threads);
  };
  const out = await collectGateFacts({ owner: 'immediately-run', name: 'immediately-run-site-main', pr: 758 }, fetchImpl);
  expect(calls.length).toBe(2);
  expect(calls[1]).toBe('c1');
  expect(out.head).toBe(pr758.headRefOid);
  // Threads are deduped across pages (the server repeats them); the count is the real page's.
  expect(out.threads.length).toBe(threads.length);
});

test('collectGateFacts: a threads-only continuation page never duplicates the reviews page records', async () => {
  const pr758 = real('gate-site-main-758.json');
  const recordBody = `${pr758.reviews.nodes[0].body}\n\n${rec()}`;
  const review = { ...pr758.reviews.nodes[0], body: recordBody };
  const mk = (revs, revNext, threadNext, threadCursorOut) => ({
    data: {
      repository: {
        pullRequest: {
          headRefOid: pr758.headRefOid,
          reviews: { pageInfo: { hasNextPage: revNext, endCursor: revNext ? 'rc1' : null }, nodes: revs },
          reviewThreads: {
            pageInfo: { hasNextPage: threadNext, endCursor: threadNext ? threadCursorOut : null },
            nodes: pr758.reviewThreads.nodes,
          },
        },
      },
    },
  });
  const fetchImpl = async (query, variables) => {
    for (const v of ['cursor', 'threadCursor']) {
      if (query.includes(`$${v}:`) && !query.includes(`after:$${v}`)) throw new Error(`variableNotUsed: $${v}`);
    }
    // Page 1: one review (carrying a record), more threads. Page 2: threads continue,
    // reviews exhausted — the server re-answers reviews page 1 (after:null).
    return variables.threadCursor === null ? mk([review], false, true, 'tc1') : mk([review], false, false, null);
  };
  const out = await collectGateFacts({ owner: 'immediately-run', name: 'immediately-run-site-main', pr: 758 }, fetchImpl);
  expect(out.records.length).toBe(1);
  expect(deriveGateVerdict({ head: HEAD, records: out.records, threads: [] }).verdict).toBe('wait');
});

test('collectGateFacts: records parsed off REAL review bodies carry the review commit as reviewHead (and a malformed one on a STALE head does not error the current head)', async () => {
  const pr758 = real('gate-site-main-758.json');
  const good = { ...pr758.reviews.nodes[0], body: `${pr758.reviews.nodes[0].body}\n\n${rec()}` };
  const bad = { ...pr758.reviews.nodes[1], body: `${pr758.reviews.nodes[1].body}\n\n${'```'}${RECORD_LANG}\n{not json}\n${'```'}` };
  const page = {
    data: {
      repository: {
        pullRequest: {
          headRefOid: pr758.headRefOid,
          reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [good, bad] },
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
    },
  };
  const out = await collectGateFacts({ owner: 'immediately-run', name: 'immediately-run-site-main', pr: 758 }, async () => page);
  expect(out.records.length).toBe(2);
  expect(out.records[0].reviewHead).toBe(good.commit?.oid ?? null);
  expect(out.records[1].parseError).toBe(true);
  expect(out.records[1].reviewHead).toBe(bad.commit?.oid ?? null);
  // …and end to end: the malformed record is on an OLD head (the reviews predate the
  // current head), so the head's verdict is wait, not error.
  expect(deriveGateVerdict({ head: HEAD, records: out.records, threads: [] }).verdict).toBe('wait');
});
