# 009 Cloud fleet

> **Status: implemented; acceptance is in progress for the second identity.** GitHub device sign-in, organization admission, the per-person server registry, self-service onboarding, credential setup, authenticated deployment management and native Session forwarding, server installation files, and the Fleet-controller integration are implemented. The two current repository deployments have passed Mac-off execution, full-Droplet recovery, open-history recovery, and mid-Ticket reboot tests. A second organization identity has passed account admission and isolation checks and now has a private repository-scoped deployment; its remaining acceptance gates are worktree preparation, fine-grained-token polling, reboot recovery, and full Desktop/history verification. A canonical DNS cutover, a durable operator-alert channel, and per-repository token separation remain deployment work.

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
- `hdt98` completed GitHub device authorization, received the isolated `dsh-hdt98` Linux user, saw only an empty personal fleet, received `404` for `sonle5`'s deployment, and could not read `sonle5`'s home directory.

The verified external endpoint is currently `https://dsh-superagent.201-79-39-167.sslip.io`; it is intentionally temporary until the canonical hostname is available. The reserved IPv4 remains assigned in DigitalOcean, but the current provider/network path does not complete an external TCP connection on that address. Use the verified `sslip.io` endpoint until the canonical DNS and provider routing check are complete.

`hdt98` is a second organization identity controlled by the same operator. This validates multi-account admission, repository-scoped credentials, and deployment isolation, but not independent teammate adoption. Its private `hdt98/dsh-superagent-onboarding-smoke` deployment is configured with its own fine-grained PAT and OpenAI provider; the remaining acceptance checks are in progress.

## What runs

```text
Operator's computer (optional)        Server: one HTTPS address
Desktop                               Gateway (always on)
 ├─ local Sessions                     ├─ sign-in
 └─ Fleet controller ── HTTPS ──────▶  ├─ each person's deployment list
    signs in; no fleet file            └─ forwards by deployment id ─▶ deployments ─▶ GitHub
                                      privileged helper: Linux users, units, token copies
                                      one Linux user per person: deployments, credentials, worktrees
                                      systemd: start at boot, restart on failure, health check
```

- **Deployment.** Unchanged in shape: one `mode: repository` profile per repository, bound to loopback.
- **Gateway.** New. It is the only listener reachable from outside the server. It signs people in, keeps each person's deployment list, and forwards management and native Session requests to the deployment they name.
- **Fleet controller.** The existing `mode: control` plugin in Desktop. It signs in to one gateway address and reads its fleet from the gateway. A local `fleet.json` keeps working for deployments on the operator's own computer.
- **Onboarding helper.** New. The unprivileged gateway calls one fixed root helper through `sudo`. It creates one Linux user for each person and one DSH profile, environment file, systemd unit, state directory, worktree root and token directory for each deployment.
- **systemd.** Starts the gateway and every deployment at boot and restarts them on failure. A timer runs the `status` check of `scripts/dsh-superagent` and restarts a deployment that exits 1.

Desktop stores no Superagent state for server deployments. It loads a snapshot and then follows events while it is open, as it does for local deployments.

## Trust boundaries

- **One Linux user per person.** It owns that person's deployments, agent GitHub login, model credentials and worktrees. Permissions and isolation in 006 Deployment still apply inside one user: workers run with `danger-full-access` as that user.
- **Loopback is shared by every Linux user on the server.** Each deployment's management API admits the signed DSH panel session or its own native capability. The deployment creates `native-proxy-token`; the controller and service script only read it, and native Session routing uses the same credential. This closes the path where one local worker could call another person's deployment by sending only the request marker.
- **Deployment tokens stay on the server.** Desktop holds only its gateway session.
- **The controller's gateway state is local to the controller profile.** Before sign-in, `<control stateDir>/gateway.json` contains only the gateway URL. After sign-in it also contains the gateway's opaque session token; it never contains the GitHub access token.
- **The gateway is unprivileged.** Creating Linux users and services belongs to a separate privileged helper that offers a fixed set of operations.
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

Grant the PAT Contents, Issues and Pull requests read/write plus Metadata read. GitHub does not expose the account notification inbox to fine-grained PATs, so set the GitHub Source's **Read the account notification inbox** off and enable **Receive new Issues** and **Receive comments**. Repository polling then uses only the least-privilege repository permissions; do not replace the PAT with an over-broad classic token merely to make notification polling succeed.

Token-based agent credentials are still reachable by that person's worker because the worker runs as that Linux user. That is the intended agent-account boundary, not an isolation boundary against prompt injection; use a dedicated agent GitHub account with least-privilege access.

## Address

The fleet has one address. A server can start on its IP address with a short-lived certificate and move to a hostname later. That move changes configuration only: the gateway's address on the server and in Desktop.

## Moving a local fleet

- Stop the local deployments first. Two running copies would both poll GitHub as the same account.
- State contains absolute paths: the database, Session files and git worktrees. Keep the same absolute paths on the server.
- Credentials held in an operating-system keychain do not move. Create them again on the server.

## Not in this version

- Start, Stop, Restart and the log tail for server deployments. Pausing processing still works from Desktop.
- Alerts when a deployment needs a person.
- Changes to DeepSeek Harness or Desktop themselves.
- Isolated workers per Ticket.

## Open decisions

None. The Linux Droplet, TLS certificate issuance/renewal and Mac-off acceptance test remain operational validation work rather than design decisions.
