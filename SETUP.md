# SETUP

Instructions for an agent that sets up dsh-superagent with its operator. If you are a person, ask your coding agent to read this file and follow it.

Below, `$DSH_HOME` means `${DSH_HOME:-$HOME/.dsh}`.

## How to run the setup

The setup follows [docs/000-philosophy.md](docs/000-philosophy.md): it takes as little of the operator's attention as possible.

- **Before the first question,** read only this file and `docs/000-philosophy.md`, and run the probe below once. Read nothing else until every answer is collected.
- **Ask one question per message,** about one thing. Wait for the answer before the next one. Skip a question the probe already answers.
- **Keep each message under 300 words,** unless the operator asks for more. Give each question a recommended answer the operator can accept with one word, and one sentence on why it matters.
- **Do not execute while asking.** Collect every answer, then send one message with the full plan, and execute only after the operator confirms it.
- **Never ask for a secret in the chat.** Steps that need the operator's hands, such as creating an account, signing a CLI in or entering an app secret, go into one message with the exact commands to run in their own terminal.
- **Teach the philosophy through the questions,** one sentence at a time, not as a lecture.

## 1. Probe

Run from this checkout, once, and keep the result to yourself:

```sh
node -v; pnpm -v; git --version; tmux -V; python3 --version; gh --version | head -1; dsh --version
gh api user --jq .login
command -v lark-cli
grep -l -E 'id: dsh-superagent\b' "${DSH_HOME:-$HOME/.dsh}"/profiles/*/cordis.patch.yml 2>/dev/null
```

- **Prerequisites:** Node.js 22.19+ or 24+, pnpm, git 2.32+, tmux, Python 3.8+, GitHub CLI 2.48+, and DSH within the `engines.dsh` range of `package.json`. A missing one becomes an item of the plan, not a question. DSH also needs a model provider; if the operator has never run DSH with a model, configuring one is an operator step.
- **Operator login:** the `gh api user` result is the operator's own GitHub login, used as the recommendation in question 5.
- **Existing setup:** distinguish repository profiles from the Desktop controller (`mode: control`). Ask whether to continue; keep existing configuration, and read Upgrade in `docs/006-deployment.md`. Later repository additions create another profile and append one Fleet row; they do not reinitialize existing profiles.

## 2. Questions

Ask in this order, one per message, following the flow of work in [docs/001-domain.md](docs/001-domain.md): first where Triggers come from, then who may ask for work there, then what the Executor does with a Ticket. Recommendations are in brackets.

**Sources: where requests come from.**

