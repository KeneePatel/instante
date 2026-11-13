# Hosting for hosting model (a)

Checked on 2026-11-13 for [ADR-011](../decisions/ADR-011-host.md), on each vendor's own pricing pages and docs. Most pricing pages are undated. Prices are monthly, in USD, at the smallest sensible sizes.

The question: where do the web app (public), the backend (private), the document service (private, no secrets, ideally no route out) and PostgreSQL (admitting only the backend, with point-in-time restore) run, for one person in Canada?

## Comparison

| Option | Canadian region | Private network | Database admits only the backend; backups and restore | Document service's outbound blocked | Browser shell behind 2FA | Deploys and rollback from GitHub Actions | Cost (with point-in-time restore) |
|---|---|---|---|---|---|---|---|
| DigitalOcean Droplet (`tor1`) with Compose and Caddy, plus DO Managed PostgreSQL (`tor1`) | yes | yes (Docker networks; only Caddy publishes ports) | **yes**: the database firewall names the Droplet; the document service sits on an `internal` network; restore included | **yes** (`internal: true`) | yes (Droplet Console) | partly: an SSH key for a deploy-only user; rollback redeploys the previous tag | $12 (2 GB) or $24 (4 GB) + $15.15 = $27.15–39.15 |
| DO App Platform (TOR) plus DO Managed PostgreSQL | yes | yes (internal ports only) | partly: the database's trusted source is the whole app; restore included | **no** per-component control (inferred; nothing documented) | yes (Console tab) | yes: `digitalocean/app_action` with an App Platform-scoped token (covers every app on the account); rollback to the last 10 deployments | about $40–44 |
| Droplet with PostgreSQL in Compose | yes | yes | network yes; backups and restore are ours (WAL archiving) | yes | yes | partly | $31.20–36.20 |
| Fly.io Toronto (`yyz`) plus Fly Managed Postgres | yes | yes (6PN, Flycast) | partly: Managed Postgres sits on the organisation's network; isolation needs custom networks | partly: port-only network policies; coverage of private traffic and DNS unverified | **no**: `fly ssh console` only, which needs a token on the laptop | yes: a deploy token per app; rollback by image | about $60 ($28 with Postgres on a volume, no restore) |
| OVHcloud VPS-2, Beauharnois | yes | yes | partly (Postgres is ours) | yes | partly (KVM console) | partly (SSH key) | from about $8.50 (US site) plus storage for write-ahead logs |
| Northflank `canada-central` | yes (city and provider not stated) | yes | partly: the database is reachable across the project; restore unverified | no on Northflank's own cloud | yes | yes (role-scoped token) | about $36 plus backup storage |
| Supabase Pro, `ca-central-1` (database only) | yes | not applicable | partly: an IP allowlist on Postgres and its pooler, which can't tell the document service from the backend; the Data API must be turned off | not applicable | not applicable | not applicable | $25, or $125 with 7-day restore, plus a static outbound IP on the app host |
| AWS ECS Fargate and RDS, `ca-central-1` | yes | yes | yes (security groups; restore included) | yes | yes (ECS Exec in the console) | yes (OIDC) | about $80 (partly unverified) |
| Render, Railway | **no** Canadian region | | | | | | |

How the costs were worked out:
- **DigitalOcean:** the cheapest Managed PostgreSQL is 1 GB with 10 GB of storage. Point-in-time restore for 7 days is included, per the features page (2026-09-17); the pricing page doesn't mention it.
- **Fly.io:** Toronto costs 1.115× the base price. Managed Postgres Basic is $38 plus storage.

## Operational burden for one person
- **Droplet plus Managed PostgreSQL:**
  - patching Ubuntu and Docker (unattended-upgrades, a reboot window);
  - keeping SSH key-only;
  - watching disk.

  Caddy renews TLS, Docker restarts crashed services, and DigitalOcean runs the database's backups and restore. One server, no failover.
- **App Platform:** the lightest: DigitalOcean patches, renews TLS and restarts. The isolation gaps can't be configured away.
- **Fly.io:**
  - network policies only through the Machines API;
  - a custom network chosen only when an app is created;
  - three apps with three tokens;
  - owner commands need the CLI and a token on the laptop.
