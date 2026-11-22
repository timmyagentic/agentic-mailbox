#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
archive="${1:-outputs/agentic-mailbox-mac-arm64.zip}"
identity="${AGENTIC_MAC_SIGN_IDENTITY:?Set AGENTIC_MAC_SIGN_IDENTITY to a Developer ID Application identity}"
version="$(node -p "require('./package.json').version")"
bundle_version="${version%%-*}"
mkdir -p outputs
scratch="$(mktemp -d "$root/outputs/.dmg.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

ditto -x -k "$archive" "$scratch"
app="$scratch/image/Agentic Mailbox.app"
resources="$app/Contents/Resources/Mailbox"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
mv "$scratch/Agentic Mailbox" "$resources"
ln -s /Applications "$scratch/image/Applications"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>si.timmyagentic.mailbox</string>
  <key>CFBundleName</key><string>Agentic Mailbox</string>
  <key>CFBundleExecutable</key><string>AgenticMailbox</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$bundle_version</string>
  <key>CFBundleVersion</key><string>$bundle_version</string>
</dict>
</plist>
PLIST
xcrun swiftc -O -target arm64-apple-macos13.0 macos/Launcher.swift -o "$app/Contents/MacOS/AgenticMailbox"
sign_binary() { codesign --force --sign "$identity" --timestamp --options runtime "$@"; }
while IFS= read -r -d '' binary; do
  if [[ "$(file -b "$binary")" != Mach-O* ]]; then continue; fi
  case "$(basename "$binary")" in
    node|workerd) sign_binary --entitlements macos/runtime-entitlements.plist "$binary" ;;
    *) sign_binary "$binary" ;;
  esac
done < <(find "$resources" -type f \( -perm -100 -o -name '*.node' -o -name '*.dylib' \) -print0)
codesign --force --sign "$identity" --timestamp --options runtime "$app"
codesign --verify --deep --strict "$app"

name="agentic-mailbox-$version-mac-arm64.dmg"
dmg="$scratch/$name"
hdiutil create -quiet -volname "Agentic Mailbox" -format UDZO -srcfolder "$scratch/image" "$dmg"
codesign --sign "$identity" --timestamp "$dmg"
codesign --verify --strict "$dmg"
if [[ -n "${AGENTIC_MAC_NOTARY_PROFILE:-}" ]]; then
  xcrun notarytool submit "$dmg" --keychain-profile "$AGENTIC_MAC_NOTARY_PROFILE" --wait --timeout 20m
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
fi
mv "$dmg" "outputs/$name"
shasum -a 256 "outputs/$name"
