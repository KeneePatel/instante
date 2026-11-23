#!/usr/bin/env bash
# A1's check (docs/runbooks/supabase.md): on a Supabase project, a user made in the dashboard
# signs in with an emailed code while sign-ups are off, at `aal1`, and the authenticator step
# raises the session to `aal2` (accounts spec 1, what ADR-004 read from Supabase's source). Given
# Instante's address, it also prints what `GET /api/me` answers to each token (accounts spec 4,
# for O2).
#
# Every value comes from the terminal, never from arguments. Tokens and codes reach curl through
# its configuration on standard input and reach Node on its standard input, so no command line
# another process can read holds one, and the script prints no token. It uses only curl and
# Node, and it signs its own session out at the end.
set -euo pipefail

die() {
  printf 'supabase-check: %s\n' "$*" >&2
  exit 1
}
note() { printf '%s\n' "$*" >&2; }

command -v curl >/dev/null || die "needs curl"
command -v node >/dev/null || die "needs node"

# ask <prompt> [secret]: one line from standard input, with the prompt on standard error.
ask() {
  local reply=''
  printf '%s' "$1" >&2
  if [ "${2:-}" = secret ] && [ -t 0 ]; then
    IFS= read -r -s reply || true
    printf '\n' >&2
  else
    IFS= read -r reply || true
  fi
  printf '%s' "$reply"
}

# js <code>: runs Node with its standard input in `input`, as text, and `parse`, which gives null
# for text that isn't JSON (a reply from a proxy, say) so the caller can say what came instead.
js() {
  node -e "const parse = (text) => { try { return JSON.parse(text); } catch { return null; } }; let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => (input += d)).on('end', () => { $1 });"
}

# claim <name>: the named claim of the token on standard input (its payload isn't verified here).
claim() {
  js "const c = parse(Buffer.from(input.split('.')[1] ?? '', 'base64url').toString('utf8')) ?? {}; process.stdout.write(String(c['$1'] ?? ''));"
}

# field <path>: a field of the JSON on standard input, such as `access_token` or `totp.secret`.
field() {
  js "let v = parse(input); for (const k of '$1'.split('.')) v = v?.[k]; process.stdout.write(v == null ? '' : String(v));"
}

# The message in an error reply from Supabase's auth server, or the start of the reply itself.
message() {
  printf '%s' "$body" | js "const o = parse(input) ?? {}; process.stdout.write(String(o.msg ?? o.message ?? o.error_description ?? o.error ?? (input.slice(0, 200) || 'no reply')));"
}

