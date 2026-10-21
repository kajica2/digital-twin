#!/bin/bash
# bin/auto-check-updates.sh
# Checks for repo updates and deployed site changes

set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOYED_URL="${DEPLOYED_URL:-https://kajica2.github.io/digital_twin}"

echo "[update-check] $(date '+%Y-%m-%d %H:%M:%S')"
echo "---"

# Check for new commits
cd "$REPO_DIR"
git fetch origin --quiet 2>/dev/null || true

LOCAL_HASH=$(git rev-parse HEAD 2>/dev/null)
REMOTE_HASH=$(git rev-parse origin/main 2>/dev/null)

if [ "$LOCAL_HASH" = "$REMOTE_HASH" ]; then
    echo "✓ Repo up to date (commit $(git rev-parse --short HEAD))"
else
    LOCAL_COUNT=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "?")
    echo "⚠ Repo behind: $LOCAL_COUNT commit(s) behind origin/main"
    echo "  Local:  $(git rev-parse --short HEAD)"
    echo "  Remote: $(git rev-parse --short origin/main)"
fi

# Check deployed site (try multiple paths)
if command -v curl &> /dev/null; then
    DEPLOYED_OK=false
    for PATH in "landing.html" "pages/landing.html" "index.html"; do
        STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$DEPLOYED_URL/$PATH" 2>/dev/null || echo "000")
        if [ "$STATUS" = "200" ]; then
            echo "✓ Deployed site responding ($PATH → 200 OK)"
            DEPLOYED_OK=true
            break
        fi
    done
    if [ "$DEPLOYED_OK" = "false" ]; then
        # Check root
        ROOT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$DEPLOYED_URL/" 2>/dev/null || echo "000")
        if [ "$ROOT_STATUS" = "200" ]; then
            echo "⚠ Deployed root OK, but pages may need rebuild"
        else
            echo "⚠ Deployed site not responding (tried: landing.html, pages/landing.html, index.html)"
        fi
    fi
fi

echo "---"
echo "[update-check] Done"
