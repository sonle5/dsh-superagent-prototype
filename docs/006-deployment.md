# 006 Deployment

Use this guide to install, configure and operate dsh-superagent for one repository or a Desktop-managed fleet. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## What runs

- **A dedicated DeepSeek Harness profile per repository**, called `superagent-<deployment>` in this guide. Create each from the Web profile template. It loads the bundle and serves its internal panel on `127.0.0.1`. Keep these separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and each process restarts independently.
- **An agent GitHub account.** The agent comments, pushes branches and opens pull requests as this account, through a GitHub CLI signed in only as that account. Reuse it only for repositories trusted to the same operator OS user and credential set.
- **Optional:** a Feishu bot for chat requests.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Sources for the repository and accounts, Policy for allowed lists, and Execution for worker directories and commands.

For several repositories, install the bundle and control script once, then create one independent managed profile per repository. DeepSeek Harness Desktop runs a repository-neutral controller in `mode: control` and presents every managed profile as a peer in Fleet. The repository profiles keep separate ports, state, Sessions, worktrees and model overrides; Desktop remains the single operator interface.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory, sibling profiles, repositories and credentials. Repository files, Issues, pull requests, CI output and tool output are untrusted model input. Allowing external contributors to shape them can expose everything the worker can reach; prompt injection may induce disclosure or unsafe commands. Profiles and Fleet separate runtime state, not security domains. For stronger isolation, use a dedicated OS account or Desktop environment containing only that trust domain's credentials, and keep high-value secrets outside it.

## Prerequisites

- Node.js 22.19+ or 24+, pnpm, git 2.32+, Python 3.8+ and tmux
- GitHub CLI (`gh`) 2.48 or later. Source CLI fields must point to `gh` or `lark-cli` wrappers; the host relies on their subcommands and output formats.
- One or more repositories on github.com; GitHub Enterprise Server is not supported. To create a checkout per Ticket, keep a separate local clone for each deployment from which its prepare command can add worktrees. Install `git-lfs` if a repository uses Git LFS.
- DeepSeek Harness Desktop for the Fleet control plane, plus `curl` and `jq` for the documented Management API examples.
- A model provider configured in every new DeepSeek Harness profile. dsh-superagent uses that profile's default model unless its Eval or Execution settings name another.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot

Below, `$DSH_HOME` means `${DSH_HOME:-$HOME/.dsh}`.

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to each repository. A GitHub App cannot be the agent, because dsh-superagent acts through the account's authenticated GitHub CLI. A shared account exposes their union of access to every worker that can use it.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. dsh-superagent reads the login the same way.

   A fine-grained PAT needs repository access limited to the deployment repository, with Contents, Issues and Pull requests read/write, Actions and Commit statuses read-only, and Metadata read. GitHub does not let a fine-grained PAT read the account notification inbox or call the Checks API. DSH therefore falls back from check runs to repository Actions workflow runs; Commit statuses read-only remains required. Turn off **Read the account notification inbox** under the GitHub Source's advanced settings, then enable the repository observation streams needed by that deployment, normally both **Receive new Issues** and **Receive comments**. A classic token is not required for notification or CI polling.

   The CLI may use a dedicated agent account or the operator's account. With the operator's account, address the agent explicitly (`@<agent login>`) in an Issue or PR, or post a comment; unmentioned same-account Issue and PR bodies are treated as agent output. Every Superagent comment carries a hidden `<!-- dsh-superagent:… -->` marker, which the Source skips so it cannot invoke itself. A dedicated least-privilege account remains preferable when the team can provide one.

### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

## Install

Run this block once in this checkout:

```sh
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh --version
```

When this repository is already the checkout, skip the `git clone` line. DeepSeek Harness Desktop is the preferred source of `dsh`; otherwise install `@deepseek-ai/dsh@<compatible-version>` using its current release guidance and verify that `dsh --version` satisfies `engines.dsh` in `package.json`. Check `command -v dsh` before creating profiles. Do not replace a newer Desktop-provided command with an older global package.

