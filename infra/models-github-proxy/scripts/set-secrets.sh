#!/usr/bin/env bash
# Sets the OAuth client secrets of the sign-in broker as GitHub repository secrets, one at a time.
#
#   infra/models-github-proxy/scripts/set-secrets.sh [--repo owner/repo] [--dry-run]
#
# For each of the three secrets it asks for the value with HIDDEN input (read -rs): nothing is shown
# on screen, nothing is written to the shell history, and the value goes to `gh secret set NAME`
# through standard input, so it never appears in the process list or on a command line either.
# Pressing Enter skips a secret (a secret that is already set is left as it is).
# Afterwards it can start the "Deploy Cloudflare Worker" workflow, wait for it, and print which
# sign-in providers the live Worker has configured (check-status.mjs).
#
# Works with bash on Linux, macOS (bash 3.2) and Git Bash on Windows. Needs the GitHub CLI (gh),
# logged in with `gh auth login`, and node (for the final check).
#
# Options:
#   --repo owner/repo   the repository (default: the one `gh repo view` finds from the current folder)
#   --dry-run           print what would be done; ask nothing, run nothing
#   --deploy|--no-deploy  answer the "run the deploy now?" question (default: ask)
#   --no-check          do not run check-status.mjs at the end
#   --stdin             read the three values from standard input, one per line, instead of asking
#                       (a blank line skips one); for scripts and password managers, with a pipe.
#                       Values still never appear on a command line.
#   -h, --help          this text
#
# Environment: SET_SECRETS_POLL_SECONDS (default 3) is the pause while waiting for the new run.

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
workflow_file="deploy-worker.yml"
poll_seconds=${SET_SECRETS_POLL_SECONDS:-3}

dry_run=0
from_stdin=0
run_check=1
deploy_choice="ask"
repo=""

# The three repository secrets, in the order they are asked. GitHub forbids secret names that start
# with GITHUB_, so the GitHub App's secret is GH_APP_CLIENT_SECRET; the deploy uploads it to the
# Worker as GITHUB_APP_CLIENT_SECRET.
secret_names=("GOOGLE_OAUTH_CLIENT_SECRET" "MICROSOFT_OAUTH_CLIENT_SECRET" "GH_APP_CLIENT_SECRET")
secret_labels=("Google: client secret del client OAuth" "Microsoft: client secret (colonna VALORE, non l'ID del segreto)" "GitHub: client secret della GitHub App")

die() {
  printf 'Errore: %s\n' "$1" >&2
  exit "${2:-1}"
}

usage() {
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --stdin) from_stdin=1 ;;
    --deploy) deploy_choice="yes" ;;
    --no-deploy) deploy_choice="no" ;;
    --no-check) run_check=0 ;;
    --repo)
      [ $# -ge 2 ] || die "--repo vuole owner/repo" 64
      repo=$2
      shift
      ;;
    --repo=*) repo=${1#--repo=} ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "opzione sconosciuta: $1 (usa --help)" 64 ;;
  esac
  shift
done

if [ -n "$repo" ]; then
  repo_re='^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'
  [[ $repo =~ $repo_re ]] || die "--repo deve essere nella forma owner/repo" 64
fi

# --- dry run: describe, never ask, never call gh -------------------------------------------------
if [ "$dry_run" -eq 1 ]; then
  shown_repo=${repo:-"<owner/repo, ricavato da 'gh repo view'>"}
  echo "[dry-run] Non chiedo nessun segreto e non eseguo nessun comando."
  echo "Repository: $shown_repo"
  echo
  index=0
  while [ "$index" -lt "${#secret_names[@]}" ]; do
    echo "$((index + 1)). ${secret_names[$index]}"
    echo "   chiederei: ${secret_labels[$index]} (input nascosto, Invio = salta)"
    echo "   poi eseguirei: gh secret set ${secret_names[$index]} --repo $shown_repo   (valore da stdin, mai in riga di comando)"
    index=$((index + 1))
  done
  echo
  case "$deploy_choice" in
    no) echo "Non lancerei il deploy (--no-deploy)." ;;
    *)
      if [ "$deploy_choice" = "ask" ]; then
        echo "Chiederei se lanciare il deploy; se si':"
      else
        echo "Lancerei il deploy:"
      fi
      echo "   gh workflow run $workflow_file --repo $shown_repo"
      echo "   gh run watch <id della nuova esecuzione> --repo $shown_repo --exit-status"
      ;;
  esac
  if [ "$run_check" -eq 1 ]; then
    echo "Infine: node $script_dir/check-status.mjs   (stato di Google, Microsoft e GitHub sul Worker)"
  fi
  exit 0
fi

