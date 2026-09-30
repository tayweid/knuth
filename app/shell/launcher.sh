#!/bin/bash
# A Claerbout app's entry point (the bundle's executable). The app ships
# without Electron's framework (APP.md, "Electron, one shell for Claerbout"),
# so a launch that finds none first completes the app — cloned from a
# sibling app or downloaded, with a progress window (complete.sh,
# progress.js) — and then becomes Electron. Every later launch goes
# straight to exec: the process LaunchServices started is Electron's, so a
# double-clicked file arrives as it would without this script. (Not on the
# completing launch: see progress.js.)
set -uo pipefail

contents="$(cd "$(dirname "$0")/.." && pwd -P)"
app="$(dirname "$contents")"
name="$(basename "$0")"
electron="$contents/MacOS/$name Electron"
framework="$contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"

if [ ! -f "$framework" ]; then
    log="$HOME/Library/Logs/$name.log"
    note() { printf '[%s] %s.app: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$name" "$*" >> "$log"; }
    alert() { # alert <message> <detail>
        osascript - "$1" "$2" <<'SCRIPT' >/dev/null 2>&1
on run argv
    display alert (item 1 of argv) message (item 2 of argv) as warning
end run
SCRIPT
    }
    # Opened where it was downloaded, macOS runs the app from a read-only
    # copy (App Translocation), which cannot be completed.
    case "$app" in
        */AppTranslocation/*)
            alert "Move $name to Applications" "Drag $name from your Downloads folder into Applications, then open it from there."
            exit 0
            ;;
    esac
    if [ ! -w "$contents/Frameworks" ]; then
        alert "$name cannot finish setting itself up" "It needs to write inside $app. Move it to your Applications folder and open it again."
        exit 1
    fi
    status="$(mktemp -t "$name")"
    osascript -l JavaScript "$contents/Resources/progress.js" "$name" "$status" "$contents/Resources/electron.icns" >/dev/null 2>&1 &
    window=$!
    note "completing $app"
    output="$("$contents/Resources/complete.sh" "$app" "$status" 2>&1)"
    result=$?
    touch "$status.done"
    wait "$window" 2>/dev/null
    rm -f "$status" "$status.done"
    note "${output:-complete.sh exited $result}"
    if [ "$result" -ne 0 ]; then
        alert "$name could not finish setting itself up" "${output#complete.sh: }

Check the connection and open $name again."
        exit 1
    fi
fi
exec "$electron" "$@"
