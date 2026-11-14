#!/bin/sh
# Proves a built NavOSS.app contains none of the DEBUG-only code: the software
# App Attest key path, the community and trip-restore simulator harnesses and the service's
# harness hooks. Scans every Mach-O file in the
# bundle (Debug builds keep app code in NavOSS.debug.dylib). Usage:
#   sh scripts/check-release-exclusions.sh path/to/NavOSS.app
set -eu
app="$1"
[ -d "$app" ] || { echo "No app at $app" >&2; exit 2; }
binaries=$(find "$app" -type f \( -name 'NavOSS' -o -name '*.dylib' -o -perm -u+x \) -exec sh -c 'file -b "$1" | grep -q Mach-O' _ {} \; -print)
status=0
check() {
  kind=$1; needle=$2
  found=""
  for binary in $binaries; do
    if [ "$kind" = symbol ]; then
      nm -a "$binary" 2>/dev/null | grep -q "$needle" && found="$binary"
    else
      strings -a "$binary" | grep -q "$needle" && found="$binary"
    fi
  done
  if [ -n "$found" ]; then echo "PRESENT $kind $needle ($found)"; status=1; else echo "absent  $kind $needle"; fi
}
for symbol in NavOSSDevelopmentAttestationProvider NavOSSCommunitySimulatorHarness \
  NavOSSRestoreSimulatorHarness checkpointWillWrite speechWillStart; do check symbol "$symbol"; done
for text in NAVOSS_COMMUNITY_E2E NAVOSS_RESTORE_E2E NavOSSDevelopmentAppAttestTeamID development-key.; do check string "$text"; done
exit $status