# --- real run --------------------------------------------------------------------------------------
command -v gh >/dev/null 2>&1 || die "manca il GitHub CLI (gh): https://cli.github.com/"
gh auth status >/dev/null 2>&1 || die "gh non e' autenticato: esegui prima 'gh auth login'"
if [ "$from_stdin" -eq 0 ] && [ ! -t 0 ]; then
  die "servono un terminale interattivo (input nascosto) oppure l'opzione --stdin con una pipe" 64
fi

if [ -z "$repo" ]; then
  repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) || die "non riesco a ricavare il repository: usa --repo owner/repo"
fi

existing=$(gh secret list --repo "$repo" --json name --jq '.[].name' 2>/dev/null || true)
secret_value=""

# Reads one value into $secret_value: hidden when typed, the next line of stdin with --stdin.
read_secret() {
  secret_value=""
  if [ "$from_stdin" -eq 1 ]; then
    IFS= read -r secret_value || secret_value=""
  else
    printf '%s' "$1" >&2
    IFS= read -rs secret_value || secret_value=""
    printf '\n' >&2
  fi
  # Pasting from Windows can add a carriage return; surrounding spaces are never part of a secret.
  secret_value=${secret_value//$'\r'/}
  secret_value="${secret_value#"${secret_value%%[![:space:]]*}"}"
  secret_value="${secret_value%"${secret_value##*[![:space:]]}"}"
}

looks_like_microsoft_secret_id() {
  local guid_re='^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'
  [[ $1 =~ $guid_re ]]
}

set_count=0
index=0
while [ "$index" -lt "${#secret_names[@]}" ]; do
  name=${secret_names[$index]}
  label=${secret_labels[$index]}
  note="Invio = salta"
  case $'\n'"$existing"$'\n' in
    *$'\n'"$name"$'\n'*) note="gia' impostato, Invio = lascia com'e'" ;;
  esac
  read_secret "[$((index + 1))/${#secret_names[@]}] $label ($name; input nascosto; $note): "

  if [ -z "$secret_value" ]; then
    echo "    $name: saltato." >&2
  elif [ "$name" = "MICROSOFT_OAUTH_CLIENT_SECRET" ] && looks_like_microsoft_secret_id "$secret_value"; then
    echo "    $name: questo sembra l'ID del segreto, non il VALORE. Saltato: rilancia e incolla la colonna Valore." >&2
  else
    if printf '%s' "$secret_value" | gh secret set "$name" --repo "$repo" >/dev/null; then
      echo "    $name: impostato su $repo." >&2
      set_count=$((set_count + 1))
    else
      secret_value=""
      die "gh secret set $name non e' riuscito (permessi sul repository?)"
    fi
  fi
  secret_value=""
  index=$((index + 1))
done
echo "Segreti impostati ora: $set_count." >&2

# --- deploy ------------------------------------------------------------------------------------------
latest_run_id() {
  gh run list --workflow "$workflow_file" --repo "$repo" --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true
}

deploy_now() {
  local before after attempt
  before=$(latest_run_id)
  gh workflow run "$workflow_file" --repo "$repo" || die "non riesco ad avviare $workflow_file (il file deve essere sul ramo principale e gh deve avere il permesso 'workflow')"
  after=""
  attempt=0
  while [ "$attempt" -lt 20 ]; do
    sleep "$poll_seconds"
    after=$(latest_run_id)
    if [ -n "$after" ] && [ "$after" != "$before" ]; then
      break
    fi
    attempt=$((attempt + 1))
  done
  if [ -z "$after" ] || [ "$after" = "$before" ]; then
    die "non vedo partire la nuova esecuzione: guarda la scheda Actions del repository"
  fi
  gh run watch "$after" --repo "$repo" --exit-status || die "il deploy e' fallito: apri l'esecuzione $after nella scheda Actions"
  echo "Deploy completato." >&2
}

if [ "$deploy_choice" = "ask" ]; then
  if [ "$from_stdin" -eq 1 ]; then
    deploy_choice="no"
  else
    printf 'Lancio ora il deploy del Worker (gh workflow run %s)? [s/N] ' "$workflow_file" >&2
    IFS= read -r answer || answer=""
    case "$answer" in
      [sSyY]*) deploy_choice="yes" ;;
      *) deploy_choice="no" ;;
    esac
  fi
fi
if [ "$deploy_choice" = "yes" ]; then
  deploy_now
else
  echo "Deploy non lanciato: i segreti nuovi arrivano nel Worker al prossimo deploy (gh workflow run $workflow_file)." >&2
fi

# --- check -------------------------------------------------------------------------------------------
if [ "$run_check" -eq 1 ]; then
  if command -v node >/dev/null 2>&1; then
    node "$script_dir/check-status.mjs" || true
  else
    echo "node non e' installato: salto il controllo finale (curl <worker>/oauth/status)." >&2
  fi
fi
