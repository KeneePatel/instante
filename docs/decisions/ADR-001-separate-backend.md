# ADR-001: A separate backend behind the Next.js app, plus a document service with no secrets

## Status
Accepted 2026-11-13, with hosting model (a), at the phase 1 gate. Proposed 2026-11-12 and revised after three adversarial review cycles the same day.

## Date
2026-11-12

## Context
- The owner asked for a Next.js frontend and a backend.
- Instante needs long-running work whatever else is decided: reading a catalog of company boards on a schedule, AI calls that take tens of seconds, resume imports, Typst renders and daily retention.
- Next.js describes its server features as "not a full backend replacement". Hosts that run Route Handlers as functions cut long-running ones off ([backend note](../research/backend.md#a-separate-backend-is-justified)).
- `AGENTS.md` keeps database credentials and secrets out of the frontend.
- Uploaded resumes and third-party posting HTML are hostile input, parsed by large libraries (pdf.js inside unpdf, mammoth, turndown). Node documents its permission model as a guard for trusted code, not a security boundary against malicious code. A child process running as the backend's own user can read the parent's environment and with it every secret.

## Decision
- **Next.js** (`apps/web`) draws pages and forms. It holds no secrets, runs no SQL, calls no model and fetches no job board.
- **The backend** (`apps/backend`, `ROLE=all`) owns data, rules, AI calls and fetching. In v1 it's one process serving the HTTP API and running the pg-boss worker; the same image can run as `ROLE=api` and `ROLE=worker` once a measurement shows the worker slowing the API.
- **The document service** (`apps/backend`, `ROLE=documents`), the same image run as its own private process:
  - **What it does:** parses uploads (PDF, DOCX) and posting HTML, and renders PDFs with Typst.
  - **What it can't reach:** it holds no secrets in its environment, the database's firewall doesn't admit it, and its outbound network is closed where the host allows.
  - **How it's called:** only the backend calls it, sending bytes over the private network and receiving text, JSON or a PDF.
  - **Inside it,** each job runs in a child process under Node's permission model (file reads limited to the input; no writes, child processes or workers), with a heap limit, input caps, a timeout and a kill. That's a seat belt against bugs and runaway inputs, not the security boundary. Typst runs with `--root` set to the job's folder, packages offline and an address-space limit.
- **Network:** the browser reaches the backend only through Next.js's same-origin rewrite. In the recommended hosting model, the backend, the document service and the database sit on a private network ([ADR-005](ADR-005-same-origin-rewrite-and-typed-contract.md)).

## What the separation protects, and what it doesn't
- **Next.js:** a remote-code-execution bug there doesn't hand over the database credentials or the Anthropic key. But Next.js still handles every signed-in person's Supabase session and renders their data, so it's patched the day a security release lands, and the phase 2 threat model treats it as a holder of live sessions.
- **The document service:** a code-execution bug in a parser gives an attacker that service only. It has no secrets and no database access, so the attacker sees the document in flight and, if the host can't close outbound network, can send that one document out. That's the accepted residual risk.

## Alternatives considered

| Option | Why not |
|---|---|
| Next.js Route Handlers and Server Actions plus a worker | Puts the database and AI credentials in the internet-facing process; a worker is still needed |
| Parsing in child processes of the backend, guarded by Node's permission model | Not a security boundary (Node's own documentation); a parser exploit could read the backend's environment |
| Child processes under a separate operating-system user inside the backend's container | Needs a root supervisor or setuid helper in the image, and depends on the host; the document service gives the same separation with plain deployment |
| Separate API and worker processes from day one | More moving parts and memory for one person; split later on a measured trigger |

## Consequences
- **Processes:** three long-running ones (web, backend, document service) from two images (web and backend), plus short-lived children.
- **Tests:** business rules are tested without the Next.js runtime.
- **Host requirements:** the vendor criteria require private networking for the document service and a database firewall that admits only the backend.
- **Acceptance tests on the production image:** the document service's environment holds no secrets, it can't open a connection to the database, and a child can't start a process.

## Doubts raised
Single-model reviews; the owner chose to skip a cross-model second opinion.
- **Cycle 1, "the split's protection was overstated":** valid. Restated above.
- **Cycle 1, "several flows had no process; the reason to split API and worker didn't hold":** valid. One backend process, with every route and queue assigned in [`architecture.md`](../architecture.md).
- **Cycle 1, "the worker parses hostile input with all the secrets":** valid. At first moved to child processes.
- **Cycle 2, "an empty environment doesn't isolate a same-user child":** valid. The Node permission model was added, which cycle 3 showed wasn't enough (next).
- **Cycle 3, "Node's permission model is a seat belt for trusted code, not a boundary"** (blocker): valid. Hostile parsing moved to a document service with no secrets and no database route, and the residual risk is restated.

## Revisit when
- The worker measurably slows API responses: split API and worker.
- The host can't give the document service private networking or keep it away from the database: reopen this decision before building.
- A parser advisory lands: patch the same day.
