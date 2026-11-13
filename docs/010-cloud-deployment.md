# 010 Cloud deployment

This guide installs a self-service cloud fleet on a Linux server. The gateway uses one HTTPS address, and each person who onboards from Desktop receives one Linux user, profile and systemd deployment.

## 1. Create the Droplet

Use a General Purpose Droplet with at least 2 dedicated vCPUs and 8 GB RAM. Attach a 50 GB volume for `/var/lib/dsh-superagent`, enable weekly backups, and reserve a public IP. The examples assume Ubuntu or another Linux distribution with systemd.

SSH in, add a non-root gateway user, and install Node.js 22.19+ or 24, pnpm, Python 3.8+, tmux, git, `gh`, `sudo`, and the `dsh` command.
Install `gh` from GitHub's official package repository and verify `gh --version` reports 2.48 or later; the version packaged by older Ubuntu releases cannot read paginated API responses as DSH requires.

```sh
sudo mkdir -p /opt/dsh-superagent /etc/dsh-superagent /var/lib/dsh-superagent/gateway
sudo chown -R <gateway-user>:<gateway-group> /var/lib/dsh-superagent/gateway
git clone <this-repository> /opt/dsh-superagent
cd /opt/dsh-superagent
pnpm install && pnpm build
dsh --version
```

`/opt/dsh-superagent` may be owned by an administrator and readable by the gateway user. The gateway never writes to the checkout; the onboarding helper and generated services only read it and run its fixed scripts.

`dsh` must be on the path named by the gateway unit, for example `/usr/local/bin/dsh`.

## 2. Configure the gateway

Create a GitHub OAuth app with device flow enabled. It needs no client secret on the server. Request only the `read:org` scope.

Merge [examples/cloud/gateway.cordis.patch.yml](../examples/cloud/gateway.cordis.patch.yml) into the gateway profile's `cordis.patch.yml`, then set the concrete server address, certificate paths, profile name, and gateway state directory. DSH supports TLS directly, but it does not redirect HTTP or renew certificates. Use a certificate valid for the address the Desktop client will use.

For Let's Encrypt, select the certificate source in `/etc/dsh-superagent/tls.env`, then install the renewal hook so a renewed certificate is copied into the gateway’s TLS directory and the gateway restarts:

```sh
sudo install -o root -g root -m 0600 \
  /opt/dsh-superagent/examples/cloud/letsencrypt/tls.env.example \
  /etc/dsh-superagent/tls.env
# Edit /etc/dsh-superagent/tls.env and replace the placeholders.
sudo install -o root -g root -m 0755 \
  /opt/dsh-superagent/examples/cloud/letsencrypt/reload-gateway.sh \
  /etc/letsencrypt/renewal-hooks/deploy/dsh-superagent-gateway
```

Verify renewal, including the hook, with:

```sh
sudo certbot renew --dry-run --no-random-sleep-on-renew
```

Copy [examples/cloud/gateway.env.example](../examples/cloud/gateway.env.example) to `/etc/dsh-superagent/gateway.env`, and install the certificate and key under `/etc/dsh-superagent/tls/` so the fleet user can read them but other users cannot.

Install the bundle into the gateway profile:

```sh
DSH_HOME=/var/lib/dsh-superagent/dsh-home \
  dsh plugin --profile superagent-gateway add "link:/opt/dsh-superagent"
```

Create `/var/lib/dsh-superagent/gateway/gateway.json` from [examples/cloud/registry.example.json](../examples/cloud/registry.example.json). The `url`, `stateDir`, and `workspace` values must be absolute server paths. Each repository deployment is bound to loopback; the gateway is the only public listener.

For a fresh self-service fleet, use an empty `deployments` list and fill in `people`/`onboarding` only. A shared entry in `deployments` is a migration record and must name `ownerLogin`; it is visible only to that GitHub login.

## 3. Install the fixed privileged helper

The helper is a fixed Python program, not a generic shell entry point:

```sh
sudo chown root:root /opt/dsh-superagent/scripts/dsh-superagent-onboard
sudo chmod 0755 /opt/dsh-superagent/scripts/dsh-superagent-onboard
```

