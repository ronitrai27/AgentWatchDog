// The trace of every webhook: written once per delivery, in one transaction, so the same event
// can never be counted twice and a newer one always knows which older one it replaced.
import { db } from "./db";
import type { Summary, Verdict } from "./github-webhook";

export type Entry = {
  delivery: string;
  event: string;
  action: string | null;
  repo: string | null;
  installation: number | null;
  sender: string | null;
  summary: Summary;
  verdict: Verdict;
  userId: string | null;
};

export type Replaced = {
  delivery: string;
  prNumber: number | null;
  sha: string | null;
  branch: string | null;
  ageSeconds: number;
};

const short = (sha: string | null) => (sha ?? "-").slice(0, 7);

/** What a newer event says about the one it replaced. */
function replacedBecause(e: Entry): string {
  const { verdict, summary: s } = e;
  if (!verdict.trigger) return "";
  return verdict.kind === "pr_to_default"
    ? `a newer pull request event arrived: #${s.prNumber ?? "?"} at ${short(s.sha)}`
    : `a newer CI failure arrived: ${short(s.sha)}`;
}

/**
 * Records the event. `duplicate` is true when GitHub sent this delivery before (it is counted as
 * a redelivery and nothing else happens). `replaced` lists the older events of the same kind on
 * the same repository that this one stopped.
 */
export async function recordEvent(
  e: Entry,
): Promise<{ duplicate: boolean; replaced: Replaced[] }> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const { verdict, summary: s } = e;
    const inserted = await client.query<{ fresh: boolean }>(
      `INSERT INTO webhook_events
         (delivery_id, event, action, repo, installation_id, sender, branch, sha, pr_number,
          title, listened, kind, reason, run_key, user_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (delivery_id)
         DO UPDATE SET redeliveries = webhook_events.redeliveries + 1
       RETURNING (xmax = 0) AS fresh`,
      [
        e.delivery,
        e.event,
        e.action,
        e.repo,
        e.installation,
        e.sender,
        s.branch,
        s.sha,
        s.prNumber,
        s.title,
        verdict.trigger,
        verdict.trigger ? verdict.kind : null,
        verdict.why,
        verdict.trigger ? verdict.key : null,
        e.userId,
        verdict.trigger ? "active" : "ignored",
      ],
    );
    if (!inserted.rows[0]?.fresh) {
      await client.query("COMMIT");
      return { duplicate: true, replaced: [] };
    }

    let replaced: Replaced[] = [];
    if (verdict.trigger && e.repo) {
      const { rows } = await client.query<{
        delivery_id: string;
        pr_number: number | null;
        sha: string | null;
        branch: string | null;
        age: string;
      }>(
        `UPDATE webhook_events
            SET status = 'superseded', superseded_by = $1, superseded_at = now(),
                supersede_reason = $2
          WHERE repo = $3 AND kind = $4 AND status = 'active' AND delivery_id <> $1
        RETURNING delivery_id, pr_number, sha, branch,
                  extract(epoch from now() - received_at) AS age`,
        [e.delivery, replacedBecause(e), e.repo, verdict.kind],
      );
      replaced = rows.map((r) => ({
        delivery: r.delivery_id,
        prNumber: r.pr_number,
        sha: r.sha,
        branch: r.branch,
        ageSeconds: Math.round(Number(r.age)),
      }));
    }
    await client.query("COMMIT");
    return { duplicate: false, replaced };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export { replacedBecause, short };
