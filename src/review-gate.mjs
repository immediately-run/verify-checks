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
/** The inline finding comment's id prefix (anchored: the comment STARTS with it). */
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

/** The finding id of an inline comment, from its leading `<!-- rg:<id> -->`, or null.
 *  Anchored: the item's format has the comment START with the marker, so a comment that
 *  merely quotes one mid-body claims no id. */
export function findingIdOf(body) {
  const m = new RegExp('^' + RG_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\w.-]+) -->').exec(body ?? '');
  return m ? m[1] : null;
}

/**
 * facts: {
 *   head: string — the PR's head SHA,
 *   records: parsed gate records, each tagged `reviewHead` (its review's commit oid),
 *   threads: [{ findingId: string|null, isResolved: boolean, hasReplyAfterFinding: boolean }]
 * }
 *
 * The verdict:
 *   error — a record ON the current head (its review's commit, or its own head field)
 *           did not parse. A malformed record on a STALE head review is not the current
 *           head's error.
 *   wait  — no record matches the head, or round 1 on the head has one record only.
 *   hold  — round 1 on the head concluded with two records on ONE model or ONE reviewer
 *           (a concluded-but-invalid round, not a pending one); or a blocking finding in
 *           ANY record on the head is open (its thread unresolved AND unreplied; a
 *           body-only blocking finding has no thread and is open by construction); at
 *           round ≥ 3 the reason says "decision packet".
 *   pass  — otherwise.
 */
export function deriveGateVerdict(facts) {
  const { head, records, threads } = facts;
  if (records.some((r) => r.parseError && (r.reviewHead === head || r.head === head))) {
    return { verdict: 'error', reason: 'a gate record did not parse' };
  }
  const onHead = records.filter((r) => r.head === head);
  if (onHead.length === 0) return { verdict: 'wait', reason: `no review on ${head.slice(0, 7)}` };
  const newestRound = Math.max(...onHead.map((r) => r.round));
  const round = onHead.filter((r) => r.round === newestRound);
  if (newestRound === 1) {
    if (round.length < 2) {
      return { verdict: 'wait', reason: `round 1 on ${head.slice(0, 7)} has ${round.length} record(s) — two reviewers required` };
    }
    const models = new Set(round.map((r) => r.model));
    const reviewers = new Set(round.map((r) => r.reviewer));
    if (models.size < 2 || reviewers.size < 2) {
      return {
        verdict: 'hold',
        reason: `round 1 on ${head.slice(0, 7)}: ${round.length} records, ${reviewers.size} reviewer(s), ${models.size} model(s) — the two reviewers must differ, on two models`,
      };
    }
  }
  const threadByFinding = new Map(threads.filter((t) => t.findingId).map((t) => [t.findingId, t]));
  // EVERY record on the head, not only the newest round's: a reply-only closure leaves
  // the round-1 record's findings open in ITS record while a round-2 record lands clean
  // on the same head — scoping to the newest round would read that as a pass.
  for (const r of onHead) {
    for (const f of r.findings) {
      if (f.severity !== 'blocking') continue;
      const t = threadByFinding.get(f.id);
      if (!t || (!t.isResolved && !t.hasReplyAfterFinding)) {
        const reason = `blocking finding ${f.id} (round ${r.round}) is open`;
        return { verdict: 'hold', reason: r.round >= 3 ? `${reason} — decision packet` : reason };
      }
    }
  }
  return { verdict: 'pass', reason: `round ${newestRound} on ${head.slice(0, 7)} concluded with no open blocking finding` };
}

/** The GraphQL page shape collectGateFacts reads. Every declared variable is wired. */
const QUERY = `query($owner:String!,$name:String!,$pr:Int!,$cursor:String,$threadCursor:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$pr){
    headRefOid
    reviews(first:50, after:$cursor){ pageInfo{ hasNextPage endCursor } nodes{ body state commit{ oid } author{ login } } }
    reviewThreads(first:100, after:$threadCursor){ pageInfo{ hasNextPage endCursor } nodes{ isResolved comments(first:20){ nodes{ body createdAt author{ login } } } } }
  } } }`;

/** Read a PR's reviews + review threads by GraphQL (both paginated) into the facts
 *  deriveGateVerdict consumes. `fetchImpl(query, variables) → parsed response JSON` —
 *  injectable so the test never touches the network. */
