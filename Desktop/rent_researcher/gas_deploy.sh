#!/usr/bin/env bash
#
# gas_deploy.sh - Push Google Apps Script files via the Apps Script REST API
#                 and update all deployments to a new version.
#
# Usage: ./gas_deploy.sh [source_directory]
#
# If source_directory is not provided, defaults to the directory containing
# this script.
#
set -euo pipefail

# ---------- Configuration ----------

CLASPRC="$HOME/.clasprc.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="${1:-$SCRIPT_DIR}"

# Read credentials from .clasprc.json
CLIENT_ID=$(jq -r '.tokens.default.client_id' "$CLASPRC")
CLIENT_SECRET=$(jq -r '.tokens.default.client_secret' "$CLASPRC")
REFRESH_TOKEN=$(jq -r '.tokens.default.refresh_token' "$CLASPRC")
ACCESS_TOKEN=$(jq -r '.tokens.default.access_token' "$CLASPRC")
EXPIRY_DATE=$(jq -r '.tokens.default.expiry_date' "$CLASPRC")

# Read scriptId from .clasp.json (look in SRC_DIR first, then script dir)
if [[ -f "$SRC_DIR/.clasp.json" ]]; then
    SCRIPT_ID=$(jq -r '.scriptId' "$SRC_DIR/.clasp.json")
elif [[ -f "$SCRIPT_DIR/.clasp.json" ]]; then
    SCRIPT_ID=$(jq -r '.scriptId' "$SCRIPT_DIR/.clasp.json")
else
    # Fallback to hardcoded value
    SCRIPT_ID="1IjXv_rfbn3bD1YBIbLX91EgODlJT3gh0_kPj3r_HQVRSsmhRyTfUP1Np"
fi

BASE_URL="https://script.googleapis.com/v1/projects/${SCRIPT_ID}"

echo "=== Google Apps Script Deploy ==="
echo "Script ID : $SCRIPT_ID"
echo "Source dir : $SRC_DIR"
echo ""

# ---------- Helper functions ----------

refresh_access_token() {
    echo "Refreshing access token..."
    local response
    response=$(curl -sS -X POST "https://oauth2.googleapis.com/token" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "grant_type=refresh_token" \
        -d "client_id=${CLIENT_ID}" \
        -d "client_secret=${CLIENT_SECRET}" \
        -d "refresh_token=${REFRESH_TOKEN}")

    local new_token
    new_token=$(echo "$response" | jq -r '.access_token // empty')
    if [[ -z "$new_token" ]]; then
        echo "ERROR: Failed to refresh access token."
        echo "Response: $response"
        exit 1
    fi

    ACCESS_TOKEN="$new_token"

    # Update .clasprc.json with the new token and expiry
    local expires_in
    expires_in=$(echo "$response" | jq -r '.expires_in // 3600')
    local new_expiry
    new_expiry=$(( $(date +%s) * 1000 + expires_in * 1000 ))

    local tmp_file
    tmp_file=$(mktemp)
    jq --arg token "$ACCESS_TOKEN" --argjson expiry "$new_expiry" \
        '.tokens.default.access_token = $token | .tokens.default.expiry_date = $expiry' \
        "$CLASPRC" > "$tmp_file" && mv "$tmp_file" "$CLASPRC"

    echo "Access token refreshed successfully."
}

ensure_valid_token() {
    local now_ms
    now_ms=$(( $(date +%s) * 1000 ))

    # Refresh if token expires within the next 60 seconds
    if [[ "$EXPIRY_DATE" -lt $(( now_ms + 60000 )) ]]; then
        refresh_access_token
    else
        echo "Access token is still valid."
    fi
}

api_call() {
    local method="$1"
    local url="$2"
    local body="${3:-}"

    local args=(-sS -X "$method" "$url" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        -H "Content-Type: application/json")

    if [[ -n "$body" ]]; then
        args+=(-d "$body")
    fi

    curl "${args[@]}"
}

# ---------- Step 1: Ensure access token is valid ----------

