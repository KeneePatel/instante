# ADR-012: Run Instante on the owner's Mac, as local processes with a database cluster of its own

## Status
Accepted 2026-11-13. At the phase 2 gate the owner chose to run Instante on their own computer for now, not on a server, so [ADR-011](ADR-011-host.md) isn't adopted. The details below are defaults written the same day and revised after a fresh-context review whose findings were checked against primary sources, then after a second review of the result ("Doubts raised"). The owner confirmed them on 2026-11-13, with the revised [`platform` spec](../specs/platform.md), and chose Claude Code deny rules in their user settings to keep agents out of `~/.instante`. The decision applies hosting model (a) ([ADR-005](ADR-005-same-origin-rewrite-and-typed-contract.md)) on one machine, and settles where the production database runs ([ADR-003](ADR-003-one-postgres-database.md)).

## Date
2026-11-13

## Context
- **The owner's answer:** "I will be running it in my pc for now." Instante is a personal project, used while the owner is at the computer.
- **The machine:** the owner's Mac on Apple silicon, running macOS 27, with Homebrew, mise, Node 26.13.1, pnpm 12.18.0 and PostgreSQL 18.7, and no Docker. Its `/bin/bash` is 3.2. The coding agents run there too, as the same user.
- **What changes compared with a server:**
  - nothing has to be reachable from the internet, so there's no TLS, domain, firewall, SSH or deploy key to run;
  - the real data sits on the machine and the user account the agents and the development databases also use;
  - web pages open in the owner's browser can send requests to local ports, and through DNS rebinding can try to read the replies;
  - cookies don't separate by port, so every page served at the same host name shares them;
  - Instante runs only while the Mac is awake and Instante is started;
  - backups are ours to make.