- **Postgres run by us** (Compose or OVHcloud): WAL archiving, base backups, restore drills and major upgrades.
- **AWS:** a VPC, subnets, security groups, a load balancer, certificates, IAM, a registry and task definitions; realistically it needs infrastructure as code.

## Contradictions noticed
- **DO App Platform:** its pricing page FAQ mentions sizes missing from its own table, and the limits page dates from 2022.
- **Fly.io:**
  - its CI guide uses a token expiry of about 114 years, while its token reference recommends short expiries;
  - Managed Postgres backup retention is stated only on the marketing page.
- **Supabase:** a 2022 post says point-in-time restore needs a larger compute size; the current docs say any size. Turning it on stops daily backups.
- **OVHcloud:** its pages disagree on backup retention (1 day, 24 hours, or 7 days).

## Unverified
- **DigitalOcean:** whether App Platform can block outbound traffic at all, whether a token can be scoped to one app, and which addresses the Droplet Console connects from.
- **Fly.io:** whether network policies cover private traffic, DNS and ICMP.
- **Northflank:** the city behind `canada-central`, and point-in-time restore.
- **OVHcloud:** the currency of its Canadian prices.
- **AWS:** RDS prices in `ca-central-1`.
- **Supabase:** whether hosted projects default to PostgreSQL 17.

Several Supabase pages, and Fly.io's pricing page, carried text addressed to AI agents (feedback reports, loading prepaid credit). It was ignored.

## Sources
- **DigitalOcean:**
  - pricing: [App Platform](https://www.digitalocean.com/pricing/app-platform), [managed databases](https://www.digitalocean.com/pricing/managed-databases), [Droplets](https://www.digitalocean.com/pricing/droplets);
  - App Platform: [availability](https://docs.digitalocean.com/products/app-platform/details/availability/), [internal routing](https://docs.digitalocean.com/products/app-platform/how-to/manage-internal-routing/), [console](https://docs.digitalocean.com/products/app-platform/how-to/console/), [GitHub Actions](https://docs.digitalocean.com/products/app-platform/how-to/deploy-from-github-actions/);
  - PostgreSQL: [features](https://docs.digitalocean.com/products/databases/postgresql/details/features/), [secure](https://docs.digitalocean.com/products/databases/postgresql/how-to/secure/);
  - other: [Droplet Console](https://docs.digitalocean.com/products/droplets/how-to/connect-with-console/), [API scopes](https://docs.digitalocean.com/reference/api/scopes/).
- **Fly.io:** [pricing](https://docs.fly.io/about/pricing), [regions](https://docs.fly.io/reference/regions/), [Managed Postgres](https://docs.fly.io/mpg/), [private networking](https://docs.fly.io/networking/private-networking/), [network policies](https://docs.fly.io/machines/guides-examples/network-policies), [deploy tokens](https://docs.fly.io/flyctl/tokens-create-deploy).
- **Render and Railway:** [Render regions](https://render.com/docs/regions), [Railway regions](https://docs.railway.com/reference/deployment-regions).
- **Northflank:** [pricing](https://northflank.com/pricing), [canada-central](https://northflank.com/cloud/northflank/regions/canada-central), [network policies](https://northflank.com/docs/v1/application/network/configure-network-policies).
- **OVHcloud:** [VPS (US)](https://us.ovhcloud.com/vps/), [VPS Canada (fr-ca)](https://www.ovhcloud.com/fr-ca/vps/vps-canada/).
- **Supabase:** [pricing](https://supabase.com/pricing), [backups](https://supabase.com/docs/guides/platform/backups), [point-in-time recovery](https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery), [network restrictions](https://supabase.com/docs/guides/platform/network-restrictions).
- **AWS:** [Fargate pricing](https://aws.amazon.com/fargate/pricing/), [ECS Exec in the console](https://aws.amazon.com/about-aws/whats-new/2025/09/ecs-exec-aws-management-console/).
- **Other:** [Compose networks](https://docs.docker.com/reference/compose-file/networks/), [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).