export async function collectGateFacts({ owner, name, pr }, fetchImpl) {
  const records = [];
  const threads = [];
  const seenThreads = new Set();
  const seenReviews = new Set();
  let cursor = null;
  let threadCursor = null;
  let head = null;
  for (;;) {
    const res = await fetchImpl(QUERY, { owner, name, pr, cursor, threadCursor });
    const prNode = res?.data?.repository?.pullRequest;
    if (!prNode) throw new Error(`collectGateFacts: no pullRequest in the response for ${owner}/${name}#${pr}`);
    head = prNode.headRefOid;
    // A continuation call that only advances the THREAD cursor re-answers reviews page
    // 1 (after:null) — never re-process its reviews (a duplicated record flips a
    // one-record round 1 from wait to a false hold). Reviews dedupe by identity (the
    // review's commit + body), threads by finding id below.
    for (const rev of prNode.reviews.nodes) {
      const rk = `${rev.commit?.oid ?? ''}:${rev.body ?? ''}`;
      if (seenReviews.has(rk)) continue;
      seenReviews.add(rk);
      for (const r of recordsFromBody(rev.body)) records.push({ ...r, reviewHead: rev.commit?.oid ?? null });
    }
    for (const t of prNode.reviewThreads.nodes) {
      const comments = t.comments.nodes;
      const first = comments[0];
      const id = first ? findingIdOf(first.body) : null;
      // The query re-requests the thread page on every reviews page — dedupe by the
      // finding id (or the first comment's body hash when it carries no marker).
      const key = id ?? `${t.isResolved}:${first?.body?.slice(0, 80) ?? ''}`;
      if (seenThreads.has(key)) continue;
      seenThreads.add(key);
      threads.push({
        findingId: id,
        isResolved: t.isResolved,
        // A reply AFTER the finding comment (any author — today the reviewers and the
        // implementer post as one GitHub identity; the residual is the item's own).
        hasReplyAfterFinding: comments.length > 1,
      });
    }
    const rp = prNode.reviews.pageInfo;
    const tp = prNode.reviewThreads.pageInfo;
    cursor = rp.hasNextPage ? rp.endCursor : null;
    threadCursor = tp.hasNextPage ? tp.endCursor : null;
    if (!cursor && !threadCursor) break;
  }
  return { head, records, threads };
}

/** The check run's name, one home (the bin's GET filter and the POSTed name must agree,
 *  or the update-in-place silently returns to POST-per-dispatch). */
export const CHECK_NAME = 'review-gate';

/** Which of a head's same-name check runs a new verdict updates, and what the update
 *  carries. Pure for its test. The API documents NO array order for the list endpoint,
 *  so the pick is explicit: the live run with the HIGHEST id (newest created). Every
 *  OTHER still-open run is settled `completed`/`cancelled` — a twin left open reads as
 *  pending forever (the ambiguity the update-in-place exists to remove). Returns
 *  { patch: { id, body }, cancel: [{ id, body }] } or { create: body }. */
export function existingRunUpdate(checkRuns, runBody) {
  const mine = (checkRuns ?? []).filter((c) => c.name === runBody.name);
  const open = mine.filter((c) => c.status !== 'completed');
  if (open.length === 0) return { create: runBody };
  const latest = open.reduce((a, b) => (b.id > a.id ? b : a));
  const { name: _n, head_sha: _h, ...rest } = runBody;
  return {
    patch: { id: latest.id, body: rest },
    cancel: open.filter((c) => c.id !== latest.id).map((c) => ({ id: c.id, body: { status: 'completed', conclusion: 'cancelled' } })),
  };
}

/** The verdict → check-run mapping (the item's "Check-run mapping", pure for its test):
 *  pass → success; hold → failure; wait → in_progress ("no review on <sha7>"); error →
 *  failure titled "error" — never a pass. */
export function checkRunFor(verdict, reason, head) {
  const CONCLUSION = { pass: 'success', hold: 'failure', error: 'failure' };
  return {
    name: CHECK_NAME,
    head_sha: head,
    ...(CONCLUSION[verdict] ? { status: 'completed', conclusion: CONCLUSION[verdict] } : { status: 'in_progress' }),
    output: { title: verdict === 'error' ? 'error' : verdict, summary: reason },
  };
}
