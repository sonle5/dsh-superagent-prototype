For every ticket that changes UI, the PR description must contain BOTH Before and After visual evidence, labelled, with the baseline and changed revision identified, of the same scenario, viewport, theme and relevant UI state; After-only evidence is incomplete.
Use real captures, not a mockup presented as the previous implementation, without private Feishu content or credentials, and refresh them when later UI changes make them stale.
Without a real baseline capture, state what is missing, keep the handoff incomplete, and do not claim the UI PR is ready; the orchestrator checks the reported evidence before delivering a ready result.

For a change users see, show each acceptance criterion working in the shipped product (packaged app, installer or deployed page) at a commit, or mark it "not verified" with what is needed and ask a person.
For a removal or rename, search the whole repository for it and its sources, including identity, packaging and generated files.

Each push starts CI, so push once per logical update, after any commit, rebase and amend; never push a change and force-push it again moments later.
Before each push, run the cheap local checks the repository names for the touched area, such as static gates, lint, type check and specs of edited workflow or configuration files.
Do not push while one of them fails; if one cannot run here, say why in the PR description rather than push to learn it from CI.
Open a new PR as a draft with `gh pr create --draft` and mark it ready with `gh pr ready <number>` only after your own verification passes.
Rebase a PR branch only for a conflict or a base change it needs.

Request the reviews the matched rules, assignment, prompts or repository ask for.
Never enable auto-merge as the agent account: use only the merge CLI this section names, as `<merge CLI> pr merge <number> --auto --merge --match-head-commit <sha> --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY`.
When this section names no merge CLI, a person merges every PR.
With a merge CLI, enable auto-merge for the head commit of a PR you opened from the ticket branch once all of these hold: the PR is ready; it changes fewer than 200 lines (additions plus deletions); each approval those instructions require covers that commit; and if it changes what users see, those instructions name who approves such changes and that approval covers the commit.
Report ready without waiting for approvals, and enable auto-merge when they arrive.
Otherwise a person merges the PR; say so in your report.
Withdraw auto-merge with `<merge CLI> pr merge <number> --disable-auto --repo $DSH_SUPERAGENT_GITHUB_REPOSITORY` as soon as any of these stops holding, such as when a review requests changes, and before you push to the PR; enable it again once they hold for the new head.
When the agent account is a requested reviewer of a PR it did not open, submit an approving review once no finding of yours is open at the head commit, and `gh pr review --request-changes` while one is; approve again after a push moves the head.
Review against the issue, not only the diff: an unverified criterion, one with only unit-test evidence where the issue names a shipped surface, or a head-commit check failing or still running is an open finding, never "no findings"; link each failing log.
Never approve a PR the agent account opened, approve or merge on behalf of another reviewer, or merge a PR you did not open.
Credit each person who reviews a PR you opened, once per PR, on every commit of the PR branch: when a human reviewer's feedback on it is first assessed, rewrite the branch so each of its commits carries one `Co-authored-by: <name or login> <id+login@users.noreply.github.com>` trailer per person credited so far, with the id from `gh api users/<login> --jq .id`.
Withdraw auto-merge first as above.
Run `git fetch origin`, set `base=$(git merge-base HEAD origin/<base branch>)` with the base branch from `gh pr view <number> --json baseRefName` and `old=$(git rev-parse origin/<head branch>)`, then run `FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter 'git interpret-trailers --if-exists addIfDifferent --trailer "<trailer>"' $base..HEAD` with one `--trailer` per person credited, which changes only commit messages, and push with `git push --force-with-lease=<head branch>:$old`; if the push is rejected, stop and report.
Commits you add later carry the same trailers.
An approval of a commit also covers its rewritten copy, which has the same tree.
If the PR has merged, do not rewrite it; record the uncredited reviewer in orchestrator_report.
Never push an empty commit to credit a reviewer.
Do not credit bots (logins ending in [bot] and the accounts these instructions name as review bots), the PR's author, the agent account, or the person these instructions name as commit author, who is already credited as the author of every commit.
Record whom you have credited in orchestrator_report, so a later worker does not credit them again.
If a human's branch or PR for the same problem contains this ticket's code (its commits, or its changes carried over), close this ticket's PR with gh at once, unasked, in one sentence naming the human's PR.
Related work without the ticket's code is no reason to close.
Closing the PR ends the ticket; send no other message.
