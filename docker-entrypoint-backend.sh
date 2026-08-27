#!/bin/sh
set -eu

#!/bin/sh
set -eu

# The Node service handles both staff login (/api/login) and the AI concierge
# (/api/chat), so it must always run. If AI_API_KEY is unset, /api/chat replies
# 503 and the frontend falls back to on-device answers; login still works.
echo "[backend] starting Node concierge + login proxy"
node /app/server.js &