Allow only the gateway user to run exactly that file as root:

```text
<gateway-user> ALL=(root) NOPASSWD: /opt/dsh-superagent/scripts/dsh-superagent-onboard
```

The helper accepts only six JSON operations on standard input: `person`, `deployment`, `credentials`, `status`, `lifecycle`, and `logs`. It never accepts a shell command, profile name from the request, arbitrary path, unit name, or model credential. It creates `dsh-<github-login>`, derives a safe Linux username when GitHub’s login is long, creates that person’s directories, initializes the deployment profile from DSH's shipped `web` template, installs the Superagent bundle, writes a root-owned environment file, enables a per-person unit, waits for the deployment native token, and copies that token into a gateway-readable directory owned by the gateway user.

The generated unit name is:

```text
dsh-superagent-person-<github-login>-<deployment-id>.service
```

The helper starts and enables it directly. Do not enable a generic `dsh-superagent@` unit for a self-service deployment.
The generated unit treats launcher statuses 2 and 3 as successful startup because the process is running and waiting for operator action; those component/setup states remain visible through health checks.

The same sudoers rule also supplies deployment-scoped lifecycle control and bounded logs. For those requests the helper derives the unit name from the already validated GitHub login and deployment id; the gateway never sends a unit name. `status` runs `systemctl is-active`, `lifecycle` accepts only `start`, `stop`, or `restart`, and `logs` accepts 1–80 lines from that unit's journal. The helper has no generic shell or arbitrary `systemctl` entry point.

## 4. Onboard from Desktop

Start Desktop with the controller profile, then use the Cloud Fleet card:

1. Sign in with GitHub device flow.
2. Select **Create my cloud account**. This creates the person entry and Linux user.
3. Enter a lowercase deployment id and `owner/repository`, then create the deployment. The gateway calls the fixed helper and returns only non-secret metadata.
4. Paste that deployment agent GitHub account’s PAT into **Configure agent credentials**. The helper writes a `0700` `gh` wrapper owned by that person and saves it in the GitHub Source. The PAT is not written to the gateway registry or returned by the API. Grant Contents, Issues and Pull requests read/write plus Metadata read, turn off **Read the account notification inbox**, and enable repository Issue/comment polling; fine-grained PATs cannot read the notification inbox.
5. Configure model credentials through the connected deployment’s normal DSH provider settings. They stay under that person’s Linux user and profile.

The generated deployment card also exposes Start, Stop, Restart, and a journal tail. These calls remain HTTPS requests to the same gateway. The gateway checks ownership, rejects overlapping lifecycle actions for that deployment with HTTP `409`, and writes attempt/result records to `/var/lib/dsh-superagent/gateway/audit.jsonl` with mode `0600`. The journal tail is limited to 80 lines and 64 KiB and redacts authorization headers, bearer tokens, API keys, and URL query tokens.

Stopping preserves the deployment database, Session history, repository grouping, model selections, and worktrees. The
launcher gets 300 seconds to finish active-task teardown, systemd allows 330 seconds for that operation, the helper allows
340 seconds, and the gateway allows 350 seconds. These nested limits ensure systemd does not apply its 90-second default or
an outer watchdog does not kill the request before the launcher can finish. A stopped deployment is reported as `stopped`
from its systemd state even though its loopback management API is intentionally unavailable; Start remains available.

The self-service deployment’s state paths are:

```text
/var/lib/dsh-superagent/people/<login>/deployments/<deployment-id>
/var/lib/dsh-superagent/people/<login>/worktrees/<deployment-id>
/var/lib/dsh-superagent/people/<login>/artifacts
/var/lib/dsh-superagent/gateway/tokens/<deployment-id>
```

The gateway can read the copied native token but cannot read the person’s home state or OS keychain.

## 5. Optional: migrate an existing deployment

The generic units and this section are for one-time migration of an existing Mac deployment, not for adding future people or repositories.

For each repository, create a separate DSH profile, state directory, loopback port, and clean checkout or worktree root:

