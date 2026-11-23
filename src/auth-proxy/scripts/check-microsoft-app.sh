#!/usr/bin/env bash
# Read-only check of the Microsoft app registration the Worker uses for OneDrive.
#
#   src/auth-proxy/scripts/check-microsoft-app.sh [--app-id <client id>] [--wrangler <path>]
#
# With the Azure CLI signed in (`az login --allow-no-subscriptions`), it PRINTS what the app
# registration has (`az ad app show`, `az ad app credential list`, `az ad sp show`): the sign-in
# audience, the "Web", "Single-page application" and public client redirect URIs, the delegated
# Microsoft Graph permissions and the expiry date of each client secret (never its value), and says
# which of the four expected callback URLs are missing. It never changes anything: when something is
# missing it prints the command to run, and you run it yourself.
#
# The client id and the expected callback URLs come from wrangler.toml (MICROSOFT_CLIENT_ID and the
# entries of ALLOWED_REDIRECT_URIS that end in /auth/microsoft-callback.html), so there is one source
# of truth. Works with bash on Linux, macOS (bash 3.2) and Git Bash.
#
# Exit status: 0 everything is as expected, 3 something is missing or different, 1 az could not
# read the app, 64 usage error, 127 az is not installed.

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
wrangler_toml="$script_dir/../wrangler.toml"
app_id=""

GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"
REQUIRED_PERMISSIONS=("User.Read" "Files.ReadWrite" "offline_access")
RECOMMENDED_PERMISSIONS=("openid" "profile")
EXPECTED_AUDIENCES=("AzureADandPersonalMicrosoftAccount" "PersonalMicrosoftAccount")

die() {
  printf 'Errore: %s\n' "$1" >&2
  exit "${2:-1}"
}

usage() {
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app-id)
      [ $# -ge 2 ] || die "--app-id vuole un id" 64
      app_id=$2
      shift
      ;;
    --app-id=*) app_id=${1#--app-id=} ;;
    --wrangler)
      [ $# -ge 2 ] || die "--wrangler vuole un percorso" 64
      wrangler_toml=$2
      shift
      ;;
    --wrangler=*) wrangler_toml=${1#--wrangler=} ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "opzione sconosciuta: $1 (usa --help)" 64 ;;
  esac
  shift
done

[ -r "$wrangler_toml" ] || die "non trovo $wrangler_toml" 64

# The value of a [vars] key, without the quotes.
toml_value() {
  sed -n "s/^$1[[:space:]]*=[[:space:]]*\"\\(.*\\)\"[[:space:]]*\$/\\1/p" "$wrangler_toml" | head -n 1
}

if [ -z "$app_id" ]; then
  app_id=$(toml_value MICROSOFT_CLIENT_ID)
fi
guid_re='^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'
[[ $app_id =~ $guid_re ]] || die "l'id dell'app Microsoft non e' valido (MICROSOFT_CLIENT_ID in wrangler.toml o --app-id)" 64

expected_callbacks=()
while IFS= read -r uri; do
  [ -n "$uri" ] && expected_callbacks+=("$uri")
done < <(toml_value ALLOWED_REDIRECT_URIS | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep '/auth/microsoft-callback\.html$' || true)
[ "${#expected_callbacks[@]}" -gt 0 ] || die "wrangler.toml non elenca URI /auth/microsoft-callback.html in ALLOWED_REDIRECT_URIS" 64

command -v az >/dev/null 2>&1 || die "manca l'Azure CLI (az): https://learn.microsoft.com/cli/azure/install-azure-cli" 127

# Runs az read-only, tab-separated, CRLF stripped (Git Bash); stderr kept for the error message only.
az_read() {
  local errors output
  errors=$(mktemp)
  if ! output=$(az "$@" --only-show-errors -o tsv 2>"$errors"); then
    local first
    first=$(head -n 1 "$errors" | cut -c1-200)
    rm -f "$errors"
    die "az non riesce a leggere l'app (${first:-nessun messaggio}). Hai fatto 'az login --allow-no-subscriptions'?" 1
  fi
  rm -f "$errors"
  printf '%s\n' "$output" | tr -d '\r'
}

missing=0
note_missing() {
  missing=1
}

echo "App registration Microsoft: $app_id"
echo

# --- audience -----------------------------------------------------------------------------------------
audience=$(az_read ad app show --id "$app_id" --query signInAudience)
echo "Tipi di account supportati (signInAudience): ${audience:-<vuoto>}"
audience_ok=0
for wanted in "${EXPECTED_AUDIENCES[@]}"; do
  [ "$audience" = "$wanted" ] && audience_ok=1
done
if [ "$audience_ok" -eq 1 ]; then
  echo "  OK: include gli account Microsoft personali (il Worker usa l'authority 'common')."
else
  echo "  DA CORREGGERE: servono gli account personali. Comando (lo lanci tu):"
  echo "    az ad app update --id $app_id --sign-in-audience AzureADandPersonalMicrosoftAccount"
  note_missing
fi
echo

# --- redirect URIs ------------------------------------------------------------------------------------
web_uris=$(az_read ad app show --id "$app_id" --query "web.redirectUris")
spa_uris=$(az_read ad app show --id "$app_id" --query "spa.redirectUris")
public_uris=$(az_read ad app show --id "$app_id" --query "publicClient.redirectUris")

has_line() {
  printf '%s\n' "$2" | tr '\t' '\n' | grep -Fxq -- "$1"
}

echo "URI di reindirizzamento, piattaforma Web (quelli del Worker):"
missing_uris=()
for uri in "${expected_callbacks[@]}"; do
  if has_line "$uri" "$web_uris"; then
    echo "  OK        $uri"
  elif has_line "$uri" "$spa_uris"; then
    echo "  SBAGLIATA $uri (e' sotto 'Single-page application': il refresh token durerebbe 24 ore; serve la piattaforma Web)"
    missing_uris+=("$uri")
    note_missing
  else
    echo "  MANCA     $uri"
    missing_uris+=("$uri")
    note_missing
  fi
done
extra_web=$(printf '%s\n' "$web_uris" | tr '\t' '\n' | grep -v '^$' || true)
for uri in "${expected_callbacks[@]}"; do
  extra_web=$(printf '%s\n' "$extra_web" | grep -Fvx -- "$uri" || true)
done
if [ -n "$extra_web" ]; then
  echo "  Altri URI Web gia' presenti (da conservare):"
  printf '%s\n' "$extra_web" | sed 's/^/    /'
fi
echo
echo "URI 'Single-page application' (non vengono toccati: servono al collegamento MSAL attuale):"
if [ -n "$spa_uris" ]; then printf '%s\n' "$spa_uris" | tr '\t' '\n' | sed 's/^/    /'; else echo "    (nessuno)"; fi
echo "URI 'Mobile and desktop' (public client):"
if [ -n "$public_uris" ]; then printf '%s\n' "$public_uris" | tr '\t' '\n' | sed 's/^/    /'; else echo "    (nessuno)"; fi

if [ "${#missing_uris[@]}" -gt 0 ]; then
  # --web-redirect-uris REPLACES the whole list: the command printed here merges what is there with what is missing.
  merged=()
  while IFS= read -r uri; do
    [ -n "$uri" ] && merged+=("$uri")
  done < <(printf '%s\n' "$web_uris" | tr '\t' '\n' | grep -v '^$' || true)
  for uri in "${missing_uris[@]}"; do
    merged+=("$uri")
  done
  echo
  echo "  Per aggiungere i mancanti SENZA perdere quelli esistenti (--web-redirect-uris sostituisce l'intera lista), lanci tu:"
  printf '    az ad app update --id %s --web-redirect-uris' "$app_id"
  printf ' %s' "${merged[@]}"
  echo
fi
echo

# --- delegated permissions --------------------------------------------------------------------------------
graph_scopes=$(az_read ad sp show --id "$GRAPH_APP_ID" --query "oauth2PermissionScopes[].[id,value]")
declared_ids=$(az_read ad app show --id "$app_id" --query "requiredResourceAccess[?resourceAppId=='$GRAPH_APP_ID'].resourceAccess[] | [?type=='Scope'].id")

name_of() {
  printf '%s\n' "$graph_scopes" | awk -F'\t' -v id="$1" 'tolower($1) == tolower(id) { print $2; exit }'
}

declared_names=""
echo "Permessi delegati di Microsoft Graph richiesti dall'app:"
while IFS= read -r id; do
  [ -n "$id" ] || continue
  name=$(name_of "$id")
  if [ -n "$name" ]; then
    declared_names="$declared_names $name"
    echo "    $name"
  else
    echo "    (id sconosciuto: $id)"
  fi
done < <(printf '%s\n' "$declared_ids" | tr '\t' '\n')
[ -n "$declared_names" ] || echo "    (nessuno)"

permission_missing=()
for wanted in "${REQUIRED_PERMISSIONS[@]}"; do
  case " $declared_names " in *" $wanted "*) ;; *) permission_missing+=("$wanted") ;; esac
