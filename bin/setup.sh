#!/usr/bin/env bash
#
# setup.sh — one-shot, idempotent setup for the media toolchain.
#
# Run it as many times as you like: every step checks before it changes
# anything, and nothing here deletes user data.
#
#   bash bin/setup.sh
#
set -euo pipefail

# Resolve the repo root from THIS script's location, not the caller's cwd.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

step() {
  echo ""
  echo "──────────────────────────────────────────────────────────────"
  echo "  $1"
  echo "──────────────────────────────────────────────────────────────"
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------
# 1. System ffmpeg (and ffprobe)
# ---------------------------------------------------------------------
step "🎬 Step 1/5 — system ffmpeg"

if have ffmpeg; then
  echo "✅ ffmpeg found: $(command -v ffmpeg)"
else
  echo "⚠️  ffmpeg is not on PATH."
  if have brew; then
    echo "🍺 Installing ffmpeg with Homebrew (this can take a few minutes)..."
    brew install ffmpeg
    echo "✅ Homebrew finished installing ffmpeg."
  else
    echo ""
    echo "❌ Homebrew is not installed, so I cannot install ffmpeg for you."
    echo ""
    echo "   Install ffmpeg manually, then re-run this script:"
    echo "     • macOS (Homebrew):  brew install ffmpeg"
    echo "     • macOS (MacPorts):  sudo port install ffmpeg"
    echo "     • Debian/Ubuntu:     sudo apt-get install -y ffmpeg"
    echo "     • Fedora:            sudo dnf install -y ffmpeg"
    echo ""
    echo "   ffmpeg AND ffprobe must both end up on your PATH."
    echo ""
    exit 1
  fi
fi

if ! have ffmpeg || ! have ffprobe; then
  echo ""
  echo "❌ ffmpeg and/or ffprobe are still not both on PATH after the install."
  echo "   Check your PATH and re-run this script."
  echo ""
  exit 1
fi

echo "✅ ffmpeg:  $(command -v ffmpeg)"
echo "✅ ffprobe: $(command -v ffprobe)"
echo "   $(ffmpeg -version 2>/dev/null | head -n 1)"

# The render plan (lib/render/plan.mjs) needs libx264 plus the zoompan and
# concat filters. A build without them fails at render time, not now.
missing=""
if ! ffmpeg -hide_banner -encoders 2>/dev/null | grep -q "libx264"; then
  missing="${missing} libx264"
fi
if ! ffmpeg -hide_banner -filters 2>/dev/null | grep -qE "[[:space:]]zoompan[[:space:]]"; then
  missing="${missing} zoompan"
fi
if ! ffmpeg -hide_banner -filters 2>/dev/null | grep -qE "[[:space:]]concat[[:space:]]"; then
  missing="${missing} concat"
fi
if [ -n "${missing}" ]; then
  echo ""
  echo "❌ This ffmpeg build is missing:${missing}"
  echo "   lib/render/plan.mjs requires them to build an MP4."
  echo "   Install a full ffmpeg build (e.g. brew reinstall ffmpeg) and re-run."
  echo ""
  exit 1
fi
echo "✅ ffmpeg has libx264, zoompan and concat"

# ---------------------------------------------------------------------
# 2. Root dependencies
# ---------------------------------------------------------------------
step "📦 Step 2/5 — root dependencies"
if [ -f "package.json" ]; then
  echo "Running npm install in ${REPO_ROOT} ..."
  npm install
  echo "✅ Root dependencies installed."
else
  echo "ℹ️  No package.json in the repo root — skipping."
fi

# ---------------------------------------------------------------------
# 3. e2e dependencies
# ---------------------------------------------------------------------
step "🧪 Step 3/5 — e2e dependencies"
if [ -f "e2e/package.json" ]; then
  echo "Running npm install in ${REPO_ROOT}/e2e ..."
  npm --prefix e2e install
  echo "✅ e2e dependencies installed."
else
  echo "ℹ️  No e2e/package.json — skipping."
fi

# ---------------------------------------------------------------------
# 4. Vendored ffmpeg.wasm (download + pin)
# ---------------------------------------------------------------------
step "📦 Step 4/5 — vendored ffmpeg.wasm assets"
node bin/install-vendor.mjs
echo "✅ Vendored assets installed and pinned (vendor/ffmpeg/manifest.json)."

# ---------------------------------------------------------------------
# 5. Preflight
# ---------------------------------------------------------------------
step "🩺 Step 5/5 — preflight (bin/doctor.mjs)"
node bin/doctor.mjs

echo ""
echo "──────────────────────────────────────────────────────────────"
echo "  ✅ Setup complete!"
echo "──────────────────────────────────────────────────────────────"
echo ""
echo "Next steps:"
echo "  • Start the local server:      npm run serve"
echo "  • Run the media e2e:            npm run e2e:media"
echo "  • Open the local tool:          http://127.0.0.1:5173/pages/images-to-mov.html"
echo ""
