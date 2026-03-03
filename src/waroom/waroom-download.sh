#!/usr/bin/env bash
set -euo pipefail

# Usage: ./waroom-download.sh 2026-01
# Downloads all waroom incidents for the given month via the MCP server.
# Loads WAROOM_API_KEY from .env (next to the script) or from the environment.

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 YYYY-MM" >&2
  exit 1
fi

TARGET_MONTH="$1"

if ! [[ "$TARGET_MONTH" =~ ^[0-9]{4}-[0-9]{2}$ ]]; then
  echo "Error: argument must be in YYYY-MM format (e.g. 2026-01)" >&2
  exit 1
fi

# Load .env from the same directory as the script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  set -a
  source "${SCRIPT_DIR}/.env"
  set +a
fi

if [[ -z "${WAROOM_API_KEY:-}" ]]; then
  echo "Error: WAROOM_API_KEY is not set (check .env or environment)" >&2
  exit 1
fi

for cmd in jq npx; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is required but not found" >&2
    exit 1
  fi
done

PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUT_DIR="${PROJECT_ROOT}/output/waroom/${TARGET_MONTH}"
mkdir -p "$OUT_DIR"

# Compute from/to date range for the target month
FROM_DATE="${TARGET_MONTH}-01"
YEAR="${TARGET_MONTH%%-*}"
MONTH="${TARGET_MONTH##*-}"
# Calculate last day of month
if date -v1d +%Y 2>/dev/null 1>&2; then
  # macOS date
  TO_DATE=$(date -j -v"${MONTH}"m -v1d -v"${YEAR}"y -v+1m -v-1d +%Y-%m-%d)
else
  # GNU date
  TO_DATE=$(date -d "${FROM_DATE} +1 month -1 day" +%Y-%m-%d)
fi

# --- MCP communication helpers ---

MCP_IN=$(mktemp -u)
MCP_OUT=$(mktemp -u)
mkfifo "$MCP_IN" "$MCP_OUT"

cleanup() {
  [[ -n "${MCP_PID:-}" ]] && kill "$MCP_PID" 2>/dev/null && wait "$MCP_PID" 2>/dev/null || true
  rm -f "$MCP_IN" "$MCP_OUT"
}
trap cleanup EXIT

# Start the MCP server
WAROOM_API_KEY="$WAROOM_API_KEY" npx -y @topotal/waroom-mcp < "$MCP_IN" > "$MCP_OUT" 2>/dev/null &
MCP_PID=$!

exec 3>"$MCP_IN"   # write to MCP stdin
exec 4<"$MCP_OUT"  # read from MCP stdout

MSG_ID=0

mcp_send() {
  echo "$1" >&3
}

mcp_recv() {
  local target_id="$1"
  while IFS= read -r line <&4; do
    local id
    id=$(echo "$line" | jq -r '.id // empty' 2>/dev/null) || continue
    if [[ "$id" == "$target_id" ]]; then
      echo "$line"
      return 0
    fi
  done
  return 1
}

mcp_call_tool() {
  local tool_name="$1"
  local arguments="$2"
  MSG_ID=$((MSG_ID + 1))
  local req
  req=$(jq -cn --arg id "$MSG_ID" --arg name "$tool_name" --argjson args "$arguments" \
    '{"jsonrpc":"2.0","id":($id|tonumber),"method":"tools/call","params":{"name":$name,"arguments":$args}}')
  mcp_send "$req"
  local resp
  resp=$(mcp_recv "$MSG_ID")
  echo "$resp" | jq -r '.result.content[0].text'
}

# --- Initialize MCP handshake ---

echo "Starting MCP server..." >&2

mcp_send '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"waroom-download","version":"1.0.0"}}}'
mcp_recv 0 > /dev/null
mcp_send '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'

sleep 0.5

# --- Fetch incidents for the target month ---

echo "Fetching incidents for ${TARGET_MONTH} (${FROM_DATE} to ${TO_DATE})..." >&2

page=1
per_page=100
collected_uuids=""

while true; do
  args=$(jq -cn --arg from "$FROM_DATE" --arg to "$TO_DATE" \
    --argjson page "$page" --argjson per_page "$per_page" \
    '{from:$from, to:$to, page:$page, per_page:$per_page}')

  incidents_json=$(mcp_call_tool "waroom_get_incidents" "$args")

  # Filter to only incidents whose created_at starts with the target month
  page_uuids=$(echo "$incidents_json" | jq -r --arg month "$TARGET_MONTH" \
    '.incidents[] | select(.created_at | startswith($month)) | .uuid')

  if [[ -n "$page_uuids" ]]; then
    if [[ -n "$collected_uuids" ]]; then
      collected_uuids="${collected_uuids}"$'\n'"${page_uuids}"
    else
      collected_uuids="$page_uuids"
    fi
  fi

  # Stop early if we've passed the target month (desc order means older items appear later)
  has_older=$(echo "$incidents_json" | jq -r --arg month "$TARGET_MONTH" \
    '[.incidents[] | select(.created_at < ($month + "-01"))] | length')
  if [[ "$has_older" -gt 0 ]]; then
    break
  fi

  next_page=$(echo "$incidents_json" | jq -r '.response_metadata.next_page // empty')
  if [[ -z "$next_page" || "$next_page" == "null" ]]; then
    break
  fi
  page=$((page + 1))
done

if [[ -z "$collected_uuids" ]]; then
  echo "No incidents found for ${TARGET_MONTH}." >&2
  exit 0
fi

total=$(echo "$collected_uuids" | wc -l | tr -d ' ')
echo "Found ${total} incident(s). Downloading details..." >&2

sanitize_title() {
  echo "$1" | sed 's/[\/\\:*?"<>|]/-/g' | cut -c1-80
}

count=0
while IFS= read -r uuid; do
  [[ -z "$uuid" ]] && continue
  count=$((count + 1))

  args=$(jq -cn --arg uuid "$uuid" '{incident_uuid:$uuid}')
  detail=$(mcp_call_tool "waroom_get_incident_details" "$args")

  file_date=$(echo "$detail" | jq -r '.created_at[:10]')
  title=$(echo "$detail" | jq -r '.title')
  safe_title=$(sanitize_title "$title")
  filename="${file_date}_${safe_title}.json"

  echo "  [${count}/${total}] ${filename}" >&2
  echo "$detail" | jq '.' > "${OUT_DIR}/${filename}"
done <<< "$collected_uuids"

echo "Done. ${total} files saved to ${OUT_DIR}/" >&2
