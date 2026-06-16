#!/usr/bin/env bash
# Spustí server tak, aby byl dostupný i z telefonu na stejné Wi-Fi.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"

# LAN IP Macu (Wi-Fi bývá en0, fallback en1)
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '127.0.0.1')"

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "⚠️  ANTHROPIC_API_KEY není nastaven — analýza vrátí chybu."
  echo "    Spusť nejdřív:  export ANTHROPIC_API_KEY=\"sk-ant-...\""
  echo
fi

echo "📱 Na iPhonu (stejná Wi-Fi) otevři:  http://${IP}:${PORT}"
echo "💻 Na tomhle Macu:                   http://127.0.0.1:${PORT}"
echo "   (macOS se může zeptat na povolení příchozích spojení → Povolit)"
echo

exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "${PORT}"
