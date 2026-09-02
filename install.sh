#!/usr/bin/env bash
# Installs the copilot-pat OpenCode plugin and stores a fine-grained GitHub PAT for it.
# Usage:  ./install.sh              (prompts for the token, input hidden)
#         COPILOT_PAT=github_pat_… ./install.sh
#         ./install.sh --no-verify  (skip the test request at the end)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
VERIFY=1; [ "${1:-}" = "--no-verify" ] && VERIFY=0

command -v opencode >/dev/null || { echo "opencode is not on PATH. Install it first: https://opencode.ai"; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required to edit auth.json safely"; exit 1; }

mkdir -p "$CFG/plugin" "$DATA"
cp "$HERE/copilot-pat.ts" "$CFG/plugin/copilot-pat.ts"
echo "plugin -> $CFG/plugin/copilot-pat.ts"

TOKEN="${COPILOT_PAT:-}"
if [ -z "$TOKEN" ]; then
  read -r -s -p "Paste the fine-grained PAT (github_pat_…), input is hidden: " TOKEN; echo
fi
TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
case "$TOKEN" in
  github_pat_*) ;;
  ghp_*) echo "That is a classic PAT (ghp_). GitHub refuses those for Copilot; create a fine-grained token with the 'Copilot Requests' permission."; exit 1 ;;
  *) echo "Token does not look like a fine-grained PAT (expected github_pat_…)."; exit 1 ;;
esac

AUTH="$DATA/auth.json"
[ -f "$AUTH" ] && cp "$AUTH" "$AUTH.bak.$(date +%Y%m%d-%H%M%S)"
COPILOT_PAT_INSTALL_TOKEN="$TOKEN" AUTH_FILE="$AUTH" python3 - <<'PY'
import json, os
p = os.environ["AUTH_FILE"]
d = json.load(open(p)) if os.path.exists(p) else {}
d["copilot-pat"] = {"type": "api", "key": os.environ["COPILOT_PAT_INSTALL_TOKEN"]}
with open(p, "w") as f: json.dump(d, f, indent=2)
os.chmod(p, 0o600)
print("auth  -> %s (provider copilot-pat)" % p)
PY
unset TOKEN

if [ "$VERIFY" = 1 ]; then
  echo "verifying with copilot-pat/gpt-4.1 …"
  # stdin must be closed: `opencode run` otherwise waits on an open pipe.
  if OUT="$(opencode run -m copilot-pat/gpt-4.1 "Reply with exactly: PONG" </dev/null 2>/dev/null)" && printf '%s' "$OUT" | grep -q PONG; then
    echo "OK: $OUT"
  else
    echo "verification did not return PONG. Run this for details:"
    echo "  opencode run -m copilot-pat/gpt-4.1 --print-logs 'Reply with exactly: PONG' </dev/null 2>&1 | grep copilot-pat"
    exit 1
  fi
fi
echo "done. Try:  opencode -m copilot-pat/gpt-4.1     or set \"model\" as in opencode.example.jsonc"