- **Facts the design rests on,** checked on 2026-11-13 against the sources named, or by probes on this Mac in a scratch folder:
  - **Cookies:** "Cookies do not provide isolation by port" ([RFC 6265 §8.5](https://www.rfc-editor.org/rfc/rfc6265#section-8.5)). `@supabase/ssr` 0.12.7 sets `httpOnly: false` and a 400-day `maxAge`, so scripts on any page at the same host can read the session. A probe in Safari's WebKit and in Chrome showed that a host name like `instante.localhost` keeps its own cookies, apart from `localhost` and `127.0.0.1`. On this Mac `*.localhost` resolves to loopback with no system change, and both engines treat it as a secure context.
  - **Next.js 16.4:** `next start` listens on every interface unless given `-H`. Its external rewrites proxy with `changeOrigin: true`, so the backend sees its own address as `Host` and the browser's in `X-Forwarded-Host`. `proxy.ts` doesn't run on paths its matcher leaves out, and a same-origin page can add the `next-router-prefetch` header to skip it. The rewrite's 30-second limit is an idle timeout, and it applies in production too.
  - **Node's permission model** "does not provide security guarantees in the presence of malicious code" ([permissions](https://nodejs.org/api/permissions.html)). Without `--allow-net` it blocks TCP, Unix sockets and DNS. A restricted process can still kill or signal other processes of the same user, and use `process._debugProcess` to open another Node process's debugger, which `--disable-sigusr1` ([command-line options](https://nodejs.org/api/cli.html)) prevents. A parent allowed to start processes isn't held by the model at all. Symlinks inside an allowed folder are followed.
  - **PostgreSQL 18:**
    - it can listen on no TCP address (`listen_addresses = ''`), only on a socket in a folder we choose, with `scram-sha-256` required ([connection settings](https://www.postgresql.org/docs/18/runtime-config-connection.html), [`pg_hba.conf`](https://www.postgresql.org/docs/18/auth-pg-hba-conf.html));
    - `initdb --auth=scram-sha-256` needs a password file for the first superuser;
    - started with no locale in its environment on macOS, it refuses to run;
    - macOS limits a socket path to 103 bytes for PostgreSQL and 104 for Node;
    - a role that owns the database and its objects, with `CREATEDB`, can dump it and restore it into a new database;
    - Homebrew's own cluster on this Mac trusts every local connection, with no password.
  - **pg-boss 12** started with `migrate: false` refuses to run when the database's schema version differs from its own, in either direction. Its schema changed 20 times in the last year, in minor releases.
  - **GitHub:** a repository ruleset that requires status checks also applies to direct pushes, and binds the owner when nobody may bypass it. Its public API reports a commit's check runs without a token. Standard runners, macOS included, are free for public repositories.
  - **Claude Code:** deny rules for `Read` and `Edit` cover its own file tools and the file commands it recognises, but not interpreters such as `node`, `python` or `psql`, nor MCP servers. Its sandbox covers every Bash subprocess. A project's settings can switch off a user's sandbox, but can't remove a user's deny rules ([permissions](https://code.claude.com/docs/en/permissions), [sandboxing](https://code.claude.com/docs/en/sandboxing)).

## Decision
- **Where:** the owner's Mac, and nowhere else. There's no server, no domain (decision D8: not now) and no Docker. ADR-011's server design is kept as the reviewed starting point if Instante ever moves.
- **The addresses:**
  - real use is at `http://instante.localhost:4310`, a host name that nothing else is ever opened at, so no other local page shares its cookies;
  - development is at `http://localhost:3000`;
  - each server answers `421` to any other `Host`, so the session cookie can only be set at its own name;
  - `instante start` refuses to run if `instante.localhost` stops resolving to loopback only, which a macOS upgrade could change;
  - ports 4310 and 4311 and that name are reserved for real use: every other run, tests included, is refused them, so a tab left open on real use can't reach anything else while the real stack is stopped.
- **The data folder:** `~/.instante` (`INSTANTE_HOME`), mode `0700`:

  | Path | Holds |
  |---|---|
  | `repo.git/` | a bare clone of the GitHub repository |
  | `releases/<commit>/` | one checkout and build per release, of which the last 3 are kept |
  | `current` | a link to the live release |
  | `bin/instante` | the owner's command, a link to `current/scripts/local/instante` |
  | `postgres/` | the real-use database cluster |
  | `run/` | the database's socket, the document service's socket, the lock, and the running processes' ids |
  | `secrets/` | one file per secret, mode `0600`: for each of the three database roles, a `PGPASSFILE` and a connection URL; the Anthropic key from the `ai` module on |
  | `config.env` | settings that aren't secret: Supabase's URL and publishable key, the ports |
  | `backups/` | the database dumps |
  | `logs/` | each process's log, one file per start |
  | `releases.log` | each release: commit, time, the dump taken before it, last migration, pg-boss's schema version |

- **The database:** a PostgreSQL 18 cluster of its own in `postgres/`, apart from the Homebrew cluster that development and tests use.
  - It's created with `initdb -U instante_admin --pwfile=… --auth=scram-sha-256 -E UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8 --locale=C`. Development, test and CI databases use the same locale, so text sorts the same everywhere.
  - It listens on no TCP address, only on a socket in `run/`, with `unix_socket_permissions = 0700`, and the only `pg_hba.conf` rule is `local all all scram-sha-256`. Its time zone is UTC, and its logs rotate daily over a week.
  - It's started with `LC_ALL=C`, from Homebrew's stable path `/opt/homebrew/opt/postgresql@18/bin`. `setup` pins the formula (`brew pin`), so other installs can't upgrade it underneath a running cluster; a planned upgrade unpins it with Instante stopped.
  - **Roles and who uses each:**

    | Role | Can | Used by |
    |---|---|---|
    | `instante_admin` | everything (superuser) | `instante setup` only |
    | `instante_owner` | owns the database and every object in it; `CREATEDB` | `cli db migrate`, `pg-boss migrate`, the dumps, `instante restore` |
    | `instante_app` | reads and writes rows | the backend and owner commands |

    Each has a random hex password, kept only in `secrets/`. The scripts pass it to `psql` and `pg_dump` through a `PGPASSFILE`, never a command line, and set it with a SCRAM verifier sent on standard input, so it never reaches `ps` or the server's log. Connection URLs name the socket folder in `host=`, and with `INSTANTE_ENV=production` the backend parses its URL with the same parser `pg` uses and refuses any host but `$INSTANTE_HOME/run`.
  - Socket paths are checked against macOS's limits before anything starts.
- **The processes:** `instante start` holds a lock (`lockf` on `run/instante.lock`) so only one copy runs. The three processes inherit it, so one left behind by a killed launcher still blocks a second copy, and `instante stop` cleans up after it. Then it starts the cluster, then the document service, the backend and the web app, in the foreground. Ctrl-C, closing the terminal, or any process exiting stops them all, the cluster included.

  | Process | Listens on | Runs as |
  |---|---|---|
  | web | `127.0.0.1:4310` | `next start -H 127.0.0.1 -p 4310` under Node's permission model, reading only its release folder (confirmed in T2: it needs only `--allow-net`, with the config loaded by type stripping) |
  | backend (`ROLE=all`) | `127.0.0.1:4311` | Node on the backend's `.ts` source; it holds the secrets, so no permission flags |
  | document service (`ROLE=documents`) | the socket `run/documents.sock` | Node, with only its own environment names; its task children under the permission model |

  - Every process is started with the pinned Node's absolute path (found with `mise where`, never `mise exec`, and its version checked), `--disable-sigusr1` on its command line, and a clean environment (`env -i` plus the names it needs).
  - `instante status` and the tests check with `lsof` that nothing listens on anything but loopback.
  - Development uses `127.0.0.1:3000`, `127.0.0.1:8080` and a short socket path of its own, so the two can run at once.
- **Requests from other web pages:**
  - `proxy.ts` checks `Host` on every request except static files, `/api` and prefetches included, and the backend checks `X-Forwarded-Host` on rewritten requests. That stops DNS rebinding.
  - `proxy.ts` and the backend refuse a request whose `Sec-Fetch-Site` is `cross-site` or `same-site`, unless it's a top-level `GET` navigation to a page. That stops another site from posting to Instante's local servers at all.
  - Browsers can't reach the document service or the database, which are on sockets.
  - The backend still has no cookie authentication, and a JSON body still needs a preflight it never grants ([ADR-004](ADR-004-supabase-auth.md)).
- **No TLS:** the traffic never leaves the machine, and browsers treat `*.localhost` as secure.
- **Releases:** `instante release <commit>`, run only by the owner. Each step must pass before the next:
  1. It takes the lock, so Instante must be stopped.
  2. The id must be 40 hex characters.
  3. With the owner's git configuration ignored, it fetches `main` from the repository's fixed GitHub address, and `main` must contain the commit.
  4. GitHub's public API must show every required CI job passing on that exact commit, because a fast-forward push can put commits on `main` that CI never ran on its own. Without a token, a refused or rate-limited answer counts as a failure. It prints the commit's subject.
  5. It checks the commit out into `releases/<commit>/`, then runs `pnpm install --frozen-lockfile` (lifecycle scripts stay blocked) and `pnpm build`, running that commit's own scripts, never the working checkout's.
  6. A dump, then `cli db migrate` and `pg-boss migrate`, as `instante_owner`.
  7. `current` moves to the new release, and `releases.log` records it.

  A failure before step 6 changes nothing; a failure in step 6 leaves `current` where it was, and the owner restores the dump just taken.

  `release` refuses the current commit and older ones. **`instante rollback`** restores the dump taken just before the current release and points `current` back at the previous release, which is kept and already built. Code and schema, pg-boss's included, always match, and the migration runner never relaxes its checks. The work done since that release is lost, which is acceptable for one person. pg-boss is pinned exactly, and upgrading it is its own release.
- **The first release:** `instante setup` runs from a fresh clone, only while `~/.instante` doesn't exist, after the owner types a confirmation. It creates the home, the cluster and the roles, then releases the clone's own commit through steps 2 to 7, so even the first release passes the GitHub checks.
- **Owner commands:** `instante cli users …`, `instante cli sources …` and the rest run the backend's `cli` from the current release, as `instante_app`, in the owner's own terminal.
- **Backups:**
  - `instante start` dumps the database (`pg_dump -Fc`, as `instante_owner`) when the newest dump is more than 24 hours old, at start and then daily while it runs, and every release dumps before migrating;
  - dumps older than 14 days are deleted, except the newest 3 and the dump taken before each of the last 3 releases, which `rollback` needs;
  - `instante restore <dump>` restores into a new database, checks it, swaps it in for the old one with connections turned off, re-applies the database's grants and settings, and runs `ANALYZE`;
  - on a new Mac, `instante setup` comes first, because a dump holds no roles;
  - if the owner uses Time Machine, it copies `backups/` off the Mac. FileVault and Time Machine are on the owner's checklist before the alpha.
- **Logs:** one file per process per start in `logs/`, a new file past 20 MB, and the last 10 starts kept.
- **The document service:**
  - each task child is started with `spawn` (never a shell or `fork`), with `--permission`, reads only from its job folder and the code, no network, writes, child processes or workers, its own minimal environment with no `NODE_OPTIONS`, piped standard streams only, and heap, time and input limits;
  - job folders come from `mkdtemp`, and anything in them that isn't a regular file (a symlink, or a hard link) is refused. At start, the service refuses to run if a symlink in the code it grants points outside it;
  - the service process itself holds no secret and no database password, but nothing sandboxes it: it has to start children, and Node's permission model can't hold a process that may. Its own input comes only from the backend. An exploit that escapes a child runs as the owner, and even a contained one can kill or signal the owner's processes (residual risk R2).
- **Agents and the real data:** the agents share the Mac and the user account, so the operating system doesn't keep them out. The controls are:
  - [`AGENTS.md`](../../AGENTS.md): never read `~/.instante`, never run `instante`, never connect to the real-use cluster, never loosen the agent settings;
  - Claude Code deny rules for `Read` and `Edit` of `~/.instante/**`, in the repository and in the owner's user settings (set 2026-11-13), which a repository can't undo;
  - not yet: Claude Code's sandbox with `~/.instante` denied, which would also cover interpreters. The owner decides on it, or on a separate macOS user, before the alpha, when real data first arrives;
  - CI fails if a committed `.claude/` settings file has a `sandbox` key, an `allowRead`, or a rule naming `~/.instante` that isn't a deny; the sandbox lives only in the owner's user settings;
  - the scripts' tests run against a scratch `INSTANTE_HOME`. The default home is used only by a script running from inside `~/.instante/releases/`, or by the first `setup`. Any other run must name a home, and is refused if that home is the same folder as `~/.instante` (compared by device and inode, not by spelling);
  - no production secret sits in the repository, its `.env` files or the owner's shell profile.

  Even with all of it, this is a rule backed by settings, not a wall (residual risk R9). A separate macOS user for real use would be the wall.
- **GitHub:** the owner sets one ruleset on `main` when creating the repository. It's active with an empty bypass list, restricts deletion, blocks force pushes, and requires every CI job, the macOS one included. `release` doesn't rely on it: anyone who can change it can also push, so `release` checks the exact commit's runs itself.
- **Monitoring** (decision D7): logs only. UptimeRobot and Healthchecks.io are dropped: nothing is public to check, and the owner is at the Mac when Instante runs.
- **Two-factor sign-in** on GitHub, Supabase and Anthropic, with recovery codes kept offline.
- **CI:** no deploy and no secrets. Linux runs the checks and the end-to-end tests against a production build. A macOS job on a pinned runner label runs `setup`, `release`, `start`, `backup` and `restore` end to end in a short scratch home whose path contains a space. In that job, `origin` is a local bare repository and GitHub's answers come from a local stub, so every refusal path is tested.
- **The deletion journal** is deferred to the checklist in [`product.md`](../product.md#before-anyone-else-uses-it): only the owner's own data exists, so a restore can't bring back anyone else's deleted data.

## Alternatives considered

| Option | Why not |
|---|---|
| [ADR-011](ADR-011-host.md): a DigitalOcean server, about $27 a month | The owner doesn't want a server now. It's the starting point if Instante moves |
| Docker on the Mac (Docker Desktop, OrbStack or Colima) | Would keep ADR-011's container isolation for the document service and the web app, but needs a new install and a virtual machine, for risks that stay small while only the owner uploads |
| `http://localhost:4310` or `http://127.0.0.1:4310` for real use | Every other local server at the same host name, the agents' development build included, would share the production session cookie |
| The Homebrew cluster for real use too, in its own database | That cluster trusts every local connection, so the development databases and the real data would share one unlocked door |
| A separate macOS user for the real-use stack | The operating system would keep the agents out of the real data, but every owner command needs a user switch. Decided before the alpha |
| Building releases in place, in one clone | A failed install or build would leave the live copy broken |
| A rollback mode that runs older code on a newer schema | Needs expand-only migrations and pg-boss downgrades, which change about weekly in pg-boss 12; restoring the pre-release dump is simpler for one person, at the cost of the work since the release |
| Starting at login (a LaunchAgent) | Collection would run whenever the Mac is on, but it's more to install and to stop. Later, if the owner wants it |
| Reaching it from the phone (Tailscale or a tunnel) | Not asked for, and it opens a network path to the Mac |

## Consequences
- **Cost:** nothing for hosting. Supabase's free projects and the AI budget remain.
- **Less to run, but the local stack is real work:** no server, Compose file, firewall rules, SSH or deploy key, but a launcher, a release script with GitHub checks, and a restore. `platform` goes from 12 slices to 11.
- **Instante runs only when started.** Scheduled collection misses the hours the Mac is off or Instante isn't running, and `job-pool`'s spec says how an overdue read catches up.
- **One machine holds everything.** A lost Mac or a failed disk is the main risk to the data; FileVault, the dumps and Time Machine cover it.
- **The real data shares a user account with the agents** (R9).
- **The document service and the web app aren't sandboxed on the Mac;** the web app's permission flags are a seat belt (R2).
- **The address is a name only this Mac knows.** A future server needs its own domain.
- **Moving later:** the same code runs on a server. ADR-011 holds the reviewed design, and the [hosting note](../research/hosting.md) its research.
- **The threat model** replaces its "Host and deploy" section with "The Mac" ([`threat-model.md`](../threat-model.md)).

## Doubts raised
- **Fresh-context security review, 2026-11-13:** 16 findings (1 blocker, 7 major, 7 minor, 1 over-built). Eight independent verifiers then tried to disprove them against RFCs, the Node, PostgreSQL, Next.js, Supabase, pg-boss, GitHub and Claude Code docs and source, and probes on this Mac. None was refuted, and nine were corrected in detail. The outcomes:
  - "Development and real use share one cookie jar" (blocker): valid. Real use moved to `instante.localhost`, with `Host` allow lists that refuse other names.
  - "The `Host` check misses `/api`, static files and prefetches, and the backend can't see the browser's `Host`" (major): valid, but the backend can, through `X-Forwarded-Host`. `proxy.ts` now checks every request but static files, the backend checks `X-Forwarded-Host`, and a Fetch Metadata check was added.
  - "Nothing keeps `next start` on loopback" (major): valid. An explicit `-H 127.0.0.1`, absolute paths, and `lsof` checks.
  - "The web app and the document service can read the secrets" (major): valid. The web app runs under the permission model, reading only its release. The document service's parent can't be held by it, which is now stated in R2.
  - "`instante setup` fails without a superuser password, and the dumps had no role" (major): valid, confirmed by probe. A named superuser for setup only, `CREATEDB` for the owner role, and the roles table above.
  - "The test-mode guard fails open, and compares paths as strings" (major): valid; APFS ignores case. The default home is only used from a release, and homes are compared by device and inode.
  - "Claude Code's deny rules don't stop subprocesses" (major): partly. They do cover `cat` and other recognised file commands, but not interpreters or MCP servers. The owner chooses the stronger options; R9 says what each covers.
  - "Nothing enforces what `release` trusts" (major): valid. A ruleset on `main`, and a release that checks the exact commit's check runs, since a fast-forward push can put commits on `main` that CI never ran.
  - Minor, all valid: releases built in place (now one folder per release), rollback across pg-boss schema changes (now refused, with restore instead), no single-instance lock (now `lockf`), the locale (now pinned), socket path limits, Homebrew's versioned paths and mise's trust rules, and the self-test's probes.
  - "The deletion journal is over-built for one person" (over-built): accepted, and deferred.
- **Second review, of the revised documents, 2026-11-13** (one reviewer for consistency across files, one for buildability):
  - "`setup` can never create the real home under the home rule" (blocker): valid. Only the first `setup` may create it, after a typed confirmation, and it releases its own commit through the GitHub checks.
  - "Rollback mode rests on expand-only migrations that other files drop after release, and pg-boss can't follow it" (major): valid. Rollback mode is gone: `rollback` restores the pre-release dump and returns to the previous build.
  - "Prefetches skip the session refresh, so a Server Component can meet an expired token" (major): valid. Prefetches skip only the CSP.
  - "Another run on port 4310 would receive an open tab's cookies while the real stack is stopped" (major): valid. The ports and name are reserved for real use.
  - "Which commands need the cluster is unsaid; the descriptor check can't pass; the phase 4 drill still replays the journal" (major): valid, each fixed.
  - "Re-reading the ruleset and checking the app id add nothing" (over-built): accepted, and cut.
  - Minor fixes: dumps while running and log size; `brew pin`; passwords through `PGPASSFILE`; the restore swap; git hooks; the development CSP; test ports and timeouts; `instante stop`, `config` and the stale text the reviewers listed.

## Revisit when
- The owner wants Instante away from the Mac, or always on: ADR-011, a LaunchAgent, or a private network for the phone.
- Anyone else uses Instante: a server at least, and the checklist in [`product.md`](../product.md#before-anyone-else-uses-it).
- Others upload, or the sources widen beyond the curated boards: a real sandbox for the document service, such as a macOS sandbox profile or a container.
- The agents' access to the data folder becomes a worry: a separate macOS user for real use.
- A macOS or browser update changes how `*.localhost` resolves or how cookies on it behave.