done
if [ "${#permission_missing[@]}" -gt 0 ]; then
  echo "  MANCANO (necessari): ${permission_missing[*]}"
  note_missing
else
  echo "  OK: User.Read, Files.ReadWrite e offline_access ci sono."
fi
recommended_missing=()
for wanted in "${RECOMMENDED_PERMISSIONS[@]}"; do
  case " $declared_names " in *" $wanted "*) ;; *) recommended_missing+=("$wanted") ;; esac
done
if [ "${#recommended_missing[@]}" -gt 0 ]; then
  echo "  Mancano (consigliati, il sito li chiede): ${recommended_missing[*]}"
fi
if [ "${#permission_missing[@]}" -gt 0 ] || [ "${#recommended_missing[@]}" -gt 0 ]; then
  echo "  Per aggiungerli lanci tu, per ciascun permesso (l'id si ricava, non si ricopia a mano), senza 'admin-consent':"
  echo "    az ad sp show --id $GRAPH_APP_ID --query \"oauth2PermissionScopes[?value=='<NOME>'].id | [0]\" -o tsv"
  echo "    az ad app permission add --id $app_id --api $GRAPH_APP_ID --api-permissions <ID>=Scope"
fi
echo

# --- client secrets (metadata only) ---------------------------------------------------------------------------
echo "Client secret (solo nome e scadenza; il valore non e' leggibile):"
credentials=$(az_read ad app credential list --id "$app_id" --query "[].[displayName,endDateTime]")
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ -z "$credentials" ]; then
  echo "    (nessun client secret: il Worker non puo' rinnovare i token Microsoft)"
  note_missing
else
  while IFS=$'\t' read -r display ends; do
    [ -n "$ends" ] || continue
    state="valido"
    # ISO 8601 dates in UTC compare correctly as text.
    if [[ "$ends" < "$now" ]]; then
      state="SCADUTO"
      note_missing
    fi
    echo "    ${display:-<senza nome>}: scade il $ends ($state)"
  done < <(printf '%s\n' "$credentials")
fi
echo

if [ "$missing" -eq 0 ]; then
  echo "Tutto come previsto."
  exit 0
fi
echo "Qualcosa manca o e' diverso: vedi sopra. Questo script non ha modificato nulla."
exit 3
