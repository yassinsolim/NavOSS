#!/usr/bin/env bash
set -euo pipefail
trap 'echo "Offline source preparation failed at line $LINENO." >&2' ERR

if [[ $# -ne 2 ]]; then
  echo "usage: $0 SOURCE_LOCK_JSON SOURCES_DIRECTORY" >&2
  exit 64
fi
lock=$1
sources=$2
mkdir -p "$sources"
rows=$(jq -er 'if .schemaVersion == 1 and (.sources | type == "array" and length > 0) then .sources[] | [.name,.url,.sha256] | @tsv else error("Invalid source lock") end' "$lock")
while IFS=$'\t' read -r name url expected; do
  [[ $name =~ ^[a-z0-9][a-z0-9._-]+$ && $expected =~ ^[0-9a-f]{64}$ ]]
  destination="$sources/$name"
  if [[ ! -f "$destination" ]]; then
    if [[ -n ${NAVOSS_OFFLINE_SOURCE_MIRROR:-} ]]; then
      url="${NAVOSS_OFFLINE_SOURCE_MIRROR%/}/$expected/$name"
    fi
    curl --fail --location --retry 3 --silent --show-error \
      --user-agent 'NavOSS offline builder (https://github.com/yassinsolim/NavOSS)' \
      "$url" -o "$destination.partial"
    actual=$(sha256sum "$destination.partial" | awk '{print $1}')
    if [[ $actual != "$expected" ]]; then
      echo "Source checksum mismatch: $name. Use the locked snapshot; never silently accept a newer source." >&2
      exit 1
    fi
    mv "$destination.partial" "$destination"
  fi
  actual=$(sha256sum "$destination" | awk '{print $1}')
  if [[ $actual != "$expected" ]]; then
    echo "Cached source checksum mismatch: $name" >&2
    exit 1
  fi
done <<< "$rows"
