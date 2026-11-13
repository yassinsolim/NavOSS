#!/bin/sh
# Maestro 2.x writes `takeScreenshot` files only inside the run's output folder
# (<dir>/<flow>/takeScreenshot/<name>.png) and rejects absolute paths. Flows take relative
# names; this copies them to /tmp/<name>.png, where the validation scripts collect them.
# Usage: sh scripts/maestro-screenshots.sh <test-output-dir>
set -eu
find "$1" -path '*/takeScreenshot/*.png' -exec cp {} /tmp/ \;
