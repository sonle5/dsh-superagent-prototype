# 009 Cloud fleet

> **Status: implemented and accepted for the current single-operator fleet.** GitHub device sign-in, organization admission, the per-person server registry, self-service onboarding, repository-scoped credential setup, authenticated deployment management, native Session forwarding, remote lifecycle/log controls, server installation files, and the Fleet-controller integration are implemented. The current repository deployments, the second identity, credential separation, code writing through a disposable repository, Desktop/history recovery, and mid-Ticket reboot and Stop/Start recovery have all passed their acceptance gates. Canonical DNS, durable operator alerts, and kernel-enforced read-only worker execution remain deployment limitations rather than unverified implementation work.

This document describes a fleet that runs on one always-on Linux server shared by several people, with DeepSeek Harness Desktop as an optional client. It builds on [006 Deployment](006-deployment.md) and [007 Architecture](007-architecture.md).

## Goals

- Deployments keep working while every operator's computer is off.
- Desktop stays the single operator interface and shows local Sessions and server deployments together.
- A person or a deployment is added from Desktop, without shell access to the server.
- One HTTPS address serves the whole fleet, however many deployments it holds.

## Current acceptance record

The `onenexus-team/inference-support-loop` and `onenexus-team/sglang` deployments run as separate DSH profiles on one Ubuntu 24.04 Droplet. On 2026-11-12 they passed:

- A real GitHub Issue run with Desktop and the Mac-local deployment stopped; the worker published one acknowledgement and one final reply.
- A Droplet reboot during an active Ticket, followed by the final reply once after recovery.
- A Droplet reboot with Session history open, followed by reconnection without the stale red load failure and with Inbox grouping preserved.
- Independent tmux servers and systemd cgroups, so restarting or stopping one deployment does not move or stop the other.
- Eval `one-nexus / glm-5.3-sontinh` and Executor `claude / claude-opus-5-5(auto)` on both deployments, including an actual worker turn through the configured `nexus13 / nexus13/claude-opus-5-5(auto)` route during route-acceptance testing.
- Certificate renewal, gateway recovery, both health timers, and every health component returning `ready` with no errors after reboot.
- `hdt98` completed normal GitHub device sign-in, received the isolated `dsh-hdt98` Linux user, and sees only its own deployment in Desktop.
- The `hdt98` deployment prepared and used a clean detached worktree, completed repository polling without the unsupported notification-inbox API, and recovered after a mid-Ticket Droplet reboot.
- The rebooted `hdt98` Ticket completed with exactly one acknowledgement and one final reply, and its persisted Session recorded Eval `openai / gpt-6.1-terra` and Executor `openai / gpt-6.1-sol`.
- A normal operator comment on `hdt98/dsh-superagent-onboarding-smoke#5` ran a code-writing Ticket from start to review. The agent changed only the two requested files, passed three `unittest` cases, committed as `hdt98`, pushed one branch, opened one mergeable PR, and returned one final result to the source Issue. PR #6 contains one commit and no approval or merge.
- A Desktop lifecycle Stop interrupted that Ticket after its first Assignment had reported progress. The stop completed in two seconds with systemd `Result=success` and no timeout; Start restarted the service, created a second Assignment with the recovery note, and the worker reconciled the existing branch, commit and PR without duplicating them. The source Issue and PR stayed grouped under the same Ticket, exactly one final result was posted, and the persisted Session retained Eval `openai / gpt-6.1-terra / high` and Executor `openai / gpt-6.1-sol / xhigh`. The Ticket then waited for human review rather than failing or repeating the external side effects.
- The `sonle5` deployments now use separate repository-scoped PATs. Their wrapper hashes differ from each other and from `hdt98`; each wrapper authenticates as `sonle5`, resolves only its named repository, and receives `404` for the other repository.
- All three deployment health checks report `runtime`, `relay`, `notice`, `launch`, `delivery`, `assessment`, `reply`, `evals`, `models`, and `github` as `ready`, with an empty `errors` object.
- Remote lifecycle and log controls were exercised from DeepSeek Harness Desktop against `hdt98/dsh-superagent-onboarding-smoke`. Restart returned `active`; Stop produced `Stopped intentionally` and `inactive`; Start returned all ten health components to `ready`. The bounded journal remained available while stopped, and the Fleet page did not show the redundant global `Deployment unavailable: fetch failed` error during intentional transitions.
- The live gateway returned `401` without a session, `404` for a cross-person deployment, `400` for an invalid lifecycle action, and `409` for an overlapping lifecycle action. The lifecycle audit remained mode `0600` and contained no command environment or credentials.