```sh
DSH_HOME=/var/lib/dsh-superagent/dsh-home \
  dsh --profile superagent-<deployment-id> --from-default-profile web --dump-config >/dev/null
DSH_HOME=/var/lib/dsh-superagent/dsh-home \
  dsh plugin --profile superagent-<deployment-id> add "link:/opt/dsh-superagent"
sudo -u <fleet-user> mkdir -p \
  /var/lib/dsh-superagent/deployments/<deployment-id> \
  /var/lib/dsh-superagent/worktrees/<deployment-id>
```

Merge [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) into that profile. Keep its `webserver.host` on `127.0.0.1`, choose a unique port, and set the `stateDir` to the deployment directory. Configure the model provider, agent GitHub CLI, repository, policy, and execution prepare command through the profile's normal setup flow or documented settings API.

Copy [examples/cloud/deployment.env.example](../examples/cloud/deployment.env.example) to `/etc/dsh-superagent/deployments/<deployment-id>.env` with the same values used in the gateway registry.

Put that deployment in the gateway registry’s `deployments` list and set `ownerLogin` to the GitHub login of its operator. Without `ownerLogin`, it is hidden from every signed-in person.

## 6. Install systemd supervision for the gateway and a migrated deployment

Copy the four unit files from `examples/cloud/systemd/` to `/etc/systemd/system/`, replacing `<fleet-user>` and `<fleet-group>` in each file.
Keep the gateway unit's `StandardOutput=null` and `StandardError=journal`: DSH prints its one-time web login URL to standard output, so journaling standard output would expose the login token to every user who can read the journal.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-superagent-gateway.service
sudo systemctl enable --now dsh-superagent@<deployment-id>.service
sudo systemctl enable --now dsh-superagent-health@<deployment-id>.timer
```

The deployment unit starts the existing `scripts/dsh-superagent` launcher, which starts `dsh --profile ... --no-open` in tmux and records the process. The health timer runs every five minutes. `scripts/dsh-superagent-recover` calls the launcher again only when status exits 1; intentional stops and setup/component errors are not restarted automatically. The health unit records those operator-action failures, while the recovery unit exits successfully because declining an unsafe restart is its expected outcome.

Self-service deployments use the helper-generated per-person unit and health units, not `dsh-superagent@`.

Gateway logs are available with:

```sh
journalctl -u dsh-superagent-gateway.service -f
```

## 7. Connect Desktop

On the operator's Mac, create the controller profile from [examples/control.cordis.patch.yml](../examples/control.cordis.patch.yml), and write only the gateway address into its `<stateDir>/gateway.json`:

```json
{
  "version": 1,
  "url": "https://<gateway-address>"
}
```

Start Desktop, use the Superagent Fleet controller, and complete GitHub device sign-in. Desktop stores only the resulting gateway session token locally. It never stores the GitHub OAuth token or a deployment native token.

The acceptance test is:

1. Comment on a GitHub Issue or pull request in the deployment repository.
2. Quit Desktop and shut the Mac.
3. Wait for a new Ticket, worker Session, or GitHub reply from the server.
4. Reboot the Droplet, then confirm the deployment unit, health timer, and gateway return to service.

Also repeat the Droplet reboot while a Ticket is mid-turn and while its Session history is open in Desktop. The turn must finish and publish once, the history must reconnect without a red load failure, the Session must remain grouped under its repository, and the configured Eval and Executor models must remain unchanged.

Check each deployment’s management health directly from the server:

```sh
sudo systemctl start dsh-superagent-<deployment-health-unit>.service
sudo journalctl -u dsh-superagent-<deployment-health-unit>.service -n 80 --no-pager
sudo systemctl is-active dsh-superagent-<deployment-health-timer>.timer
```

The status output must report `runtime`, `relay`, `github`, `models`, `evals`, `delivery`, and `reply` as `ready`, with an empty `errors` object. The timer must be `active`.

### Acceptance record

The current single-operator fleet was accepted against commit `3721da1f7ffa0b863dfc5fe6c271dc9011ffc2b1` on 2026-11-12:

- Both repository deployments ran while the Mac-local deployment was stopped.
- A GitHub Issue trigger published exactly one acknowledgement and one final reply.
- A reboot during an active Ticket recovered the turn and published the final reply once.
- A reboot with Session history open restored the stream without a red load error and preserved repository grouping.
- Each deployment had a distinct systemd cgroup and tmux server (`dsh-superagent-0f7069013d78a64a` and `dsh-superagent-6f95e55831dcd2ba`).
- Eval and Executor settings survived restart: `one-nexus / glm-5.3-sontinh` and `claude / claude-opus-5-5(auto)`. A real worker turn also succeeded through `nexus13 / nexus13/claude-opus-5-5(auto)` before the Executor was restored to Claude.
- Both health timers stayed active and every health component returned `ready` with no errors.
- A forced certificate renewal and `certbot renew --dry-run --no-random-sleep-on-renew` both succeeded.
- A second organization identity, `hdt98`, completed normal device sign-in and account provisioning as `dsh-hdt98`. Desktop showed only its deployment, access to `sonle5`'s deployments returned `404`, and the `sonle5` home directory was unreadable to it.
- The `hdt98` deployment used a clean detached worktree, became ready with repository polling, and completed a mid-Ticket Droplet-reboot test with exactly one acknowledgement and one final reply.
- The `hdt98` persisted Session selected Eval `openai / gpt-6.1-terra` and Executor `openai / gpt-6.1-sol`, and the same values remained after reboot.
- `sonle5` now uses separate repository-scoped fine-grained PATs for `inference-support-loop` and `sglang`. Each wrapper authenticates as `sonle5`, can read only its configured repository, and receives `404` for the other repository. All three deployment wrapper hashes are distinct.
- All three deployments report every health component as `ready`, with no component errors, and the public gateway rejects unauthenticated fleet requests with HTTP `401`.

The current verified public endpoint is `https://dsh-superagent.201-79-39-167.sslip.io`. The reserved address and canonical organization hostname remain pending because external TCP routing on the reserved address and Cloudflare access are not available yet.

