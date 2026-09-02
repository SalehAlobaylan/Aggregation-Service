#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="$SERVICE_DIR/.youtube-runtime"

python3 -m venv "$RUNTIME_DIR"
"$RUNTIME_DIR/bin/python" -m pip install --disable-pip-version-check --upgrade pip
"$RUNTIME_DIR/bin/python" -m pip install --disable-pip-version-check \
  'yt-dlp==2026.8.19' \
  'yt-dlp-ejs==0.8.0' \
  'bgutil-ytdlp-pot-provider==1.3.1'

"$RUNTIME_DIR/bin/yt-dlp" --version
