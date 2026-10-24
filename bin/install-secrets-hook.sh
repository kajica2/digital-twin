#!/usr/bin/env bash
# bin/install-secrets-hook.sh
#
# A CI gate reports a leak after it is public. A pre-push hook refuses the
# push, which is the only place a secret can still be stopped. The repo is
# PUBLIC (github.com/kajica2/digital-twin), so "stop it before the push" is
# the whole game: force-pushing a rewritten history is the only undo, and it
# is not available to anyone who already cloned or mirrored the repo.
#
# What it installs: .git/hooks/pre-push, which runs
# lib/secrets-guard.test.js with full history before anything leaves the
# machine. Non-zero aborts the push. Bypass (deliberately, never by habit):
#
#   git push --no-verify
#
# Idempotent, and it refuses to overwrite a hook it did not write.
#
# Usage:
#   bin/install-secrets-hook.sh            # install / refresh
#   bin/install-secrets-hook.sh --remove   # uninstall

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$REPO/.git/hooks/pre-push"
MARKER="# digital-twin secrets guard"

if [ "${1:-}" = "--remove" ]; then
    if [ -f "$HOOK" ] && grep -qF "$MARKER" "$HOOK"; then
        rm -f "$HOOK"
        echo "removed $HOOK"
    else
        echo "nothing to remove (no secrets-guard hook at $HOOK)"
    fi
    exit 0
fi

if [ ! -d "$REPO/.git" ]; then
    echo "not a git checkout: $REPO" >&2
    exit 1
fi

if [ -f "$HOOK" ] && ! grep -qF "$MARKER" "$HOOK"; then
    echo "refusing to overwrite $HOOK — it is not this repo's hook." >&2
    echo "move it aside or merge the guard manually:" >&2
    echo "  node lib/secrets-guard.test.js" >&2
    exit 1
fi

mkdir -p "$REPO/.git/hooks"
cat > "$HOOK" <<'HOOK_EOF'
#!/usr/bin/env bash
# digital-twin secrets guard
#
# This repo is public: a cookie pushed once cannot be taken back. Runs the
# guard over tracked files, the ignore rules, cookie-jar defaults and the
# whole history before the push leaves the machine.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
if [ -f "$ROOT/lib/secrets-guard.test.js" ] && command -v node >/dev/null 2>&1; then
    cd "$ROOT"
    node lib/secrets-guard.test.js || {
        echo >&2
        echo "push refused: the secrets guard found credential material (above)." >&2
        echo "Rotate the credential first, then remove it from the commit." >&2
        echo "Deliberate override: git push --no-verify" >&2
        exit 1
    }
fi
exit 0
HOOK_EOF
chmod +x "$HOOK"

echo "installed $HOOK"
"$HOOK" >/dev/null 2>&1 && echo "hook self-check: clean" || echo "hook self-check: guard reported findings (see node lib/secrets-guard.test.js)"