For each deployment, install this bundle into a new profile:

```sh
dsh --profile superagent-<deployment> --from-default-profile web --dump-config >/dev/null
dsh plugin --profile superagent-<deployment> add "link:$PWD"
```

The deployment patch targets the shipped `webserver` entry, so initialize a new repository profile from the `web` template before adding the Superagent bundle.

For the Desktop fleet controller, also install the bundle into the Desktop profile if it is not already present:

```sh
dsh plugin --profile <desktop-profile> add "link:$PWD"
```

`dsh plugin` initializes a missing profile and supports an existing one, but it changes the profile's package files; review those changes before restarting. On DeepSeek Harness Desktop the profile is normally `desktop`. `DSH_HOME` relocates the default `~/.dsh` directory. Reuse one bundle checkout and one control script for every local deployment. Use this bundle version for the controller and all managed profiles; profiles restart independently but upgrade together.

## Machine configuration

For each new repository-bound profile, merge the entries from [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) into `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, then replace every `<placeholder>` with the values from that deployment's row. Use a unique loopback port and absolute state directory. Configure a model provider and default model through that profile's normal DSH provider settings, including its `agent-default-model` entry; initialization does not copy them from Desktop. Non-secret provider entries may be adapted from a working profile, but keep key material in the referenced environment or credential store, not this repository. For Feishu, also enable the `dsh-superagent-feishu` entry. If providers or other machine configuration already exist in the file, keep them; the template is a patch fragment, not a replacement for the whole profile.

Across deployments, resolve and verify that state directories, workspaces and effective execution roots do not overlap. A deployment's execution root may be under its own state directory. Fleet rejects duplicate ids, profiles and URLs, but it does not enforce state-directory uniqueness. If `executor.directory` is unset, the effective Ticket root is `<stateDir>/work`.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute path: the database, the lock, the command shims in `worker-bin`, the agent's git configuration and, by default, the Ticket directories in `work`. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |

After the first start, edit machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

## Start and stop

```sh
scripts/dsh-superagent --profile <profile> --url <url> --state-dir <stateDir> start
scripts/dsh-superagent --profile <profile> --url <url> --state-dir <stateDir> status
```

`start` runs `dsh --profile <profile>` in tmux session `dsh-<profile>` on a tmux server socket derived from the profile name. Each profile therefore has an independent tmux server and systemd cgroup, even when several deployments share a machine. It waits up to one minute for the runtime to become ready or report a setup requirement. On a first run it prints the missing setup information. It refuses duplicate instances, including ones started outside this script. Pass both `--profile` and `--url` for every managed deployment; the profile name does not imply its port.

`stop` and `restart` request graceful shutdown and wait up to five minutes for Executors from the script, or one minute when invoked by Fleet. They never force-kill the process or touch other tmux sessions.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`. `--state-dir` defaults to `$DSH_HOME/state/<profile>` and must be passed for a custom state directory; Fleet supplies it automatically from its registry.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and setup requirements under `setup`. `start` and `restart` print those problems as lines; they exit 1 if the service never comes up. Only an intentional `stop` pauses automatic recovery.

Each profile stores logs and control files under `.artifacts/`:

