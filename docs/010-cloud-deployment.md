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

Merge [examples/cloud/gateway.cordis.patch.yml](../examples/cloud/gateway.cordis.patch.yml) into the gateway profile's `cordis.patch.yml`, then set the concrete server address, certificate paths, profile name, and gateway state directory. DSH supports TLS directly; it does not redirect HTTP and it does not renew certificates. Use a certificate valid for the address the Desktop client will use, and reload the gateway after replacing either PEM file.

Copy [examples/cloud/gateway.env.example](../examples/cloud/gateway.env.example) to `/etc/dsh-superagent/gateway.env`, and install the certificate and key under `/etc/dsh-superagent/tls/` so the fleet user can read them but other users cannot.

Install the bundle into the gateway profile:

```sh
DSH_HOME=/var/lib/dsh-superagent/dsh-home \
  dsh plugin --profile superagent-gateway add "link:/opt/dsh-superagent"
```

Create `/var/lib/dsh-superagent/gateway/gateway.json` from [examples/cloud/registry.example.json](../examples/cloud/registry.example.json). The `url`, `stateDir`, and `workspace` values must be absolute server paths. Each repository deployment is bound to loopback; the gateway is the only public listener.

For a fresh self-service fleet, use an empty `deployments` list and fill in `people`/`onboarding` only. A shared entry in `deployments` is a migration record and must name `ownerLogin`; it is visible only to that GitHub login.

## 3. Install the fixed onboarding helper

The helper is a fixed Python program, not a generic shell entry point:

```sh
sudo chown root:root /opt/dsh-superagent/scripts/dsh-superagent-onboard
sudo chmod 0755 /opt/dsh-superagent/scripts/dsh-superagent-onboard
```

Allow only the gateway user to run exactly that file as root:

```text
<gateway-user> ALL=(root) NOPASSWD: /opt/dsh-superagent/scripts/dsh-superagent-onboard
```

The helper accepts only three JSON operations on standard input: `person`, `deployment` and `credentials`. It never accepts a shell command, profile name from the request, arbitrary path, or model credential. It creates `dsh-<github-login>`, derives a safe Linux username when GitHub’s login is long, creates that person’s directories, initializes the deployment profile from DSH's shipped `web` template, installs the Superagent bundle, writes a root-owned environment file, enables a per-person unit, waits for the deployment native token, and copies that token into a gateway-readable directory owned by the gateway user.

The generated unit name is:

```text
dsh-superagent-person-<github-login>-<deployment-id>.service
```

The helper starts and enables it directly. Do not enable a generic `dsh-superagent@` unit for a self-service deployment.
The generated unit treats launcher statuses 2 and 3 as successful startup because the process is running and waiting for operator action; those component/setup states remain visible through health checks.

## 4. Onboard from Desktop

Start Desktop with the controller profile, then use the Cloud Fleet card:

1. Sign in with GitHub device flow.
2. Select **Create my cloud account**. This creates the person entry and Linux user.
3. Enter a lowercase deployment id and `owner/repository`, then create the deployment. The gateway calls the fixed helper and returns only non-secret metadata.
4. Paste that deployment agent GitHub account’s PAT into **Configure agent credentials**. The helper writes a `0700` `gh` wrapper owned by that person and saves it in the GitHub Source. The PAT is not written to the gateway registry or returned by the API.
5. Configure model credentials through the connected deployment’s normal DSH provider settings. They stay under that person’s Linux user and profile.

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

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-superagent-gateway.service
sudo systemctl enable --now dsh-superagent@<deployment-id>.service
sudo systemctl enable --now dsh-superagent-health@<deployment-id>.timer
```

The deployment unit starts the existing `scripts/dsh-superagent` launcher, which starts `dsh --profile ... --no-open` in tmux and records the process. The health timer runs every five minutes. `scripts/dsh-superagent-recover` calls the launcher again only when status exits 1; intentional stops and setup/component errors are not restarted automatically.

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

## Migration and upgrades

- Stop the Mac-local deployment before starting its server copy; two running deployments polling one GitHub account duplicate work.
- Copy each deployment's database, lock files, Session catalog, worktrees, and `native-proxy-token` while it is stopped, keeping absolute paths unchanged.
- Recreate model credentials through the connected deployment’s DSH settings. For agent GitHub credentials, use the Desktop Cloud Fleet credential form; OS keychain credentials do not migrate.
- Before upgrading, stop the deployment unit, snapshot `/var/lib/dsh-superagent`, pull this repository, run `pnpm install && pnpm build`, and restart the gateway and deployments.