The verified external endpoint is currently `https://dsh-superagent.201-79-39-167.sslip.io`; it is intentionally temporary until the canonical hostname is available. The reserved IPv4 remains assigned in DigitalOcean, but the current provider/network path does not complete an external TCP connection on that address. Use the verified `sslip.io` endpoint until the canonical DNS and provider routing check are complete.

`hdt98` is a second organization identity controlled by the same operator. This validates multi-account admission, repository-scoped credentials, Desktop fleet and Session history behavior, reboot recovery, and deployment isolation, but not independent teammate adoption. Its private `hdt98/dsh-superagent-onboarding-smoke` deployment is configured with its own fine-grained PAT and OpenAI provider.

## What runs

```text
Operator's computer (optional)        Server: one HTTPS address
Desktop                               Gateway (always on)
 ├─ local Sessions                     ├─ sign-in
 └─ Fleet controller ── HTTPS ──────▶  ├─ each person's deployment list
    signs in; no fleet file            ├─ forwards by deployment id ─▶ deployments ─▶ GitHub
                                       └─ deployment-scoped control/log routes
                                      privileged helper: Linux users, units, token copies, service control
                                      one Linux user per person: deployments, credentials, worktrees
                                      systemd: start at boot, restart on failure, health check
```

- **Deployment.** Unchanged in shape: one `mode: repository` profile per repository, bound to loopback.
- **Gateway.** New. It is the only listener reachable from outside the server. It signs people in, keeps each person's deployment list, and forwards management and native Session requests to the deployment they name.
- **Fleet controller.** The existing `mode: control` plugin in Desktop. It signs in to one gateway address and reads its fleet from the gateway. A local `fleet.json` keeps working for deployments on the operator's own computer.
- **Privileged helper.** New. The unprivileged gateway calls one fixed root helper through `sudo`. It creates one Linux user for each person and one DSH profile, environment file, systemd unit, state directory, worktree root and token directory for each deployment. The same helper exposes only derived-unit `status`, `start`, `stop`, `restart`, and bounded journal reads; callers cannot supply a unit name or command.
- **systemd.** Starts the gateway and every deployment at boot and restarts them on failure. A timer runs the `status` check of `scripts/dsh-superagent` and restarts a deployment that exits 1.

Desktop stores no Superagent state for server deployments. It loads a snapshot and then follows events while it is open, as it does for local deployments.

## Trust boundaries

- **One Linux user per person.** It owns that person's deployments, agent GitHub login, model credentials and worktrees. Permissions and isolation in 006 Deployment still apply inside one user: workers run with `danger-full-access` as that user.
- **Loopback is shared by every Linux user on the server.** Each deployment's management API admits the signed DSH panel session or its own native capability. The deployment creates `native-proxy-token`; the controller and service script only read it, and native Session routing uses the same credential. This closes the path where one local worker could call another person's deployment by sending only the request marker.
- **Deployment tokens stay on the server.** Desktop holds only its gateway session.
- **The controller's gateway state is local to the controller profile.** Before sign-in, `<control stateDir>/gateway.json` contains only the gateway URL. After sign-in it also contains the gateway's opaque session token; it never contains the GitHub access token.
- **The gateway is unprivileged.** Creating Linux users and services belongs to a separate privileged helper that offers a fixed set of operations.
- **Remote controls are deployment-scoped.** The gateway derives the systemd unit from the authenticated GitHub login and deployment id, serializes lifecycle actions per deployment, and writes attempt/result records to a `0600` audit log. It does not grant Desktop root or generic `systemctl` access.
- **Remote logs are bounded.** Log responses contain at most 80 journal lines and 64 KiB, and both the gateway and controller redact token-like values and authorization headers.
- **Legacy shared deployments are owner-scoped.** An entry in `deployments` is visible only to the `ownerLogin` named on it. New self-service deployments live under `people` and are visible only to that person.
- **Self-service GitHub credentials use one fixed operation.** Desktop sends the agent GitHub PAT to the gateway once. The gateway passes it to the helper, which writes a `0700` wrapper owned by that person’s Linux user and updates the deployment’s GitHub Source. The token is not stored in the registry, returned by the API or committed.

## Sign-in

