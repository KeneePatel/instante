# ADR-011: One DigitalOcean server in Toronto with Docker Compose and Caddy, plus DigitalOcean Managed PostgreSQL

## Status
Proposed 2026-11-13 in phase 2, for the owner's approval at the phase 2 gate, and revised the same day after a fresh-context review. It applies hosting model (a) ([ADR-005](ADR-005-same-origin-rewrite-and-typed-contract.md)) and settles where the production database runs ([ADR-003](ADR-003-one-postgres-database.md)). Whether to buy a domain before the first real sign-in is decision D8 ([`sdlc.md`](../sdlc.md#phase-2-foundations)).

## Date
2026-11-13

## Context
- **What runs:**
  - the web app, public over HTTPS;
  - the backend, private;
  - the document service, private, with no secrets, and no route to the database, the host or the internet;
  - PostgreSQL with backups, and point-in-time restore once real data exists.

  It's a personal project, so cost and one person's time weigh heavily.
- **The criteria** ([`architecture.md`](../architecture.md#environments)):
  1. a Canadian region;
  2. private networking;
  3. a database that admits only the backend;
  4. no outbound network for the document service;
  5. a browser console behind two-factor sign-in, for owner commands;
  6. deploys and rollback from GitHub Actions;
  7. cost.
- **What the vendors offer:** the [hosting note](../research/hosting.md) compares seven options on their own pages. Prices are monthly, in USD.

  | Option | Cuts the document service off | Browser console behind 2FA | Cost with point-in-time restore |
  |---|---|---|---|
  | **DigitalOcean server (Droplet) in Toronto, Compose and Caddy, plus Managed PostgreSQL** | **yes**, with the host rules below | yes, the Droplet Console | **$27.15** (2 GB server) to $39.15 (4 GB); restore included |
  | DigitalOcean App Platform plus Managed PostgreSQL | **no**: no outbound control, and the database admits the whole app | yes | about $40 |
  | Fly.io in Toronto | partly | **no**: CLI only, with a token on the laptop | about $60 |
  | Supabase Pro as the database | not applicable | not applicable | $125, and the Data API to turn off |
  | AWS Fargate and RDS | yes | yes | about $80, and the most to learn |

  Render and Railway have no Canadian region.
- **Facts the design rests on** (official docs):
  - **The managed database** in Toronto costs $15.15 for 1 GB, includes daily backups and 7 days of point-in-time restore, offers version 18, and admits only named trusted sources. Those sources are Droplets, tags or IP addresses, not containers.
  - **A Compose network marked `internal`** has no route out. Its gateway, and so services listening on the host, stay reachable unless the bridge's gateway mode is `isolated`, which needs Docker Engine 28 or later.
  - **Root-equivalence:** a user who can run `docker` is effectively root.
  - **Environment variables** passed to containers can be read with `docker inspect`; Compose `secrets` are mounted as files per service.
  - **Logs:** Docker's default log driver keeps logs without limit.
  - **SSH:** a `command=` key still allows TCP forwarding unless `restrict` is set.
  - **Public packages:** a public GitHub package can never be made private again.
  - **Shared DNS:** a hostname from a public DNS service like sslip.io is controlled by that service's operators, who could point it elsewhere and get a valid certificate for it.

## Decision
- **Compute:** one Droplet in Toronto (`tor1`), Ubuntu LTS, starting at 2 GB of memory ($12), with a Reserved IP.
  - The walking skeleton's memory check decides the size: if the services use more than 70% at idle, it's resized to 4 GB ($24), which is reversible.
- **The database:** DigitalOcean Managed PostgreSQL 18 in Toronto, 1 GB.
  - It's reached over the region's private network, and its trusted source is the Droplet.
  - Daily backups and 7-day point-in-time restore are included.
  - Supabase stays for sign-in only, and never holds Instante's data.
- **Docker:** Engine 28 or later, from Docker's own repository.
  - `daemon.json` sets `live-restore`, the `local` log driver capped at 20 MB per container (5 files), and `no-new-privileges` by default.
  - Docker's repository is among unattended-upgrades' allowed sources, so a runc or Docker security fix lands as Ubuntu's own fixes do. A Docker advisory is otherwise patched the day it's published.
- **Processes,** one Compose file:

  | Service | Networks | Notes |
  |---|---|---|
  | `caddy` | `edge` | publishes 80 and 443; image pinned by digest |
  | `web` | `edge`, `app` | Next.js standalone (`node server.js`) |
  | `backend` | `app`, `docs`, `egress` (with a fixed address) | `ROLE=all`; its API listens only on its `app` address; on `docs` it's only a client |
  | `migrate` | `egress` | a one-off service that runs `cli db migrate` with the owner role's credentials, then exits; nothing else holds them |
  | `documents` | `docs` | `internal: true`, with `com.docker.network.bridge.gateway_mode_ipv4: isolated`. It has no route to the internet, the host, the database or the backend's API |

- **Hardening for `documents`:**
  - `cap_drop: [ALL]`;
  - `read_only` with a `tmpfs` for the job folder;
  - a `pids_limit`;
  - `mem_limit: 768m`, so a hostile file can't take memory from `web` and `backend`;
  - a non-root user.

  Every other service also runs as non-root, with a read-only root filesystem where the process allows.
- **Only the backend reaches the database:** rules in Docker's `DOCKER-USER` chain, kept by a systemd unit that runs after Docker, drop new connections to the database's host on its ports unless they come from the backend's fixed address. A test proves `web`, `caddy` and `documents` can't connect.
- **Secrets:** as Compose `secrets`, files under `/run/secrets`, granted per service.
  - The backend gets the app role's password and the Anthropic key.
  - `migrate` gets the owner role's password.
  - `web` and `documents` get none.
  - The owner writes the secret files in the Droplet Console, never through `cloud-init` or CI. The backend's configuration reads `*_FILE` paths.
- **The address and TLS:** Caddy terminates TLS with automatic HTTPS and sets HSTS.
  - The data-free walking skeleton may use a sslip.io hostname.
  - **No real sign-in or data uses that hostname.** Before the first real sign-in on production, the end of the `accounts` module, there's a domain, if the owner approves D8. It has CAA records that name our ACME account and validation method, and two-factor sign-in at the registrar.
- **The server's set-up:** a `cloud-init` file in the repository holds no secrets. It sets up:
  - a non-root admin user and a deploy user;
  - `sshd` with `AllowUsers` for those two, key-only sign-in, and root, password and keyboard-interactive sign-in off;
  - unattended-upgrades with a weekly reboot window;
  - Docker as above;
  - the `DOCKER-USER` unit;
  - a DigitalOcean Cloud Firewall: 80 and 443 open, SSH open (key-only, needed by the console and by deploys), nothing else.

  A lost server is rebuilt from `cloud-init` and the runbook; the Reserved IP and the database survive.
- **Images:** CI builds both images on `main`, tags them with the commit, and pushes them to GitHub Container Registry as public packages, with build-provenance attestations.
  - Before pushing, CI runs gitleaks over each image's files, and `.dockerignore` is an allowlist.
  - The Caddy and Node base images are pinned by digest and updated by Dependabot.
- **Deploy and rollback:**
  - The deploy job runs in the protected `production` environment, only from `main`. It connects as the deploy user, checking a host key pinned from the fingerprint the owner reads in the Droplet Console. The workflow never runs `ssh-keyscan`, and the rebuild runbook re-pins the key.
  - **The deploy key's entry** in `authorized_keys` is `restrict,command="/usr/local/bin/instante-deploy"`: no port forwarding, no shell.
  - **The script** accepts only `deploy <40-hex commit> <image digest>` or `rollback <40-hex commit> <image digest>`, and never evaluates its input. It verifies each image's attestation against `deploy.yml` on `main` before pulling by digest.
    - `deploy` pulls, runs `migrate`, then restarts `web` and `backend`.
    - `rollback` accepts only one of the last 5 deployed commits recorded on the server, and skips `migrate`.
  - **Docker access:** the deploy user isn't in the `docker` group. One sudoers line lets it run that script and nothing else.
  - **Migrations and rollback:** from the alpha on, migrations only expand, so an older image runs on a newer schema. In rollback mode, the runner and `/readyz` accept applied migrations newer than the image knows.
- **Owner commands** run in the Droplet Console, behind DigitalOcean's two-factor sign-in, as `docker compose run --rm backend …`. No production credentials sit on the Mac or in an agent's shell.
- **The deletion journal:** `users delete` also appends one line (user id, time) to a journal on a host volume, kept 60 days, which outlives container logs and redeploys. The restore runbook re-applies deletions from it.
- **Monitoring** (decision D7): UptimeRobot checks the public address, and the backend pings Healthchecks.io after scheduled runs. Neither receives personal data, and the ping address is kept as a secret, since whoever holds it could hide an outage.
- **Two-factor sign-in** is on for DigitalOcean, GitHub, Supabase, Anthropic and the registrar, with recovery codes kept offline.

## Alternatives considered

| Option | Why not |
|---|---|
| DigitalOcean App Platform | The least to operate, at the same price, but the document service could reach the internet and the database admits the whole app, and neither can be configured away. Revisit if patching becomes a burden |
| Fly.io in Toronto | About $60, and owner commands need the CLI and a token on the Mac, against `AGENTS.md` |
| Postgres in Compose on the same server | About $10 cheaper, but backups, point-in-time restore and upgrades become ours |
| Supabase as the database | $125 with restore, the Data API to turn off, and an allowlist that can't tell containers apart |
| AWS | About twice the cost, and far more to set up for one person |
| A sslip.io hostname for real use | Its operators could point our name elsewhere and get a valid certificate, collecting sessions. Fine only for the data-free skeleton |
| Environment files for secrets | Readable with `docker inspect`, and they put the owner role's credentials in the always-on backend |
| A deploy key without `restrict`, or a deploy user in the `docker` group | Allows tunnels to the database and the containers, and gives root through Docker |

## Consequences
- **About $27 a month to start** ($39 at 4 GB) with point-in-time restore, plus a domain (about $15 a year, if D8 is approved) and the AI budget.
- **We run a server,** with more configuration than a platform service: the Compose file, the `DOCKER-USER` unit, `sshd` and the deploy script. It's all in the repository, built once in the `platform` slice and tested. Updates are automatic; the runbook covers a quarterly check and a rebuild.
- **One server, no failover.** An outage lasts until it restarts or is rebuilt. The data is safe in the managed database, and the Reserved IP keeps the address. Accepted for a personal tool.
- **SSH stays reachable,** for the console and deploys. It's limited by key-only sign-in, `AllowUsers`, and a restricted deploy key that can only run the script.
- **Public images can't be made private again.** They hold no secrets by construction, and CI checks them before pushing.
- **The threat model** gains a "Host and deploy" section ([`threat-model.md`](../threat-model.md)).

## Doubts raised
- **Fresh-context review, 2026-11-13** (12 findings, none blockers; each checked against Docker's, OpenSSH's and GitHub's documentation):
  - "The deploy key could open tunnels; the script's input, the Docker group and old images weren't covered; the host key's origin was unstated" (major): valid. `restrict`, a strict argument pattern, a sudo rule instead of the Docker group, attested digests, a rollback window, and a pinned key.
  - "sslip.io could take over the app with a valid certificate" (major): valid. Skeleton only; a domain with CAA before any real sign-in (D8); a Reserved IP.
  - "The database admits the whole server" (major): valid. `DOCKER-USER` rules allow only the backend's address, with a test.
  - "An `internal` network still reaches the host and the backend's API" (major): valid. Isolated gateway mode on Engine 28+, the backend listening only on `app`, and the self-test widened.
  - "Rollback fails across a migration" (major): valid. Rollback skips `migrate`, and the runner tolerates newer applied migrations in rollback mode.
  - "Environment files leak through `docker inspect`, and the backend held the owner role's credentials" (major): valid. Compose `secrets` per service and a one-off `migrate` service.
  - "Docker is the boundary but was patched quarterly; the document service wasn't hardened" (major): valid. Automatic Docker updates, `live-restore`, and capability, memory, process and file-system limits.
  - "Logs grow without limit, and the deletion log dies with the container" (major): valid. Capped logs and a host journal.
  - "Public images can't be made private, aren't scanned, and base images aren't pinned" (minor): valid. An allowlist `.dockerignore`, gitleaks over the image, and digest pins.

## Revisit when
- Patching or the single server becomes a burden: App Platform, accepting its isolation gaps.
- The owner buys a domain: Caddy and Supabase move to it, and the sslip.io hostname goes.
- Someone besides the owner uses Instante: a second server or App Platform for redundancy.
- Prices or features change at the quarterly review.
