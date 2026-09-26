#!/bin/bash
# Build Knuth.app from app/Sources with the command-line tools alone: no
# Xcode project, no package manager (APP.md). Output: app/build/Knuth.app,
# or the path given as the first argument.
#
#   app/build.sh                 # -> app/build/Knuth.app
#   app/build.sh /Applications/Knuth.app
set -euo pipefail
cd "$(dirname "$0")"
out="${1:-build/Knuth.app}"
icon_source="../python/knuth/web/icons/knuth-512.png"

# The command-line tools can ship an SDK newer than their own compiler
# (26.x tools with a 27.0 SDK), which swiftc refuses. Pick the newest SDK
# the compiler accepts rather than the default.
sdk=""
probe="$(mktemp -d)/probe.swift"
echo 'import Foundation' > "$probe"
for candidate in $(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX*.*.sdk 2>/dev/null | sort -rV); do
    if swiftc -sdk "$candidate" -swift-version 5 -typecheck "$probe" >/dev/null 2>&1; then
        sdk="$candidate"
        break
    fi
done
rm -rf "$(dirname "$probe")"
[ -n "$sdk" ] || sdk="$(xcrun --show-sdk-path)"
echo "sdk: $sdk"

rm -rf "$out"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources"
swiftc -O -swift-version 5 -sdk "$sdk" \
    -framework AppKit -framework WebKit \
    -o "$out/Contents/MacOS/Knuth" Sources/main.swift
cp Info.plist "$out/Contents/Info.plist"
printf 'APPL????' > "$out/Contents/PkgInfo"

# The page, as the engine serves it, for the built-in Python mode: the
# shell serves this folder under knuth://app/ when there is no engine.
if [ ! -f ../python/knuth/web/index.html ]; then
    echo "no staged page in python/knuth/web — run: npm run build:engine" >&2
    exit 1
fi
cp -R ../python/knuth/web "$out/Contents/Resources/web"

# The app icon, from the same PNG the page uses for its own icon.
iconset="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$icon_source" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    if [ "$double" -le 512 ]; then
        sips -z "$double" "$double" "$icon_source" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
    fi
done
cp "$icon_source" "$iconset/icon_512x512@2x.png"
iconutil -c icns "$iconset" -o "$out/Contents/Resources/AppIcon.icns"
rm -rf "$(dirname "$iconset")"

# Ad-hoc signature: enough to run locally on Apple silicon. Distribution
# signing and notarization are the open Gatekeeper question in APP.md.
codesign --force --sign - "$out" >/dev/null 2>&1
echo "built $out"