1. **Sources.** Should the agent take requests from GitHub only, or also from Feishu chats? [GitHub only, unless the team works in Feishu.]
2. **Repositories.** Which github.com repositories should the agent work on, as a list of `owner/name` values? Start with one unless the operator already wants a fleet.
3. **Agent account.** Which GitHub user account will the agent act as? [A dedicated account, never the operator's own: everything the agent writes appears under this name.] It may not exist yet; creating it is an operator step.
4. With Feishu: **which chats per repository,** by name? The agent looks up their ids after the bot is configured. Running deployments must use disjoint chat sets and direct-message scopes. With one shared bot identity, enable direct messages for at most one deployment and set `otherChats: mentions` for at most one deployment; use separate bots for separate direct-message or catch-all scopes.

**Policy: who may ask for work.**

5. **On GitHub.** Which GitHub logins may ask the agent for work? [Only `<operator login>`: the agent acts only for people on this list, and a short list keeps the team's noise low while the operator learns how the agent behaves.]
6. With Feishu: **who may ask in Feishu?** [Everyone in the first chat, kept in sync with its members.]

**Execution: what the agent does with a Ticket.**

7. **Checkouts.** Which local clone should each repository deployment use for Tickets? [A separate clean clone per repository under `~/src/<name>`.]
8. **Commit identity.** Who should the agent's commits name as author? [The agent account, so its work is visibly its own.] Another identity, such as the operator's, goes into the Delivery requirements prompt section.
9. **Auto-merge.** Should the agent enable auto-merge on its own pull requests once they are ready and approved? [No: people merge until the agent's pull requests have been right for a while.] The agent never enables it as the agent account, so with yes it needs the GitHub CLI of another account that may merge: ask the operator to sign one in among the operator steps, and name it in Delivery requirements. With no, remove the auto-merge paragraph from Delivery requirements.

For each repository, derive a deployment row:

| Repository | ID | DSH profile | Port | State directory | Workspace | Execution root |
| --- | --- | --- | --- | --- | --- | --- |
| `owner/repo-a` | `repo-a` | `superagent-repo-a` | `3082` | `$DSH_HOME/state/superagent-repo-a` | `<home>/src/repo-a` | `<state>/work` or another dedicated root |
| `owner/repo-b` | `repo-b` | `superagent-repo-b` | `3083` | `$DSH_HOME/state/superagent-repo-b` | `<home>/src/repo-b` | `<state>/work` or another dedicated root |

Use one separate controller state directory, such as `$DSH_HOME/state/superagent-control`. Across deployments, resolve real paths and reject duplicate or overlapping state directories, workspaces and effective execution roots before installing anything. A deployment's own execution root may be under its own state directory. Fleet does not enforce state-directory uniqueness.

Before proceeding, confirm that the operator accepts that workers for every listed repository run with the same OS user and reachable credentials. Repository content, Issues, pull requests, CI output and tool output are untrusted model input, so a worker can expose anything this OS user can reach. If the repositories are not in one trust boundary, stop and use separate OS users and Desktop Fleets.

Do not ask about values with a good default; list them in the plan instead:

- one repository-bound profile per deployment, kept apart from the profile the operator works in, so it restarts without closing their Sessions;
- one model provider and default-model configuration in each new profile; use that profile's normal DSH provider settings and keep key material in its environment or credential store, not in this repository;
- one hourly check per deployment from the operator's own profile, which repairs dsh-superagent when it is not running;
- one shared local bundle version for the controller and all managed profiles; profiles restart independently but upgrade together;
- branch prefix `agent/`;
- accept mode `observe`, which records proactive work without doing it, and the default rules and prompt sections;
- with one shared Feishu bot identity: the bot reads only mentions, and direct messages are enabled for at most one deployment.

## 3. Plan

Send one message, under 300 words unless the deployment matrix needs more: what will be installed, the repositories and deployment table, the accounts and CLIs, the settings to save, the operator steps, and the defaults. Ask for one confirmation.

## 4. Execute

1. **Operator steps first.** Read the Accounts section of `docs/006-deployment.md`, write the CLI wrappers yourself, then send one message with what only the operator can do: create the agent account and, with auto-merge, sign a CLI in as the account that enables it, accept the repository invitations as the agent account, run `auth login` for each wrapper, and for Feishu create and publish the bot app and run the `config init` command with its secret. Wait until the operator says it is done, then check each login with `<wrapper> api user --jq .login`. Require `WRITE`, `MAINTAIN` or `ADMIN` from `<wrapper> repo view <owner/repo> --json viewerPermission --jq .viewerPermission` for every repository.
2. **Install and start.** Follow the Install, Machine configuration, and Start and stop sections of `docs/006-deployment.md`. Skip the installation of dsh-superagent itself: you are in its checkout. Clone each repository if question 7 asked for a new clone. For every row in the deployment matrix, install the bundle into a new profile or verify an existing installation, then merge [the profile template](examples/profile.cordis.patch.yml) into the profile's existing `cordis.patch.yml` and set its unique port, state directory and model configuration. Preserve existing provider, authentication and machine configuration; never replace an existing patch file. Start each deployment with `scripts/dsh-superagent --profile <profile> --url <url> start`. Exit 3 is expected while Source setup is pending; model failures surface in the **Try it** check after Sources are configured.
3. **Desktop control plane.** If the Desktop profile does not already contain the bundle, install it there with `dsh plugin --profile <desktop-profile> add "link:$PWD"`. Merge [the control template](examples/control.cordis.patch.yml) into that profile's existing `cordis.patch.yml`, then add the deployment rows to `<control stateDir>/fleet.json` as described under Native fleet in `docs/006-deployment.md`. Use absolute paths in the registry. Restart Desktop once after changing its patch file; later registry changes are read without editing the profile.
4. **Settings.** For each deployment, save settings through its Management API in this order: the `github` Source, the `feishu` Source if used, the `policy` block with the allowed lists (for Feishu, look up the chat ids with the bot's CLI first), and the `executor` block with a prepare command from the answer to question 7. Point that prepare command at the row's workspace. Then save the prompts with the commit identity of question 8 and the auto-merge answer of question 9 in Delivery requirements. A save that returns `restarting: true` restarts that profile: wait until its `scripts/dsh-superagent --profile <profile> --url <url> status` no longer exits 1 before the next request, and read the revisions again from `GET settings`.
5. **Failures.** A refused save names the setup problem in its response body. Find it in the Troubleshooting table of `docs/006-deployment.md`, fix it, and continue. Ask the operator only for what you cannot fix yourself.

## 5. Verify and hand over

For every deployment, `scripts/dsh-superagent --profile <profile> --url <url> status` must exit 0 with no setup problem, and Desktop Fleet must show the expected repository. For Feishu deployments, its status JSON must also report no `feishu` setup problem and Feishu Source health `ready`. Create one hourly check per deployment from the Hourly check section of `docs/006-deployment.md` with your schedule tool; otherwise give the operator its prompts to schedule there. Then send one message, under 300 words unless the deployment matrix needs more:

- The single **Superagent** Fleet view in Desktop, and which repository to select for each deployment.
- How to try each deployment: from an account on its allowed list, comment `@<agent login> <request>` on an issue in that repository. Exactly one Ticket should appear in its overview within about a minute.
- Three rules for the operator, from the Responsibility section of `docs/000-philosophy.md`: start narrow, tune for less noise, own what the agent says.
- Where to read more: the numbered documents in `docs/`, in order.
