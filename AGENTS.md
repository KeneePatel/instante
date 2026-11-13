# Instante: rules for agents

Every agent working in this repository (Claude Code, Codex or any other) follows these rules. `CLAUDE.md` imports this file.

## 1. Check skills before every request

Before acting on any prompt, including follow-ups and small fixes:

1. Look at the installed skills (`~/.agents/skills/*/SKILL.md`, plus any `.agents/skills/` or `.claude/skills/` in this repo) and read their descriptions. When unsure which apply, start from `using-agent-skills`.
2. Pick every skill that fits the request and say so in one line before starting, for example: `Skills: spec-driven-development, security-and-hardening`. If none fit, say `Skills: none apply`.
3. Follow the chosen skills' workflows, including their gates and verification steps.

## 2. Work in phases

Instante is built in the phases set out in [`docs/sdlc.md`](docs/sdlc.md). The current phase and its status are at the top of that file.

- Work only inside the current phase.
- A phase ends at its gate, and only the owner can sign a gate off. Don't start the next phase in the same turn that finishes one.

## 3. Commits, pushes and merges

- Every commit is authored **and** committed as `Kenee Patel <patelkenee2804@gmail.com>`. Right after `git init` or cloning, set it for the repository:
  ```bash
  git config user.name "Kenee Patel"
  git config user.email "patelkenee2804@gmail.com"
  ```
- Don't add `Co-Authored-By` lines, "Generated with" lines or any other AI attribution to commit messages or pull request descriptions.
- Before pushing, check that only that identity appears and no trailers were added:
  ```bash
  git log --format='%an <%ae> | %cn <%ce> | %(trailers:only,unfold)' origin/main..HEAD
  ```
  `scripts/check-commits.sh` automates this once it exists.
- Merge only by fast-forward from the command line after CI passes on the branch (`git push origin <branch>:main`). Never use GitHub's merge, squash or rebase buttons: they change the committer.
- Commit or push only when the owner asks. There's no standing approval for this repository.

## 4. Before writing code

- Read the parts of `docs/product.md` (what the app does), `docs/architecture.md` (how it's built), `docs/decisions/` and the module's spec in `docs/specs/` that apply to the task, and `CONSTRAINTS.md`.
- Keep the boundaries in `docs/architecture.md`:
  - the frontend never touches the database or holds secrets (Supabase's publishable key and project URL aren't secrets; its secret key never enters either app);
  - only the backend's store layer knows the schema;
  - every route is declared in the contract table;
  - apart from resume imports and the owner's replays of reported verdicts, only the AI view of a resume reaches a model;
  - the per-task list in `docs/architecture.md` ("What reaches the model") is the reference for what each call may send;
  - hostile documents are parsed only in the document service, which holds no secrets.
- Ask first before adding a dependency, changing the schema of data already in use, or sending users' data to a new third party (an AI provider, email, authentication, analytics, error tracking or hosting service).
- Never commit secrets. Keys live in git-ignored `.env` files, and `.env.example` lists their names.
- The repository is public. Nothing personal goes into it: no real resumes, contact details, job-search history or real posting text. The real eval set stays outside the repository, and CI replays synthetic fixtures.
- Instante stands on its own. Don't copy code, data, catalogs, settings or approvals from another project, and don't name other projects in this repository.
- Never weaken `CONSTRAINTS.md`, skip tests, or add suppressions to make a change pass.

## 5. Real people's data

- Never read, query, dump, copy or paste real people's data. That covers:
  - production or backup databases, and restore-drill forks;
  - production logs and the AI provider's console logs;
  - the database, Supabase project and AI workspace of the owner's own real use. On the owner's Mac that's everything in `~/.instante`: the real-use cluster and its socket, the secrets, the dumps, the logs and the releases.
- Never hold production credentials. They live only in `~/.instante/secrets`. Never read or edit `~/.instante`, never run the owner's `instante` command, and never connect to the real-use cluster; the owner runs `instante` in their own terminal. Test `scripts/local/` only against a scratch `INSTANTE_HOME`. CI holds no secrets.
- Agents run on the same Mac and user account as the real data, so these rules are what keep them out ([ADR-012](docs/decisions/ADR-012-run-on-the-owners-mac.md)). The repository's Claude Code settings, and the owner's own, back them up. Never add `sandbox` or `allowRead` settings to `.claude/` files or loosen a deny rule, and never change GitHub's rules for `main`.
- Development and tests use only seeded Jordan Rivera data and anonymized postings, in fixtures, tests, screenshots and docs alike.
- When a real case needs investigating, the owner runs `verdict show`, which is read-only and prints ids, counts, requirement text and verdict provenance, never resume or contact text. The owner shares only that output.
- `verdict replay` runs new AI calls, with the eval workspace's key and budget, and prints verdicts and differences only. Only the owner runs it.

## 6. Everyday commands

None yet. Phase 1 produced documents only; phase 3's `platform` slice adds the commands here.
