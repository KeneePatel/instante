# Supabase: the two projects, their settings and the sign-in check

The owner's steps from the accounts spec's [Supabase set-up](../specs/accounts.md#the-supabase-set-up-owner-steps-written-up-as-docsrunbookssupabasemd), written out. [ADR-004](../decisions/ADR-004-supabase-auth.md) says why sign-in works this way.

## When

- **The development project:** at A1, now. `scripts/supabase-check.sh` then confirms what ADR-004 read from Supabase's source, before any sign-in code exists (accounts spec 1).
- **The production project:** before O2, in Canada (Central). It isn't made earlier because a Free project left idle is paused (R8; the owner's choice, 2026-11-23).

## Once, before the first project

1. Turn on two-factor sign-in for your Supabase account, and keep its recovery codes offline, not in a cloud note ([threat model](../threat-model.md)).
2. Accept Supabase's data-processing terms for the organisation ([architecture](../architecture.md), "Processors").

## Make a project

1. A new project on the Free plan:
   - development: any name, such as `instante-development`;
   - production: `instante-production`, in Canada (Central).

   Instante never connects to the project's database, so let the dashboard generate its password and don't keep it.
2. In the dashboard, for the project:
   - **Sign In / Providers:**
     - "Allow new users to sign up" off, and anonymous sign-ins off;
     - Email on, with "Email OTP length" 8 and "Email OTP expiration" 600 seconds;
     - no other provider.
   - **Email templates:** the Magic Link template shows only the code (`{{ .Token }}`), with no link.
   - **Multi-factor:** authenticator-app (TOTP) factors on, the default.
   - **JWT signing keys:** asymmetric ES256, with the access-token expiry left at 3,600 seconds.
   - **The site URL:** `http://localhost:3000` for development, `http://instante.localhost:4310` for production.
3. Copy the project URL (`https://<ref>.supabase.co`) and the publishable key (`sb_publishable_...`). The secret key is never copied anywhere: not into Instante, CI, a file on the Mac or the check. For the check you type both values when it asks. Later, development's go into `.env`, and production's into `instante config`.
4. Make your user:
   1. Add a user with your email address and a long random password that you don't keep (no Instante sign-in uses it), with "Auto confirm" on.
   2. Copy the user id. It's also printed by the check. At O2 it goes into `instante cli users add <email> <user-id>`.

## The check (A1)

From the repository:

```bash
bash scripts/supabase-check.sh
```

It asks, one line at a time:
1. the project URL;
2. the publishable key;
3. your email address;
4. Instante's address (press Enter at A1);
5. the 8-digit code Supabase emails you;
6. the 6-digit code from your authenticator app.

The first time, before the last question, it shows a key and an `otpauth://` link. Add them to your authenticator app then. They're shown only once, so keep them nowhere else. The factor it enrols is the project's real one: you'll use it again to sign in to Instante on that project.

It passes when it prints these lines and exits with 0:

```text
user id: <your user id>
after the email code: aal1
after the authenticator: aal2
```

The last line is what A1 needs. Any other ending reopens ADR-004 before sign-in is built, so give the agent what the check printed. The check prints no token, saves nothing and signs its own session out.

If it stops:

| It says | What to do |
|---|---|
| `won't send another email yet ... 2 an hour` | Supabase's built-in email sends 2 an hour. Wait, then run it again |
| `didn't send a code` | The user doesn't exist, or wasn't confirmed: with sign-ups off, an unconfirmed user counts as new and is refused. Make the user again with "Auto confirm" on |
| `should be 8 digits` | Set "Email OTP length" to 8 |
| `didn't take the code` | The code is wrong or more than 600 seconds old, or a newer one replaced it. Run it again |
| `didn't take the authenticator's code` | Check the app's clock, and wait for the next code |
| `that's the secret key` | Give the publishable key; the secret key stays in the dashboard |

**A lost authenticator:** remove the user's factor in the dashboard. The next check, or sign-in, enrols a new one.

**A paused project (R8):** restore it from the dashboard. If it pauses more than once a quarter, that's R8's trigger for moving to Pro.

## O2: Instante's refusals (accounts spec 4)

With production made and configured (`instante config`), and Instante running, run the check against production and give `http://instante.localhost:4310` as Instante's address. The check then also prints what `GET /api/me` answers to each token. Each run sends one email, and Supabase sends 2 an hour, so space the runs out.

1. **Before** `instante cli users add`, a run should end with:
   ```text
   Instante, an aal1 token: HTTP 401 unauthenticated
   Instante, an aal2 token: HTTP 403 unknown_account
   ```
2. After `instante cli users add <email> <user-id>`, sign in in the browser as O2 describes. `GET /api/me` returns your account there.
3. After `instante cli users disable <email>`, a run should end with `Instante, an aal2 token: HTTP 403 account_disabled`. Then run `instante cli users enable <email>`.