The gateway uses GitHub device sign-in and runs it itself. Desktop shows a code, the person enters it at GitHub, and the gateway receives the result directly from GitHub. It checks membership of the configured organization, then issues its own session to Desktop. No GitHub token is stored on the operator's computer.

This needs one OAuth app with device flow enabled. It requests read access to organization membership and nothing else.

### Controller state

The Fleet controller's `<stateDir>/gateway.json` is different from the gateway's server-local registry:

```json
{
  "version": 1,
  "url": "https://<gateway-address>"
}
```

`POST /orchestrator/api/gateway/device` starts the gateway's device flow. After the person finishes it at GitHub, `POST /orchestrator/api/gateway/session` stores the gateway token locally. The controller then reads `/gateway/api/fleet` and merges those deployments with its local `fleet.json`. Management requests use `<gateway>/gateway/api/deployment/<id>/<route>` and native Session requests use `<gateway>/gateway/native/<id>/…`; the deployment native tokens stay on the server.

## People and deployments

- `Create my cloud account` creates the person's Linux user and registry entry.
- Adding a deployment creates its profile and service and starts it.
- A repository has one deployment. Two deployments for one repository would both answer on GitHub, so people who share a repository share its deployment.

### Credentials

Each person brings an agent GitHub account and model credentials.

1. Create a fine-grained agent GitHub PAT with only the repository access that deployment needs.
2. In Desktop, sign in to Cloud Fleet, create the cloud account and deployment, then paste the PAT into **Configure agent credentials**. The helper writes a per-deployment `gh` wrapper and saves that wrapper in the GitHub Source; it never stores the PAT in the gateway registry.
3. Configure model providers through the connected deployment's normal DSH provider settings. Those credentials belong to that person's Linux user and profile, not to the gateway.

Grant the PAT Contents, Issues and Pull requests read/write; Actions and Commit statuses read-only; and Metadata read. GitHub does not expose the account notification inbox or the Checks API to fine-grained PATs, so set the GitHub Source's **Read the account notification inbox** off and enable **Receive new Issues** and **Receive comments**. DSH reads check runs when the token supports them and otherwise falls back to repository Actions workflow runs plus Commit statuses. Repository polling therefore remains least-privilege; do not replace the PAT with an over-broad classic token merely to make notification or CI polling succeed.

Token-based agent credentials are still reachable by that person's worker because the worker runs as that Linux user. That is the intended agent-account boundary, not an isolation boundary against prompt injection; use a dedicated agent GitHub account with least-privilege access.

## Address

The fleet has one address. A server can start on its IP address with a short-lived certificate and move to a hostname later. That move changes configuration only: the gateway's address on the server and in Desktop.

## Lifecycle and logs

Generated per-person deployments advertise `lifecycle` and `logs` capabilities in the gateway fleet response. Desktop shows Start, Stop, Restart, and journal-tail controls only for deployments that advertise the relevant capability. Legacy shared deployments remain visible but do not claim control paths that their generic systemd units do not implement.

- Start and restart first use the deployment management API. If it is unavailable, the controller asks the gateway for the derived systemd state, so an intentionally stopped deployment appears as `stopped` rather than `unreachable`.
- Stop runs `systemctl stop` through the fixed helper. The launcher receives a 300-second graceful-stop budget, systemd allows
  330 seconds for that stop operation, the privileged helper allows 340 seconds for `systemctl`, and the gateway allows 350
  seconds for the helper. Each outer timeout therefore leaves room for the inner operation to finish and report its result.
- Requests for the same deployment are rejected with HTTP `409` while another lifecycle action is running. Actions on different deployments remain independent.
- Lifecycle authorization is checked against the signed-in person before the helper runs. Another person's deployment returns HTTP `404`.
- The gateway appends one attempt and one result record to `<gateway stateDir>/audit.jsonl` with mode `0600`. The log never contains provider credentials, tokens, or command environments.

## Moving a local fleet

- Stop the local deployments first. Two running copies would both poll GitHub as the same account.
- State contains absolute paths: the database, Session files and git worktrees. Keep the same absolute paths on the server.
- Credentials held in an operating-system keychain do not move. Create them again on the server.

## Not in this version

- Alerts when a deployment needs a person.
- Changes to DeepSeek Harness or Desktop themselves.
- Isolated workers per Ticket.

## Open decisions

None. The Linux Droplet, TLS certificate issuance/renewal and Mac-off acceptance test remain operational validation work rather than design decisions.
