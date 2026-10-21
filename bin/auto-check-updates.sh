#!/bin/bash
# bin/auto-check-updates.sh
# Checks for repo updates and deployed site changes

set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# The deploy target is Vercel, not GitHub Pages. The Pages project site
# (https://kajica2.github.io/digital-twin/) is a DIFFERENT deployment and
# it is not what CI's deploy-test loop checks — .github/workflows/
# pages-test.yml waits on and verifies this Vercel host.
DEPLOYED_URL="${DEPLOYED_URL:-https://digitaltwin-ebon.vercel.app}"

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
    # NOTE: the loop variable must NOT be named PATH — it would shadow
    # the shell's PATH and `curl` could not be found, so every probe
    # returned 000 and the site always looked down.
    for REL_PATH in "landing.html" "pages/landing.html" "index.html"; do
        STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$DEPLOYED_URL/$REL_PATH" 2>/dev/null || echo "000")
        if [ "$STATUS" = "200" ]; then
            echo "✓ Deployed site responding ($REL_PATH → 200 OK)"
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
