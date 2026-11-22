#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")"
module_dir="$PWD"
mkdir -p build/bin
cd engine
GOBIN="$module_dir/build/bin" go install golang.org/x/mobile/cmd/gobind
export PATH="$module_dir/build/bin:$PATH"
case "${1:-}" in
  android)
    go tool gomobile bind -target="${MAILBOX_ANDROID_TARGET:-android}" -androidapi 24 -o "$module_dir/build/directmail.aar" .
    unzip -oq "$module_dir/build/directmail.aar" 'classes.jar' 'jni/*' 'proguard.txt' -d "$module_dir/build/android"
    ;;
  ios)
    go tool gomobile bind -target=ios,iossimulator -iosversion=16.0 -o "$module_dir/build/Directmail.xcframework" .
    ;;
  *) echo 'Use android or ios.' >&2; exit 2;;
esac