# A string for a double-quoted value in curl's configuration.
quote() {
  local s=${1//\\/\\\\}
  printf '%s' "${s//\"/\\\"}"
}

# call <method> <url> <apikey or ''> <bearer token or ''> <JSON body or ''>: sets `status` and
# `body`.
call() {
  local reply
  reply=$(
    {
      printf 'url = "%s"\n' "$(quote "$2")"
      printf 'request = "%s"\n' "$1"
      if [ -n "$3" ]; then printf 'header = "apikey: %s"\n' "$(quote "$3")"; fi
      if [ -n "$4" ]; then printf 'header = "Authorization: Bearer %s"\n' "$(quote "$4")"; fi
      if [ -n "$5" ]; then
        printf 'header = "Content-Type: application/json"\n'
        printf 'data-binary = "%s"\n' "$(quote "$5")"
      fi
    } | curl --silent --show-error --max-time 30 --write-out '\n%{http_code}' --config -
  ) || die "couldn't reach $2"
  status=${reply##*$'\n'}
  body=${reply%$'\n'*}
}

# address <prompt> <empty allowed>: an http(s) address with no path, its trailing slash dropped.
address() {
  local value
  value=$(ask "$1")
  value=${value%/}
  if [ -z "$value" ] && [ "$2" = yes ]; then return 0; fi
  case $value in
    https://* | http://127.0.0.1 | http://127.0.0.1:* | http://localhost | http://localhost:* | http://*.localhost | http://*.localhost:*) ;;
    *) die "'$value' isn't an https:// address (plain http:// only for this Mac's own addresses)" ;;
  esac
  case ${value#*://} in
    '' | */* | *[[:space:]]* | *'?'* | *'#'*) die "'$value' should be just the address, with no path" ;;
  esac
  printf '%s' "$value"
}

# instante <token> <what>: prints what Instante's `GET /api/me` answers to the token.
instante() {
  call GET "$instante_url/api/me" '' "$1" ''
  local said
  said=$(printf '%s' "$body" | js "const o = parse(input) ?? {}; process.stdout.write(o.id ? 'account ' + o.id : String(o.error?.code ?? ''));")
  printf 'Instante, %s: HTTP %s %s\n' "$2" "$status" "$said"
}

note "Checks sign-in on a Supabase project (docs/runbooks/supabase.md). Nothing is saved."
url=$(address 'Project URL (https://<ref>.supabase.co): ' no)
key=$(ask 'Publishable key (sb_publishable_...): ')
case $key in
  sb_secret_*) die "that's the secret key, which never leaves the dashboard: give the publishable key" ;;
  sb_publishable_*) ;;
  *.*.*)
    role=$(printf '%s' "$key" | claim role)
    [ "$role" = anon ] || die "that key's role is '$role', not anon: give the publishable key"
    ;;
  *) die "that doesn't look like a publishable key" ;;
esac
email=$(ask 'Email address of the user you made in the dashboard: ')
case $email in
  *[[:space:]]* | '') die "'$email' isn't an email address" ;;
  ?*@?*.?*) ;;
  *) die "'$email' isn't an email address" ;;
esac
instante_url=$(address "Instante's address, to see its answers too (Enter to skip): " yes)
auth=$url/auth/v1

note "Asking Supabase to email a code to $email ..."
call POST "$auth/otp" "$key" '' "$(printf '%s' "$email" | js 'process.stdout.write(JSON.stringify({ email: input, create_user: false }));')"
case $status in
  200) ;;
  429) die "Supabase won't send another email yet ($(message)): its built-in email sends 2 an hour" ;;
  *) die "Supabase didn't send a code (HTTP $status): $(message)" ;;
esac

code=$(ask 'The 8-digit code from the email: ' secret)
case $code in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *) die "the code should be 8 digits (the runbook sets the email code's length to 8)" ;;
esac
call POST "$auth/verify" "$key" '' "$(printf '%s\n%s' "$email" "$code" | js 'const [email, token] = input.split("\n"); process.stdout.write(JSON.stringify({ type: "email", email, token }));')"
[ "$status" = 200 ] || die "Supabase didn't take the code (HTTP $status): $(message)"
access=$(printf '%s' "$body" | field access_token)
[ -n "$access" ] || die "Supabase's reply held no access token"
printf 'user id: %s\n' "$(printf '%s' "$access" | claim sub)"
printf 'after the email code: %s\n' "$(printf '%s' "$access" | claim aal)"
if [ -n "$instante_url" ]; then instante "$access" 'an aal1 token'; fi

# The user's authenticator factor: a verified one is used; unfinished enrolments are removed,
# since a new one can't reuse their name.
call GET "$auth/user" "$key" "$access" ''
[ "$status" = 200 ] || die "Supabase didn't return the user (HTTP $status): $(message)"
factors=$(printf '%s' "$body" | js 'for (const f of parse(input)?.factors ?? []) if (f.factor_type === "totp") process.stdout.write(`${f.status} ${f.id}\n`);')
factor=''
while read -r state id; do
  [ -n "$id" ] || continue
  case $id in *[!0-9a-f-]*) die "Supabase gave a factor id that isn't a UUID: $id" ;; esac
  if [ "$state" = verified ]; then
    [ -n "$factor" ] || factor=$id
  else
    call DELETE "$auth/factors/$id" "$key" "$access" ''
    [ "$status" = 200 ] || die "couldn't remove an unfinished authenticator enrolment (HTTP $status): $(message)"
    note "Removed an unfinished authenticator enrolment."
  fi
done <<EOF
$factors
EOF

if [ -z "$factor" ]; then
  call POST "$auth/factors" "$key" "$access" '{"factor_type":"totp","friendly_name":"Authenticator app","issuer":"Instante"}'
  [ "$status" = 200 ] || die "Supabase didn't enrol an authenticator (HTTP $status): $(message)"
  factor=$(printf '%s' "$body" | field id)
  case $factor in '' | *[!0-9a-f-]*) die "Supabase's enrolment gave no factor id" ;; esac
  note ''
  note 'Add this account to your authenticator app now. It shows only this once; keep it nowhere else.'
  note "  key: $(printf '%s' "$body" | field totp.secret)"
  note "  or the link: $(printf '%s' "$body" | field totp.uri)"
  note ''
fi

call POST "$auth/factors/$factor/challenge" "$key" "$access" '{}'
[ "$status" = 200 ] || die "Supabase didn't start the authenticator step (HTTP $status): $(message)"
challenge=$(printf '%s' "$body" | field id)
totp=$(ask 'The 6-digit code from your authenticator app: ' secret)
case $totp in
  [0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *) die "the authenticator's code is 6 digits" ;;
esac
call POST "$auth/factors/$factor/verify" "$key" "$access" "$(printf '%s\n%s' "$challenge" "$totp" | js 'const [challenge_id, code] = input.split("\n"); process.stdout.write(JSON.stringify({ challenge_id, code }));')"
[ "$status" = 200 ] || die "Supabase didn't take the authenticator's code (HTTP $status): $(message)"
access=$(printf '%s' "$body" | field access_token)
[ -n "$access" ] || die "Supabase's reply held no access token"
aal=$(printf '%s' "$access" | claim aal)
printf 'after the authenticator: %s\n' "$aal"
if [ -n "$instante_url" ]; then instante "$access" 'an aal2 token'; fi

call POST "$auth/logout?scope=local" "$key" "$access" ''
[ "$status" = 204 ] || note "Couldn't sign this check's session out (HTTP $status): sign the user out in the dashboard."
[ "$aal" = aal2 ] || die "the session didn't reach aal2"
note 'Done: this project signs in as ADR-004 expects.'
