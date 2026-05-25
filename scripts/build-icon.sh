#!/bin/bash
# Generate assets/icon.icns from assets/icon.svg
# Uses sips (built-in macOS) + iconutil (built-in macOS) — no extra tools needed

set -e
SVG="$(dirname "$0")/../assets/icon.svg"
OUT="$(dirname "$0")/../assets/icon.icns"
ICONSET="/tmp/mailplane_build.iconset"

mkdir -p "$ICONSET"

convert_png() {
  sips -s format png -z "$1" "$1" "$SVG" --out "$ICONSET/$2" >/dev/null
}

convert_png 16   "icon_16x16.png"
convert_png 32   "icon_16x16@2x.png"
convert_png 32   "icon_32x32.png"
convert_png 64   "icon_32x32@2x.png"
convert_png 128  "icon_128x128.png"
convert_png 256  "icon_128x128@2x.png"
convert_png 256  "icon_256x256.png"
convert_png 512  "icon_256x256@2x.png"
convert_png 512  "icon_512x512.png"
convert_png 1024 "icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o "$OUT"
rm -rf "$ICONSET"

echo "Generated $OUT"
