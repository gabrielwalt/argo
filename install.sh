#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

chmod +x "$SCRIPT_DIR/bin/argo"

# Build the project if dist/ doesn't exist
if [ ! -d "$SCRIPT_DIR/dist" ]; then
  echo "▸ Building…"
  cd "$SCRIPT_DIR" && pnpm build
fi

sudo ln -sf "$SCRIPT_DIR/bin/argo" /usr/local/bin/argo
echo "✔ Installed: argo → /usr/local/bin/argo"
echo ""
echo "Usage:"
echo "  argo [path]      Start argo on a workspace folder"
echo "  argo list        List running workspaces"
echo "  argo stop        Stop everything"