ensure_valid_token
echo ""

# ---------- Step 1.5: Safety check - deploy元のGASファイルがmainと一致するか ----------

echo "Checking GAS files against main branch..."

SAFETY_FAIL=0
# mainブランチのGASファイルと比較（gitリポジトリ内にある場合のみ）
for gasfile in "$SRC_DIR"/*.js "$SRC_DIR"/*.html; do
    [[ -f "$gasfile" ]] || continue
    fname=$(basename "$gasfile")

    # mainブランチ上の同名ファイルを取得して比較
    main_content=$(cd "$SCRIPT_DIR" && git show "main:${fname}" 2>/dev/null) || continue
    local_content=$(cat "$gasfile")

    if [[ "$main_content" != "$local_content" ]]; then
        echo "  ⚠️  $fname: deploy元とmainブランチに差分があります"
        SAFETY_FAIL=1
    fi
done

if [[ "$SAFETY_FAIL" -eq 1 ]]; then
    echo ""
    echo "WARNING: deploy元のGASファイルがmainブランチと一致しません。"
    echo "         mainにマージされていない変更、またはmainから同期されていない変更があります。"
    echo ""
    echo "  推奨: deploy元のブランチで 'git merge main' を実行してから再度デプロイしてください。"
    echo "  または deploy後に main へマージ・pushしてください。"
    echo ""
    echo "この警告を無視してデプロイするには: FORCE=1 bash gas_deploy.sh ..."
    if [[ "${FORCE:-0}" != "1" ]]; then
        exit 1
    fi
    echo "FORCE=1 が指定されたため、続行します。"
fi

echo "GAS files check passed."
echo ""

# ---------- Step 2: Build the files payload ----------

echo "Building file list from: $SRC_DIR"

# We use a Python one-liner to safely build JSON from the files,
# handling UTF-8 filenames (like Japanese) and proper escaping.
PAYLOAD=$(python3 -c "
import json, os, sys, glob

src_dir = sys.argv[1]
files = []

# appsscript.json
manifest = os.path.join(src_dir, 'appsscript.json')
if os.path.isfile(manifest):
    with open(manifest, 'r', encoding='utf-8') as f:
        files.append({
            'name': 'appsscript',
            'type': 'JSON',
            'source': f.read()
        })
    print(f'  + appsscript.json (JSON)', file=sys.stderr)
else:
    print('ERROR: appsscript.json not found!', file=sys.stderr)
    sys.exit(1)

# .js files -> SERVER_JS
for path in sorted(glob.glob(os.path.join(src_dir, '*.js'))):
    basename = os.path.basename(path)
    name = os.path.splitext(basename)[0]
    with open(path, 'r', encoding='utf-8') as f:
        files.append({
            'name': name,
            'type': 'SERVER_JS',
            'source': f.read()
        })
    print(f'  + {basename} (SERVER_JS)', file=sys.stderr)

# .html files -> HTML
for path in sorted(glob.glob(os.path.join(src_dir, '*.html'))):
    basename = os.path.basename(path)
    name = os.path.splitext(basename)[0]
    with open(path, 'r', encoding='utf-8') as f:
        files.append({
            'name': name,
            'type': 'HTML',
            'source': f.read()
        })
    print(f'  + {basename} (HTML)', file=sys.stderr)

payload = json.dumps({'files': files}, ensure_ascii=False)
print(payload)
" "$SRC_DIR")

FILE_COUNT=$(echo "$PAYLOAD" | jq '.files | length')
echo ""
echo "Total files: $FILE_COUNT"
echo ""

# ---------- Step 3: Push content ----------

echo "Pushing content to Apps Script project..."
PUSH_RESPONSE=$(api_call PUT "${BASE_URL}/content" "$PAYLOAD")

# Check for errors
PUSH_ERROR=$(echo "$PUSH_RESPONSE" | jq -r '.error.message // empty')
if [[ -n "$PUSH_ERROR" ]]; then
    echo "ERROR pushing content: $PUSH_ERROR"
    echo "Full response:"
    echo "$PUSH_RESPONSE" | jq .
    exit 1
fi

echo "Content pushed successfully."
echo "$PUSH_RESPONSE" | jq '{scriptId: .scriptId, files: [.files[].name]}'
echo ""

# ---------- Step 4: Create a new version ----------

echo "Creating a new version..."
VERSION_RESPONSE=$(api_call POST "${BASE_URL}/versions" \
    "{\"description\": \"Deployed via gas_deploy.sh at $(date '+%Y-%m-%d %H:%M:%S')\"}")

VERSION_ERROR=$(echo "$VERSION_RESPONSE" | jq -r '.error.message // empty')
if [[ -n "$VERSION_ERROR" ]]; then
    echo "ERROR creating version: $VERSION_ERROR"
    echo "Full response:"
    echo "$VERSION_RESPONSE" | jq .
    exit 1
fi

VERSION_NUMBER=$(echo "$VERSION_RESPONSE" | jq -r '.versionNumber')
echo "Created version: $VERSION_NUMBER"
echo ""

# ---------- Step 5: List and update deployments ----------

echo "Listing deployments..."
DEPLOYMENTS_RESPONSE=$(api_call GET "${BASE_URL}/deployments")

DEPLOY_ERROR=$(echo "$DEPLOYMENTS_RESPONSE" | jq -r '.error.message // empty')
if [[ -n "$DEPLOY_ERROR" ]]; then
    echo "ERROR listing deployments: $DEPLOY_ERROR"
    echo "Full response:"
    echo "$DEPLOYMENTS_RESPONSE" | jq .
    exit 1
fi

# Extract deployment IDs (skip HEAD deployment which can't be updated)
DEPLOYMENT_IDS=$(echo "$DEPLOYMENTS_RESPONSE" | jq -r '
    .deployments[]
    | select(.deploymentConfig.versionNumber != null)
    | .deploymentId
')

if [[ -z "$DEPLOYMENT_IDS" ]]; then
    echo "No updateable deployments found (HEAD-only deployments are skipped)."
    echo "All deployments:"
    echo "$DEPLOYMENTS_RESPONSE" | jq '.deployments[] | {deploymentId, description: .deploymentConfig.description, versionNumber: .deploymentConfig.versionNumber}'
    echo ""
    echo "Done. Content pushed and version $VERSION_NUMBER created, but no deployments to update."
    exit 0
fi

DEPLOY_COUNT=$(echo "$DEPLOYMENT_IDS" | wc -l | tr -d ' ')
echo "Found $DEPLOY_COUNT deployment(s) to update."
echo ""

UPDATE_SUCCESS=0
UPDATE_FAIL=0

while IFS= read -r DEPLOY_ID; do
    echo "Updating deployment: $DEPLOY_ID -> version $VERSION_NUMBER ..."

    UPDATE_BODY=$(jq -n \
        --arg ver "$VERSION_NUMBER" \
        '{deploymentConfig: {versionNumber: ($ver | tonumber), description: "Updated by gas_deploy.sh"}}')

    UPDATE_RESPONSE=$(api_call PUT "${BASE_URL}/deployments/${DEPLOY_ID}" "$UPDATE_BODY")

    UPDATE_ERROR=$(echo "$UPDATE_RESPONSE" | jq -r '.error.message // empty')
    if [[ -n "$UPDATE_ERROR" ]]; then
        echo "  ERROR: $UPDATE_ERROR"
        ((UPDATE_FAIL++)) || true
    else
        echo "  OK"
        ((UPDATE_SUCCESS++)) || true
    fi
done <<< "$DEPLOYMENT_IDS"

echo ""
echo "=== Deploy Summary ==="
echo "Files pushed  : $FILE_COUNT"
echo "Version       : $VERSION_NUMBER"
echo "Deployments   : $UPDATE_SUCCESS updated, $UPDATE_FAIL failed"
echo "======================"
