#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Mycelium-for-Speckle — one-command installer (macOS / Linux / WSL)
#
# One-liner (no clone needed):
#   curl -fsSL https://raw.githubusercontent.com/thomhoffer-arch/Mycelium-for-Speckle/main/install.sh | bash
#
# Or, from a checkout:
#   ./install.sh
#
# It will:
#   1. ensure Node.js >= 18 (bootstrapping it via nvm if missing),
#   2. fetch the project (or use the current checkout),
#   3. install `mycelium-for-speckle` + `…-webhook` onto your PATH,
#   4. verify the install by running the offline conformance suite,
#   5. print next steps.
#
# Env knobs:
#   MYCELIUM_DIR   where to install when cloning   (default: ~/.mycelium-for-speckle)
#   MYCELIUM_REF   git ref to install              (default: main)
#   NO_NODE_BOOTSTRAP=1   fail instead of installing Node via nvm
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_URL="https://github.com/thomhoffer-arch/Mycelium-for-Speckle.git"
APP_NAME="mycelium-for-speckle"
INSTALL_DIR="${MYCELIUM_DIR:-$HOME/.${APP_NAME}}"
REF="${MYCELIUM_REF:-main}"
MIN_NODE_MAJOR=18

# ── pretty output ────────────────────────────────────────────────────────────
if [ -t 1 ]; then BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else BOLD=""; GREEN=""; YELLOW=""; RED=""; DIM=""; RESET=""; fi
say()  { printf '%s\n' "${BOLD}▸ $*${RESET}"; }
ok()   { printf '%s\n' "${GREEN}✓ $*${RESET}"; }
warn() { printf '%s\n' "${YELLOW}! $*${RESET}"; }
die()  { printf '%s\n' "${RED}✗ $*${RESET}" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ── 1. Node.js >= 18 ─────────────────────────────────────────────────────────
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+)\..*/\1/'; }

ensure_node() {
  if have node && [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
    ok "Node.js $(node -v) detected"
    return
  fi
  if have node; then
    warn "Node.js $(node -v) is too old (need >= ${MIN_NODE_MAJOR})."
  else
    warn "Node.js not found."
  fi
  if [ "${NO_NODE_BOOTSTRAP:-0}" = "1" ]; then
    die "Install Node.js >= ${MIN_NODE_MAJOR} (https://nodejs.org) and re-run."
  fi

  say "Bootstrapping Node.js via nvm…"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    have curl || have wget || die "Need curl or wget to install nvm."
    if have curl; then
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    else
      wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    fi
  fi
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm use --lts
  have node && [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null \
    || die "Node.js bootstrap failed — install it manually from https://nodejs.org"
  ok "Node.js $(node -v) ready"
}

# ── 2. Locate or fetch the project ───────────────────────────────────────────
locate_app() {
  # Running from inside a checkout? (curl|bash leaves BASH_SOURCE unhelpful, so
  # also accept the current directory.)
  local here=""
  if [ -n "${BASH_SOURCE:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  fi
  for d in "$here" "$PWD"; do
    if [ -n "$d" ] && [ -f "$d/connector.mjs" ] && [ -f "$d/vendor/mycelium-sdk.mjs" ]; then
      APP_DIR="$d"
      ok "Using checkout at $APP_DIR"
      return
    fi
  done

  say "Fetching $APP_NAME into $INSTALL_DIR…"
  have git || die "git is required to fetch the project (or run ./install.sh from a checkout)."
  if [ -d "$INSTALL_DIR/.git" ]; then
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$REF" >/dev/null 2>&1
    git -C "$INSTALL_DIR" checkout -q FETCH_HEAD
  else
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$INSTALL_DIR" >/dev/null 2>&1 \
      || git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" >/dev/null 2>&1 \
      || die "Failed to clone $REPO_URL"
  fi
  APP_DIR="$INSTALL_DIR"
  ok "Fetched into $APP_DIR"
}

# ── 3. Install onto PATH ─────────────────────────────────────────────────────
# Prefer `npm link` (uses the package's bin entries). If the npm global prefix
# isn't writable, fall back to launcher scripts in a user-writable bin dir.
PATH_NOTE=""

install_via_launchers() {
  local bindir=""
  for cand in "/usr/local/bin" "$HOME/.local/bin"; do
    if [ -d "$cand" ] && [ -w "$cand" ]; then bindir="$cand"; break; fi
  done
  if [ -z "$bindir" ]; then bindir="$HOME/.local/bin"; mkdir -p "$bindir"; fi

  cat > "$bindir/$APP_NAME" <<EOF
#!/usr/bin/env bash
exec node "$APP_DIR/connector.mjs" "\$@"
EOF
  cat > "$bindir/$APP_NAME-webhook" <<EOF
#!/usr/bin/env bash
exec node "$APP_DIR/src/webhook.mjs" "\$@"
EOF
  chmod +x "$bindir/$APP_NAME" "$bindir/$APP_NAME-webhook"
  ok "Installed launchers in $bindir"

  case ":$PATH:" in
    *":$bindir:"*) : ;;
    *) PATH_NOTE="$bindir is not on your PATH yet. Add it:
    echo 'export PATH=\"$bindir:\$PATH\"' >> ~/.bashrc   # or ~/.zshrc, then restart your shell" ;;
  esac
}

install_cli() {
  say "Installing the $APP_NAME command…"
  ( cd "$APP_DIR" && npm link >/dev/null 2>&1 ) && have "$APP_NAME" \
    && { ok "Linked via npm ($(command -v "$APP_NAME"))"; return; }
  warn "npm link unavailable or global prefix not writable — using launcher scripts."
  install_via_launchers
}

# ── 4. Verify ────────────────────────────────────────────────────────────────
verify() {
  say "Verifying (offline conformance suite)…"
  ( cd "$APP_DIR" && node --test ) >/dev/null 2>&1 \
    && ok "All conformance checks pass" \
    || die "Conformance suite failed — see: cd \"$APP_DIR\" && npm test"

  if have "$APP_NAME"; then
    "$APP_NAME" --version >/dev/null 2>&1 && ok "Command works: $(command -v "$APP_NAME") ($("$APP_NAME" --version))"
  else
    node "$APP_DIR/connector.mjs" --version >/dev/null 2>&1 && ok "CLI runs via: node \"$APP_DIR/connector.mjs\""
  fi
}

main() {
  printf '%s\n\n' "${BOLD}Installing Mycelium-for-Speckle${RESET}"
  ensure_node
  locate_app
  install_cli
  verify

  printf '\n%s\n' "${GREEN}${BOLD}Done.${RESET}"
  if [ -n "$PATH_NOTE" ]; then printf '\n%s\n' "${YELLOW}$PATH_NOTE${RESET}"; fi
  cat <<EOF

${BOLD}Try it now (offline demo, no setup):${RESET}
    ${DIM}# full conformance report${RESET}
    $APP_NAME
    ${DIM}# one spine record per line${RESET}
    $APP_NAME --jsonl

${BOLD}Go live against your Speckle project:${RESET}
    export SPECKLE_SERVER="https://app.speckle.systems"
    export SPECKLE_TOKEN="<personal access token — scope: Streams read>"
    export SPECKLE_PROJECT_ID="<project (stream) id>"
    export SPECKLE_MODEL_ID="<model (branch) id>"
    $APP_NAME --out spine.json

${BOLD}Push-live webhook receiver (no polling):${RESET}
    SPECKLE_WEBHOOK_SECRET="<shared secret>" $APP_NAME-webhook   ${DIM}# listens on :3000${RESET}

Help:  $APP_NAME --help
EOF
}

main "$@"
