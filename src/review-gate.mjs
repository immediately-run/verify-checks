// review-gate (R3-1166) — a deterministic verdict bound to the reviewed head commit.
//
// The merge rule ("zero open blocking findings, the last round concluded on the current
// head") was applied by the session that wrote the PR, and nothing on GitHub enforced it.
// This module is the enforcement's read half: reviewers post a machine-readable gate
// record (a fenced `review-gate-record` block in the review body) and prefix each inline
// finding comment with `<!-- rg:<id> -->`; deriveGateVerdict reads ONLY those facts, never
// prose. stamphog's verdict_rule.py is the shape: the model reports facts, code derives
// the verdict, and only reviews on the current head count.

/** The info string of the gate record's fenced block. */
export const RECORD_LANG = 'review-gate-record';
/** The inline finding comment's id prefix. */
export const RG_PREFIX = '<!-- rg:';

const SEVERITIES = new Set(['blocking', 'should-fix', 'nit']);

/** Extract every gate record from a review body. A malformed record is not skipped —
 *  it yields { parseError: true }, which the verdict reads as `error` (a record that
 *  does not parse must never read as "no record"). */
export function recordsFromBody(body) {
  const out = [];
  const re = new RegExp('```' + RECORD_LANG + '\\n([\\s\\S]*?)```', 'g');
  let m;
  while ((m = re.exec(body ?? '')) !== null) {
    try {
      const r = JSON.parse(m[1]);
      const valid =
        r &&
        r.schema === 1 &&
        typeof r.head === 'string' &&
        /^[0-9a-f]{40}$/.test(r.head) &&
        Number.isInteger(r.round) &&
        typeof r.reviewer === 'string' &&
        typeof r.model === 'string' &&
        Array.isArray(r.findings) &&
        r.findings.every((f) => f && typeof f.id === 'string' && SEVERITIES.has(f.severity));
      out.push(valid ? r : { parseError: true, raw: m[1].slice(0, 200) });
    } catch {
      out.push({ parseError: true, raw: m[1].slice(0, 200) });
    }
  }
  return out;
}

/** The finding id of an inline comment, from its `<!-- rg:<id> -->` prefix, or null. */
export function findingIdOf(body) {
  const m = /<!-- rg:([\w.-]+) -->/.exec(body ?? '');
  return m ? m[1] : null;
}

/**
 * facts: {
 *   head: string — the PR's head SHA,
 *   records: parsed gate records from every review (with their review's commit oid),
 *   threads: [{ findingId: string|null, isResolved: boolean, hasReplyAfterFinding: boolean }]
 * }
 *
 * The verdict:
 *   error — a record did not parse.
 *   wait  — no record matches the head, or the newest round on the head is round 1
 *           with fewer than two records from two different models.
 *   hold  — a blocking finding on the newest head round is open (thread unresolved
 *           AND no reply after the finding comment).
 *   pass  — otherwise.
 */
export function deriveGateVerdict(facts) {
  const { head, records, threads } = facts;
  if (records.some((r) => r.parseError)) return { verdict: 'error', reason: 'a gate record did not parse' };
  const onHead = records.filter((r) => r.head === head);
  if (onHead.length === 0) return { verdict: 'wait', reason: `no review on ${head.slice(0, 7)}` };
  const newestRound = Math.max(...onHead.map((r) => r.round));
  const round = onHead.filter((r) => r.round === newestRound);
  if (newestRound === 1) {
    const models = new Set(round.map((r) => r.model));
    if (round.length < 2) {
      return { verdict: 'wait', reason: `round 1 on ${head.slice(0, 7)} has ${round.length} record(s) — two reviewers required` };
    }
    // Two records on one model is a CONCLUDED but invalid round one (a deviation, not a
    // pending state) — hold, not wait: nothing further arrives on its own.
    if (models.size < 2) {
      return { verdict: 'hold', reason: `round 1 on ${head.slice(0, 7)}: two records, one model — the two reviewers must differ` };
    }
  }
  const threadByFinding = new Map(threads.filter((t) => t.findingId).map((t) => [t.findingId, t]));
  for (const r of round) {
    for (const f of r.findings) {
      if (f.severity !== 'blocking') continue;
      const t = threadByFinding.get(f.id);
      // A blocking finding with NO thread (body-only) is open by construction: nothing
      // resolved it and nothing replied.
      if (!t || (!t.isResolved && !t.hasReplyAfterFinding)) {
        return { verdict: 'hold', reason: `blocking finding ${f.id} (round ${newestRound}) is open` };
      }
    }
  }
  return { verdict: 'pass', reason: `round ${newestRound} on ${head.slice(0, 7)} concluded with no open blocking finding` };
}

/** The GraphQL page shape collectGateFacts reads. */
const QUERY = `query($owner:String!,$name:String!,$pr:Int!,$cursor:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$pr){
    headRefOid
    reviews(first:50){ pageInfo{ hasNextPage endCursor } nodes{ body state commit{ oid } author{ login } } }
    reviewThreads(first:100){ nodes{ isResolved comments(first:20){ nodes{ body createdAt author{ login } } } } }
  } } }`;

/** Read a PR's reviews + review threads by GraphQL (paginated on reviews) into the
 *  facts deriveGateVerdict consumes. `fetchImpl(query, variables) → parsed response
 *  JSON` — injectable so the test never touches the network. */
export async function collectGateFacts({ owner, name, pr }, fetchImpl) {
  const records = [];
  const threads = [];
  let cursor = null;
  let head = null;
  for (;;) {
    const res = await fetchImpl(QUERY, { owner, name, pr, cursor });
    const prNode = res?.data?.repository?.pullRequest;
    if (!prNode) throw new Error(`collectGateFacts: no pullRequest in the response for ${owner}/${name}#${pr}`);
    head = prNode.headRefOid;
    for (const rev of prNode.reviews.nodes) {
      for (const r of recordsFromBody(rev.body)) records.push(r);
    }
    for (const t of prNode.reviewThreads.nodes) {
      const comments = t.comments.nodes;
      const first = comments[0];
      threads.push({
        findingId: first ? findingIdOf(first.body) : null,
        isResolved: t.isResolved,
        // A reply AFTER the finding comment (any author — today the reviewers and the
        // implementer post as one GitHub identity; the residual is the item's own).
        hasReplyAfterFinding: comments.length > 1,
      });
    }
    if (!prNode.reviews.pageInfo.hasNextPage) break;
    cursor = prNode.reviews.pageInfo.endCursor;
  }
  return { head, records, threads };
}