- Startup logs: `dsh-superagent-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the script. The newest 20 are kept.
- Control files: `control/profiles/<profile>/`, containing the stop marker, lock and process id.

The launcher also gives each named profile a private native DSH catalog. On start it writes a `--patch` overlay at `.artifacts/control/profiles/<profile>/dsh-home.yml` and points `session-persistence-jsonl` and `storage-json` at `$DSH_HOME/profiles/<profile>/runtime/sessions` and `$DSH_HOME/profiles/<profile>/runtime/storages`. Profiles may share credentials and global DSH configuration, but they must not share these two roots: DSH's Session and Workspace stores have process-local in-memory registries, and two running peers writing one catalog can overwrite each other's records. The generated overlay is machine-local runtime configuration; the launcher rewrites it atomically on every new start.

Profiles created before catalog isolation may have histories in the global `$DSH_HOME/sessions` directory. Stop every managed peer before the first isolated start, copy only the Session directories whose recorded working directories are owned by the deployment (including its `work/` directories) into that profile's private `runtime/sessions`, and do not copy the global `workspace.json`. Begin with an empty private storage root; DSH rebuilds Workspace grouping and projection caches from the copied Session headers. Keep the original global stores as the Desktop profile's history and as the migration backup; the launcher never copies or deletes Session data.

For a standalone profile, open the URL printed in the log and choose **Superagent** in the sidebar. For a managed fleet, treat each peer URL as an internal endpoint and use the **Superagent** Fleet view in Desktop.

### Native fleet

The Desktop profile can be a repository-neutral control plane. Install the bundle into that profile first, then merge [control.cordis.patch.yml](../examples/control.cordis.patch.yml) into the existing `$DSH_HOME/profiles/<desktop profile>/cordis.patch.yml`; do not replace that file, because it also contains the operator's providers and machine settings. Its `dsh-superagent` entry runs in `mode: control`, so it mounts the Fleet controller and keeps the shared Superagent panel without starting the repository Runtime, GitHub or Feishu Source plugins, or the Executor Session presets. The controller reads every deployment from `<control stateDir>/fleet.json`; it does not synthesize an embedded repository deployment:

```json
{
  "version": 1,
  "controlScript": "/absolute/path/to/dsh-superagent/scripts/dsh-superagent",
  "logDir": "/absolute/path/to/dsh-superagent/.artifacts",
  "deployments": [
    {
      "id": "inference-support-loop",
      "profile": "superagent-inference-support-loop",
      "repository": "onenexus-team/inference-support-loop",
      "url": "http://127.0.0.1:3082",
      "stateDir": "/Users/me/.dsh/state/superagent-inference-support-loop",
      "workspace": "/Users/me/src/inference-support-loop"
    },
    {
      "id": "sglang",
      "profile": "superagent-sglang",
      "repository": "onenexus-team/sglang",
      "url": "http://127.0.0.1:3083",
      "stateDir": "/Users/me/.dsh/state/superagent-sglang",
      "workspace": "/Users/me/src/sglang-superagent"
    }
  ]
}
```

Use [control.cordis.patch.yml](../examples/control.cordis.patch.yml) as the controller profile override. Each registered repository still uses [profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) and keeps its own profile, port, state, Session catalog, worktree root and role-model overrides. Provider, GitHub and other credentials are shared unless separately provisioned. The controller state is separate from all repository state:

```text
$DSH_HOME/state/superagent-control       controller and fleet registry
$DSH_HOME/state/superagent-inference-support-loop  inference-support-loop
$DSH_HOME/state/superagent-sglang        SGLang
$DSH_HOME/profiles/<profile>/runtime     each peer's native Session catalog and Workspace records
```

The registry is local machine configuration. Paths must be absolute. `workspace` describes the clean local checkout associated with the deployment and is shown by Fleet; the registry neither creates nor validates it nor selects the Ticket execution root. Keep it aligned with the Execution prepare command. Across deployments, reject duplicate or overlapping `stateDir`, `workspace` and execution-root paths; a deployment may use its own `<stateDir>/work`. Fleet does not enforce this, so check the real paths before creating the registry. The panel does not accept a command, repository URL or executable from the browser: lifecycle actions run only the configured control script with a registered profile and loopback URL. Start and stop remain explicit per deployment, and an intentional stop stays stopped. Create and install each DSH profile with the normal deployment procedure before registering it here; the fleet layer does not clone repositories or copy credentials between profiles.

The Fleet controller is a single-operator control plane. Every registered peer's Sessions are exposed to the same Desktop profile and OS user. Register only repositories in one trust boundary; use separate OS users or Desktop environments for different trust domains.

The card title is the repository's exact `owner/name`. Every card is a peer: each has the same Start, Stop, Restart and Manage behavior, subject only to whether the shared fixed control script is executable.

Use the deployment selector beside the **Superagent** title, or **Manage** on a Fleet card, to make a registered deployment the current management context. The Overview, Source, Trigger, Eval, Execution, Prompts and stage settings then read and save through the same-origin Desktop proxy to that deployment's loopback management API. The proxy accepts only a deployment id from this validated registry and an existing management route; the browser cannot supply a target URL. Fleet lifecycle controls always stay local to the Desktop control plane.

The selection does not reload Desktop or rebind the native Session tree. The controller serves one tree containing the Desktop profile's own Sessions and every registered peer's. It aggregates `session/list` and `session/search`, merges every peer's Workspace stream and Session-control projections, and fans Remote events to Desktop. Session, Workspace and event ids carry their deployment, so a scoped read, mutation, approval result, terminal or live follow is routed to the owning peer. Mixed-owner and unknown-owner requests are refused before any peer is contacted; a failed peer does not hide results already available from another. Deployment Workspace and Session titles are prefixed with `owner/repository ·` so equal titles remain attributable in the aggregate tree; the Desktop profile's own titles are unprefixed.

The Desktop profile is the owner of everything a person does in Desktop. Unscoped operations, such as creating a Session, reading the mode menu or settings, and file and attachment traffic, run in the Desktop profile, with its own plugins, modes and skills. A Superagent deployment owns only the Sessions its Runtime creates for Tickets and its main Session; Desktop reaches them by their deployment-scoped ids. Global events, such as settings updates, come only from the Desktop profile. A Desktop Session is therefore never a Superagent Session, even when it appears in the same tree, and an offline deployment affects only requests that name its Sessions.

The controller also stores the selected deployment in `<control stateDir>/native-deployment.json`. That value is the context for the Superagent management pages; it does not choose where Desktop work runs and is not a global native-catalog filter. Changing it therefore leaves open Sessions and both peer workers running, and a turn appended by either deployment process reaches its open Desktop Session without polling a JSONL file or reloading the page. The renderer never receives a peer cookie, process token or arbitrary proxy URL. Each peer keeps a private physical catalog under its profile runtime directory even though Desktop presents their Sessions together.

Each peer's loopback URL is an internal management endpoint behind the Desktop controller, not a second operator interface. Use the Desktop deployment selector and Fleet cards for every peer; Fleet neither opens nor directs the operator to the peer Web UI. Each profile keeps its own settings, drafts, model catalog and state. Machine limits shown under Deployment settings are read-only because they belong to the selected repository profile; change those limits in that profile's DSH configuration. Select a running deployment from Fleet before opening its management views. Restarting or stopping either repository leaves the Desktop controller running.

### Hourly check

Create one hourly check per deployment in the DeepSeek Harness profile you normally use, not in the managed profile. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path, profile and URL filled in:

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile <profile> --url <url> status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile <profile> --url <url> --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-<profile>-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** Set the GitHub repository (`owner/name`) and agent CLI, for example `/home/me/.local/bin/gh-agent`. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages. Every running deployment must use disjoint chats and direct-message scopes. With one shared bot identity, enable direct messages for at most one deployment, and set `otherChats: mentions` for at most one deployment; use separate bots for separate direct-message or catch-all scopes. Deduplication is profile-local, so overlapping scopes can process the same message more than once.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub accounts and Feishu users who may ask for work; until a list has someone, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** The directory root and a prepare command. To give each Ticket a checkout of the repository:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   List personal CLIs, such as one signed in to your own account, as blocked commands.
4. **Prompts.** Set the team sections: the GitHub disclosure line, review bots, the commit author and the auto-merge condition.

### Management API

The panel uses a local HTTP API that agents and the service script can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

The panel's browser requests use the signed DSH web session. Machine callers send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1` and `x-dsh-superagent-native` containing the contents of `<stateDir>/native-proxy-token`. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing credentials, a missing marker or an `Origin` from another site receive 401 or 403. The deployment creates the token; callers must read it, not create a replacement.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET settings` | `blocks`: `policy`, `eval` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone` or `channelIgnored` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting dsh-superagent: `restarting: true`. Refused when setup has nothing to fix |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | Reads the prompt configuration: `current`, with its `revision` and `config`, `defaults`, `sections`, the team sections in the order Sessions read them, `skillName`, the pattern of a team skill's name, `builtin`, the names a team skill cannot take, and `skillPrefix`, which Sessions load a skill's name under. Or saves it: the new `revision` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket, as the panel does |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Executor Session event handling; appears after its first failure |
| `github`, `feishu`, `history` | Source polling, events and history recovery |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `source:github`, `source:feishu`: `{"enabled": true, "config": {…}}`. GitHub's config has `repository` and `cli`; `notifications`, which reads the account notification inbox and defaults to `true`; and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI. Set `notifications` to `false` for a fine-grained PAT and enable the repository streams needed by that deployment. Feishu's config has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`.
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, and by `issues`, `pulls`, `comments` or `ci` for GitHub; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `maxWorkers`, `directory`, `prepare` and `blockedCommands`. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing a repository or CLI runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
token=$(tr -d '\n' < "$DSH_HOME/state/superagent/native-proxy-token")
rev=$(curl -s -H 'x-orchestrator-request: 1' -H "x-dsh-superagent-native: $token" $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H "x-dsh-superagent-native: $token" -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup verifies the GitHub repository and the agent's push access, writes the worker environment, and checks that git uses only the agent credentials for github.com. A Feishu setup failure disables only the Feishu Source.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` runs the agent's CLI; `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLI as the github.com credential helper, rewrites GitHub SSH addresses to HTTPS and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN` and `GITHUB_TOKEN` are removed.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), that deployment's Overview should show exactly one Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Feishu, mention the bot in a configured chat. Repeat this check for every repository deployment.

