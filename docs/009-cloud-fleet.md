# 009 Cloud fleet

> **Status: design.** Nothing in this document is implemented yet. It describes the target of the cloud fleet work and is updated as parts land.

This document describes a fleet that runs on one always-on Linux server shared by several people, with DeepSeek Harness Desktop as an optional client. It builds on [006 Deployment](006-deployment.md) and [007 Architecture](007-architecture.md).

## Goals

- Deployments keep working while every operator's computer is off.
- Desktop stays the single operator interface and shows local Sessions and server deployments together.
- A person or a deployment is added from Desktop, without shell access to the server.
- One HTTPS address serves the whole fleet, however many deployments it holds.

## What runs

```text
Operator's computer (optional)        Server: one HTTPS address
Desktop                               Gateway (always on)
 ├─ local Sessions                     ├─ sign-in
 └─ Fleet controller ── HTTPS ──────▶  ├─ each person's deployment list
    signs in; no fleet file            └─ forwards by deployment id ─▶ deployments ─▶ GitHub
                                      one Linux user per person: deployments, credentials, worktrees
                                      systemd: start at boot, restart on failure, health check
```

- **Deployment.** Unchanged in shape: one `mode: repository` profile per repository, bound to loopback.
- **Gateway.** New. It is the only listener reachable from outside the server. It signs people in, keeps each person's deployment list, and forwards management and native Session requests to the deployment they name.
- **Fleet controller.** The existing `mode: control` plugin in Desktop. It signs in to one gateway address and reads its fleet from the gateway. A local `fleet.json` keeps working for deployments on the operator's own computer.
- **systemd.** Starts the gateway and every deployment at boot and restarts them on failure. A timer runs the `status` check of `scripts/dsh-superagent` and restarts a deployment that exits 1.

Desktop stores no Superagent state for server deployments. It loads a snapshot and then follows events while it is open, as it does for local deployments.

## Trust boundaries

- **One Linux user per person.** It owns that person's deployments, agent GitHub login, model credentials and worktrees. Permissions and isolation in 006 Deployment still apply inside one user: workers run with `danger-full-access` as that user.
- **Loopback is shared by every Linux user on the server.** The management API currently accepts any local request that carries the `x-orchestrator-request` header, so one person's worker could call another person's deployment. On a shared server each deployment must require a credential on its management API, as native Session routing already does.
- **Deployment tokens stay on the server.** Desktop holds only its gateway session.
- **The gateway is unprivileged.** Creating Linux users and services belongs to a separate privileged helper that offers a fixed set of operations.

## Sign-in

The gateway uses GitHub device sign-in and runs it itself. Desktop shows a code, the person enters it at GitHub, and the gateway receives the result directly from GitHub. It checks membership of the configured organization, then issues its own session to Desktop. No GitHub token is stored on the operator's computer.

This needs one OAuth app with device flow enabled. It requests read access to organization membership and nothing else.

## People and deployments

- The first sign-in creates the person's Linux user.
- Adding a deployment creates its profile and service and starts it.
- A repository has one deployment. Two deployments for one repository would both answer on GitHub, so people who share a repository share its deployment.
- Each person brings an agent GitHub account and model credentials. A shared agent account exposes the union of its access to every worker that can use it.

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

- How the gateway reads deployment tokens that belong to other Linux users.
- Whether the agent GitHub login and model credentials can be entered from Desktop, without a shell.
- How a request names its deployment. The controller builds absolute paths from a deployment address in several places, so a header fits the current code better than a path prefix.
