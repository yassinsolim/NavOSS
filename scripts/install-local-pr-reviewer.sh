#!/bin/sh
# Install or update the per-user launchd job that runs the local NavOSS OMP reviewer.

set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
label="org.navoss.pr-reviewer"
launch_agents="$HOME/Library/LaunchAgents"
plist="$launch_agents/$label.plist"
log_directory="$HOME/Library/Logs/NavOSS"

mkdir -p "$launch_agents" "$log_directory"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$repository_root/scripts/review-ready-prs.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$repository_root</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>120</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$log_directory/reviewer.log</string>
  <key>StandardErrorPath</key>
  <string>$log_directory/reviewer.error.log</string>
</dict>
</plist>
EOF

plutil -lint "$plist" >/dev/null
launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl enable "gui/$(id -u)/$label"
launchctl kickstart -k "gui/$(id -u)/$label"

echo "Installed $label"
echo "Poll interval: 120 seconds"
echo "Logs: $log_directory/reviewer.log"
