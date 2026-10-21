#!/usr/bin/env bash
set -e

echo "🚀 Setting up Digital Twin Creator OS..."

# Install root dependencies
if [ -f "package.json" ]; then
    echo "📦 Installing root dependencies..."
    npm install
fi

# Install e2e dependencies if present
if [ -d "e2e" ] && [ -f "e2e/package.json" ]; then
    echo "📦 Installing E2E test dependencies..."
    cd e2e && npm install && cd ..
fi

echo "✅ Setup complete!"
echo "🌟 To start the local server, run: node lib/serve.js --port 5173"
