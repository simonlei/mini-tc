#!/usr/bin/env python3
"""Rewrite latest.json's updater URLs to point at the COS CDN (ALL platforms).

In CI we download the aggregated latest.json from GitHub Releases (it already
contains every platform Tauri built), then rewrite every platform entry's URL
to <UPDATER_CDN_BASE>/<filename> so domestic users on Windows/macOS/Linux all
pull updates from COS. The workflow then uploads latest.json + every update
package to COS.

Usage:
    python scripts/rewrite_latest.py [path/to/latest.json]
    # path defaults to auto-discovering under src-tauri/target

Required env:
    UPDATER_CDN_BASE  e.g. https://minitc-125xxxx.cos.ap-guangzhou.myqcloud.com
"""
import json
import os
import glob
import sys

DEFAULT_GLOBS = [
    os.path.join("src-tauri", "target", "release", "bundle", "latest.json"),
    os.path.join("src-tauri", "target", "*", "release", "bundle", "latest.json"),
    os.path.join("src-tauri", "target", "release", "bundle", "**", "latest.json"),
]


def find_latest_json():
    for pattern in DEFAULT_GLOBS:
        hits = glob.glob(pattern, recursive=True)
        if hits:
            return hits[0]
    return None


def main():
    cdn_base = (os.environ.get("UPDATER_CDN_BASE") or "").rstrip("/")
    if not cdn_base:
        print("ERROR: UPDATER_CDN_BASE is not set", file=sys.stderr)
        sys.exit(1)

    path = sys.argv[1] if len(sys.argv) > 1 else find_latest_json()
    if not path or not os.path.isfile(path):
        print(f"ERROR: latest.json not found (tried arg or {DEFAULT_GLOBS})",
              file=sys.stderr)
        sys.exit(1)

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    platforms = data.get("platforms", {})
    if not platforms:
        print("WARN: no platforms in latest.json; nothing to rewrite",
              file=sys.stderr)

    for plat, info in platforms.items():
        url = info.get("url", "")
        if not url:
            continue
        fname = url.rsplit("/", 1)[-1]
        new_url = f"{cdn_base}/{fname}"
        info["url"] = new_url
        print(f"{plat}: {url} -> {new_url}")

    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Updated {path}")


if __name__ == "__main__":
    main()
