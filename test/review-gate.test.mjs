// review-gate.test.mjs — R3-1166: deriveGateVerdict over fixtures cut from REAL review
// JSON of two merged gated PRs (platform-constants#31, site-main#758, captured by
// `gh api graphql` 2026-10-11 into test/fixtures/), plus collectGateFacts' pagination.

import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGateVerdict, collectGateFacts, recordsFromBody, findingIdOf, RECORD_LANG } from '../src/review-gate.mjs';

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

test('findingIdOf reads the rg: prefix only', () => {
  expect(findingIdOf('<!-- rg:1-A-0 --> comment')).toBe('1-A-0');
  expect(findingIdOf('plain comment')).toBe(null);
});

const facts = (records, threads = []) => ({ head: HEAD, records, threads });

test('pass: two reviewers, two models, the head, a resolved blocking finding', () => {
  const f = facts(
    [
      ...recordsFromBody(rec({ reviewer: 'A', model: 'model-a', findings: [{ id: '1-A-0', severity: 'blocking', file: 'x', line: 1 }] })),
      ...recordsFromBody(rec({ reviewer: 'B', model: 'model-b' })),
    ],
    [{ findingId: '1-A-0', isResolved: true, hasReplyAfterFinding: false }],
  );
  expect(deriveGateVerdict(f).verdict).toBe('pass');
});

test('wait: no record on the PR head (a stale-head review)', () => {
  const v = deriveGateVerdict(facts(recordsFromBody(rec({ head: 'b'.repeat(40) }))));
  expect(v.verdict).toBe('wait');
  expect(v.reason).toMatch(/no review on a{7}/);
});

test('wait: round 1 with one reviewer', () => {
  expect(deriveGateVerdict(facts(recordsFromBody(rec()))).verdict).toBe('wait');
});

test('hold: two reviewers on ONE model — a concluded but invalid round one', () => {
  const f = facts([...recordsFromBody(rec({ reviewer: 'A', model: 'same' })), ...recordsFromBody(rec({ reviewer: 'B', model: 'same' }))]);
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

test('error: a record that does not parse is never a pass', () => {
  const f = facts([{ parseError: true }, ...recordsFromBody(rec()), ...recordsFromBody(rec({ reviewer: 'B', model: 'model-b' }))]);
  expect(deriveGateVerdict(f).verdict).toBe('error');
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

test('collectGateFacts reads BOTH review pages through the injected fetch', async () => {
  const pr758 = real('gate-site-main-758.json');
  const page1 = {
    data: {
      repository: {
        pullRequest: {
          headRefOid: pr758.headRefOid,
          reviews: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: pr758.reviews.nodes.slice(0, 1) },
          reviewThreads: { nodes: pr758.reviewThreads.nodes },
        },
      },
    },
  };
  const page2 = {
    data: {
      repository: {
        pullRequest: {
          headRefOid: pr758.headRefOid,
          reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: pr758.reviews.nodes.slice(1) },
          reviewThreads: { nodes: [] },
        },
      },
    },
  };
  const calls = [];
  const fetchImpl = async (query, variables) => {
    calls.push(variables.cursor ?? null);
    return calls.length === 1 ? page1 : page2;
  };
  const out = await collectGateFacts({ owner: 'immediately-run', name: 'immediately-run-site-main', pr: 758 }, fetchImpl);
  expect(calls.length).toBe(2);
  expect(calls[1]).toBe('c1');
  expect(out.head).toBe(pr758.headRefOid);
  expect(out.threads.length).toBe(pr758.reviewThreads.nodes.length);
});
