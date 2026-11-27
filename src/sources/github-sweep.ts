/**
 * The sweep of the agent's own open pull requests: a conflict with the base branch or a draft whose work stopped becomes a
 * Trigger to the Ticket that opened it, and an approval that does not merge becomes one notice on the pull request.
 */
import { key, latestReport, type Ticket, type Trigger } from '../core/index.ts'
import type { Commands, Tally } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { conflicted, type Pull } from './github-pull.ts'
import { ciCounts, type CiSnapshot } from './github-read.ts'
import { CommentSchema, githubChannel, SOURCE } from './github-trigger.ts'
import type { SourceContext } from './host.ts'

/** The sweep's validated `GithubConfig` fields, in seconds. */
export interface SweepConfig { sweepSeconds: number; staleDraftSeconds: number; approvedSeconds: number }
/** Report states after which a ticket's worker does no more work on its own. */
const STOPPED = new Set(['ready', 'waiting', 'dropped'])

/** Builds the Trigger that asks a ticket's worker to act on a finding of the sweep; its ID repeats for the same finding. */
export function sweepTrigger(pr: Pull, finding: 'conflict' | 'draft', fingerprint: string, text: string): Trigger {
  return { id: key('github-sweep', String(pr.number), finding, fingerprint), source: SOURCE, threads: [{ source: SOURCE, id: String(pr.number) }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(), text, channel: githubChannel(pr.number), url: pr.html_url,
    meta: { number: pr.number, isPr: true, prAuthor: pr.user.login, sweep: finding } }
}

/**
 * Sweeps one open pull request the agent opened for `ticket`, at most once per `sweepSeconds`:
 * - a conflict with the base branch is a Trigger asking the worker to merge or rebase the base and resolve it, once per head;
 * - a draft whose ticket last reported `ready`, `waiting` or `dropped` at least `staleDraftSeconds` ago is a Trigger asking the
 *   worker to finish it or close it with a reason, once per report;
 * - a pull request approved at least `approvedSeconds` ago that is not merging (auto-merge off, merge blocked, or CI failed or
 *   running without auto-merge) is a notice on it naming why, once per head and approval. CI is reported, not retried.
 */
export async function sweepOwnPull(ctx: SourceContext, commands: Commands, ticket: Ticket, pr: Pull, ci: CiSnapshot,
  config: SweepConfig, now: number, tally?: Tally): Promise<void> {
  const swept = KV.github.sweep(pr.number)
  if (now - Date.parse(ctx.state.get(swept) ?? '') < config.sweepSeconds * 1000) return
  ctx.state.set(swept, new Date(now).toISOString())
  if (conflicted(pr)) {
    const base = pr.base?.ref ?? 'its base branch'
    await ctx.receive(sweepTrigger(pr, 'conflict', pr.head.sha, `Sweep: PR #${pr.number} conflicts with ${base} at ${pr.head.sha.slice(0, 7)}. `
      + `Merge ${base} into ${pr.head.ref} (or rebase onto it), resolve the conflicts, verify the result, and push.`))
    return
  }
  const report = latestReport(ticket)
  if (pr.draft) {
    if (!report || !STOPPED.has(report.state) || now - Date.parse(report.at) < config.staleDraftSeconds * 1000) return
    await ctx.receive(sweepTrigger(pr, 'draft', report.at, `Sweep: PR #${pr.number} is still a draft, but this ticket last reported `
      + `${report.state} at ${report.at}. Finish it and mark it ready for review (gh pr ready ${pr.number}), or close it with a comment `
      + 'that says why. Do not say the work is completed while the PR is a draft.'))
    return
  }
  const approval = await approvedBy(commands, pr, ctx.deployment.github.login, tally)
  if (!approval || now - Date.parse(approval.at) < config.approvedSeconds * 1000) return
  const counts = ciCounts(ci)
  const autoMerge = pr.auto_merge != null
  const reasons = [...!autoMerge ? ['auto-merge is off'] : [],
    ...pr.mergeable_state === 'blocked' ? ['GitHub reports the merge as blocked by the branch rules'] : [],
    ...pr.mergeable_state === 'behind' ? ['the branch is behind its base'] : [],
    ...counts.failed ? [`${counts.failed} CI checks failed`] : [],
    ...counts.running ? [`${counts.running} CI checks are still running`] : []]
  // Auto-merge merges once running checks pass, so running checks alone do not hold it.
  if (!reasons.length || (autoMerge && reasons.every(reason => reason.endsWith('still running')))) return
  ctx.notify({ id: key('github-sweep', String(pr.number), 'approved', pr.head.sha, String(approval.id)), channel: githubChannel(pr.number),
    text: `Approved, but not merging: ${reasons.join('; ')}. Merging needs a person with merge rights; this is reported once per commit.`,
    kind: 'notice', ticketId: ticket.id })
}
/** The latest approval when every reviewer other than the agent whose latest decision counts approved, else undefined. */
async function approvedBy(commands: Commands, pr: Pull, login: string, tally?: Tally): Promise<{ id: number; at: string } | undefined> {
  const reviews = await commands.pages(CommentSchema, `pulls/${pr.number}/reviews?per_page=100`, tally)
  const latest = new Map<string, { id: number; state: string; at: string }>()
  for (const review of reviews) {
    if (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED' && review.state !== 'DISMISSED') continue
    if (sameName(review.user.login, login) || sameName(review.user.login, pr.user.login)) continue
    latest.set(review.user.login.toLowerCase(), { id: review.id, state: review.state, at: review.submitted_at ?? '' })
  }
  const decisions = [...latest.values()]
  if (!decisions.some(item => item.state === 'APPROVED') || decisions.some(item => item.state === 'CHANGES_REQUESTED')) return undefined
  return decisions.filter(item => item.state === 'APPROVED').sort((a, b) => a.at.localeCompare(b.at)).at(-1)
}
