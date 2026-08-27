#!/bin/sh
set -eu

BASIC_AUTH_USER="${BASIC_AUTH_USER:-guest}"

if [ -z "${BASIC_AUTH_PASSWORD:-}" ]; then
  echo "BASIC_AUTH_PASSWORD is required" >&2
  exit 1
fi

htpasswd -bc /etc/nginx/.htpasswd "$BASIC_AUTH_USER" "$BASIC_AUTH_PASSWORD" >/dev/null
