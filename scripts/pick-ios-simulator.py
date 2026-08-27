#!/usr/bin/env python3
"""Print a compatible iOS runtime and iPhone device type for `xcrun simctl create`.

Reads `xcrun simctl list runtimes --json` on stdin and writes two space-separated identifiers.

The device type comes from the chosen runtime's own `supportedDeviceTypes` rather than the global
`simctl list devicetypes` output. That global list is not ordered newest-last, so taking its final
entry yields something like an iPhone 6s Plus, which modern runtimes reject with
"Incompatible device".
"""

import json
import sys


def main() -> int:
    data = json.load(sys.stdin)
    runtimes = [
        runtime
        for runtime in data.get("runtimes", [])
        if runtime.get("isAvailable") and "SimRuntime.iOS" in runtime.get("identifier", "")
    ]
    if not runtimes:
        print("no available iOS runtime", file=sys.stderr)
        return 1

    def version(runtime):
        return [int(part) for part in runtime["version"].split(".") if part.isdigit()]

    newest = sorted(runtimes, key=version)[-1]
    iphones = [
        device
        for device in newest.get("supportedDeviceTypes", [])
        if "iPhone" in device.get("name", "")
    ]
    if not iphones:
        print("no iPhone device type supported by " + newest["identifier"], file=sys.stderr)
        return 1

    preferred = [device for device in iphones if "Pro" in device["name"]] or iphones
    print(newest["identifier"], preferred[-1]["identifier"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
