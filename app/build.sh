#!/bin/bash
# Build Knuth.app from app/Sources with the command-line tools alone: no
# Xcode project, no package manager (APP.md), and install it.
#
#   app/build.sh                     # your own copy, into /Applications
#   app/build.sh ~/Desktop/K.app     # anywhere else
#   APP_VERSION=2.0.0 app/build.sh   # stamp the bundle
#   KNUTH_WEB=dist app/build.sh      # the page from a site build, not the staged one
#
# The deploy runs this on a GitHub Mac against the site it verified and
# publishes the zipped result beside it, where knuth.tayweid.io/install
# fetches it (.github/workflows/deploy.yml). Nothing is committed.
set -euo pipefail
if [ -n "${1:-}" ]; then
    case "$1" in
        /*) out="$1" ;;
        *) out="$PWD/$1" ;;
    esac
elif [ -w /Applications ]; then
    out="/Applications/Knuth.app"
else
    mkdir -p "$HOME/Applications"
    out="$HOME/Applications/Knuth.app"
fi
# The target is replaced wholesale, so it must be an app bundle.
case "$out" in
    *.app) ;;
    *) echo "build.sh: the target must end in .app (got $out)" >&2; exit 1 ;;
esac
cd "$(dirname "$0")"
icon_source="../python/knuth/web/icons/knuth-512.png"
version="${APP_VERSION:-}"

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
# One binary for both Mac architectures when the toolchain can build both;
# the machine's own otherwise (a development build).
slices=()
for arch in arm64 x86_64; do
    if swiftc -O -swift-version 5 -sdk "$sdk" -target "$arch-apple-macos12.0" \
        -framework AppKit -framework WebKit \
        -o "$out/Contents/MacOS/Knuth-$arch" Sources/main.swift 2>/dev/null; then
        slices+=("$out/Contents/MacOS/Knuth-$arch")
    fi
done
if [ "${#slices[@]}" -eq 0 ]; then
    swiftc -O -swift-version 5 -sdk "$sdk" \
        -framework AppKit -framework WebKit \
        -o "$out/Contents/MacOS/Knuth" Sources/main.swift
else
    lipo -create "${slices[@]}" -output "$out/Contents/MacOS/Knuth"
    rm -f "${slices[@]}"
fi
echo "architectures: $(lipo -archs "$out/Contents/MacOS/Knuth")"
cp Info.plist "$out/Contents/Info.plist"
if [ -n "$version" ]; then
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" "$out/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $version" "$out/Contents/Info.plist"
fi
printf 'APPL????' > "$out/Contents/PkgInfo"

# The knuth package rides in the bundle: the engine's code and, inside
# it, the staged page. No Python does — the first launch installs one
# (uv) or runs cells in the window (Pyodide), which is why this is small.
# KNUTH_WEB names a site build to use as the page instead of the staged
# one (the deploy passes the site it verified, so no Node is needed here);
# a path relative to the repository root.
web="${KNUTH_WEB:+../${KNUTH_WEB#./}}"
case "${KNUTH_WEB:-}" in /*) web="$KNUTH_WEB" ;; esac
web="${web:-../python/knuth/web}"
if [ ! -f "$web/index.html" ]; then
    echo "no page at $web — run: npm run build:engine" >&2
    exit 1
fi
mkdir -p "$out/Contents/Resources/python"
rsync -a --exclude '__pycache__' --exclude '*.pyc' --exclude '/knuth/web' \
    ../python/knuth "$out/Contents/Resources/python/"
# The site's installer and app download are not part of the page.
rsync -a --exclude /install --exclude /app "$web/" "$out/Contents/Resources/python/knuth/web/"

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

