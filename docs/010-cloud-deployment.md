# 010 Cloud deployment

This guide installs the first cloud fleet on a Linux server. It uses one HTTPS address and one Linux user for the initial fleet. Later onboarding can add one Linux user per person while preserving this same gateway and controller protocol.

## 1. Create the Droplet

Use a General Purpose Droplet with at least 2 dedicated vCPUs and 8 GB RAM. Attach a 50 GB volume for `/var/lib/dsh-superagent`, enable weekly backups, and reserve a public IP. The examples assume Ubuntu or another Linux distribution with systemd.

SSH in, add a non-root fleet user, and install Node.js 22.19+ or 24, pnpm, Python 3.8+, tmux, git, and the `dsh` command.

```sh
sudo mkdir -p /opt/dsh-superagent /etc/dsh-superagent /var/lib/dsh-superagent
sudo chown -R <fleet-user>:<fleet-group> /opt/dsh-superagent /var/lib/dsh-superagent
sudo chown <fleet-user>:<fleet-group> /etc/dsh-superagent
git clone <this-repository> /opt/dsh-superagent
cd /opt/dsh-superagent
pnpm install && pnpm build
dsh --version
```

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

## 3. Configure one deployment

For each repository, create a separate DSH profile, state directory, loopback port, and clean checkout or worktree root:

```sh
DSH_HOME=/var/lib/dsh-superagent/dsh-home \
  dsh plugin --profile superagent-<deployment-id> add "link:/opt/dsh-superagent"
sudo -u <fleet-user> mkdir -p \
  /var/lib/dsh-superagent/deployments/<deployment-id> \
  /var/lib/dsh-superagent/worktrees/<deployment-id>
```

Merge [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) into that profile. Keep its `webserver.host` on `127.0.0.1`, choose a unique port, and set the `stateDir` to the deployment directory. Configure the model provider, agent GitHub CLI, repository, policy, and execution prepare command through the profile's normal setup flow or documented settings API.

Copy [examples/cloud/deployment.env.example](../examples/cloud/deployment.env.example) to `/etc/dsh-superagent/deployments/<deployment-id>.env` with the same values used in the gateway registry.

## 4. Install systemd supervision

Copy the four unit files from `examples/cloud/systemd/` to `/etc/systemd/system/`, replacing `<fleet-user>` and `<fleet-group>` in each file.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-superagent-gateway.service
sudo systemctl enable --now dsh-superagent@<deployment-id>.service
sudo systemctl enable --now dsh-superagent-health@<deployment-id>.timer
```

The deployment unit starts the existing `scripts/dsh-superagent` launcher, which starts `dsh --profile ... --no-open` in tmux and records the process. The health timer runs every five minutes. `scripts/dsh-superagent-recover` calls the launcher again only when status exits 1; intentional stops and setup/component errors are not restarted automatically.

Gateway logs are available with:

```sh
journalctl -u dsh-superagent-gateway.service -f
```

## 5. Connect Desktop

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
- Recreate model and agent GitHub credentials on the server; OS keychain credentials do not migrate.
- Before upgrading, stop the deployment unit, snapshot `/var/lib/dsh-superagent`, pull this repository, run `pnpm install && pnpm build`, and restart the gateway and deployments.