The `hdt98` account now has its own private `hdt98/dsh-superagent-onboarding-smoke` deployment, fine-grained repository PAT, and OpenAI provider. Its prepared-worktree, polling, reboot, model-attestation, normal sign-in, Session-history, and blast-radius checks have passed. The account-onboarding test also exposed a partial-provisioning recovery bug. Existing Linux users are now required to have their directories and `0700` home permission repaired before onboarding returns successfully, with regression coverage in `tests/onboarding-helper.spec.ts`.

Remote lifecycle and log controls were accepted on 2026-11-13 against commit `2d472b5402cbbe55e37153c787df703b629a3f7a`:

- Desktop Restart completed in about five seconds and returned `active`.
- Desktop Stop changed the card to `Stopped intentionally` and the service to `inactive`; the bounded journal remained visible.
- Desktop Start returned the service to `active`, and all ten management-health components returned to `ready`.
- The deployment had no active Ticket during these checks, so the 300-second graceful in-flight teardown path remains covered by automated tests rather than a destructive live run.
- The hdt98 Session ID, Eval `openai / gpt-6.1-terra / high`, Executor `openai / gpt-6.1-sol / xhigh`, and recent history remained unchanged.
- The live gateway returned `401` unauthenticated, `404` for another person's deployment, `400` for an invalid action, and `409` for an overlapping action. Audit records were mode `0600` and contained no credentials or command environment.
- `pnpm check` passed with 71 test files, 1,328 tests, and the production build. The Fleet-page regression also verifies that an intentional selected-deployment poll failure does not produce a redundant global error banner.

## Migration and upgrades

- Stop the Mac-local deployment before starting its server copy; two running deployments polling one GitHub account duplicate work.
- Copy each deployment's database, lock files, Session catalog, worktrees, and `native-proxy-token` while it is stopped, keeping absolute paths unchanged.
- Recreate model credentials through the connected deployment’s DSH settings. For agent GitHub credentials, use the Desktop Cloud Fleet credential form; OS keychain credentials do not migrate.
- Before upgrading, stop the deployment unit, snapshot `/var/lib/dsh-superagent`, pull this repository, run `pnpm install && pnpm build`, and restart the gateway and deployments.