## Upgrade

1. Wait until no Executor is in the middle of a turn in any managed deployment.
2. Gracefully stop every managed deployment with `scripts/dsh-superagent --profile <profile> --url <url> stop`.
3. Quit DeepSeek Harness Desktop.
4. Back up every deployment's `<stateDir>/orchestrator.sqlite`; if present, back up its `-wal` and `-shm` sidecars in the same snapshot.
5. Run `git pull && pnpm install && pnpm build` while those processes are stopped.
6. Start and verify every deployment with `scripts/dsh-superagent --profile <profile> --url <url> start`.
7. Reopen DeepSeek Harness Desktop so the controller loads the rebuilt bundle.

A restart ends running Assignments and starts replacements with recovery notes. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### Agent presets

The worker and router presets move shell commands to the background after 5 seconds. A Session cannot load without its preset. Keep the `dsh-superagent-worker` and `dsh-superagent-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `The GitHub Source names no repository.` | Set the repository, `owner/name`, on the GitHub card |
| `Resource not accessible by personal access token` on GitHub notifications | Turn off **Read the account notification inbox**, enable **Receive new Issues** and **Receive comments**, then retry; fine-grained PATs cannot read the notification inbox |
| `Resource not accessible by personal access token` while polling CI | Grant the PAT Actions and Commit statuses read-only, then restart the deployment; fine-grained PATs cannot call the Checks API directly |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| `git does not read the github.com credential configuration dsh-superagent writes` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The panel says dsh-superagent is not answering | It is restarting, or did not start because of its configuration; the DeepSeek Harness log names the cause |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Install a DeepSeek Harness version within the `engines.dsh` range |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |
