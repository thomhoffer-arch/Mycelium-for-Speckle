#!/usr/bin/env bash
# Build a self-contained macOS .pkg installer for Mycelium-for-Speckle.
# Runs on macOS only (needs pkgbuild/productbuild/lipo). Used by CI on a
# macos-latest runner; produces a universal (Apple Silicon + Intel) installer
# that embeds its own Node runtime — the end user needs nothing pre-installed.
#
#   scripts/build-macos.sh            # → dist/Mycelium-for-Speckle-<ver>-macos.pkg
#
# Env: NODE_VERSION (default v24.17.0), IDENTIFIER, INSTALL_PREFIX.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

NODE_VERSION="${NODE_VERSION:-v24.17.0}"
IDENTIFIER="${IDENTIFIER:-systems.mycelium.for-speckle}"
APP_NAME="mycelium-for-speckle"
VERSION="$(node -p 'require("./package.json").version')"
DIST="$ROOT/dist"
BUILD="$ROOT/.build/macos"
PREFIX="usr/local"                                   # install location under /
APP_HOME="$PREFIX/$APP_NAME"                          # /usr/local/mycelium-for-speckle
PKGROOT="$BUILD/pkgroot"

echo "▸ Building $APP_NAME $VERSION (macOS, Node $NODE_VERSION, universal)"
rm -rf "$BUILD"; mkdir -p "$BUILD" "$DIST"
mkdir -p "$PKGROOT/$APP_HOME" "$PKGROOT/$PREFIX/bin"

# 1. App files
node "$ROOT/scripts/stage-app.mjs" "$PKGROOT/$APP_HOME"

# 2. Universal Node runtime (lipo arm64 + x64 → one fat binary)
fetch_node() { # arch -> extracts node binary to $BUILD/node-<arch>
  local arch="$1"
  local tgz="$BUILD/node-$arch.tar.gz"
  echo "  ↓ node $NODE_VERSION darwin-$arch"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-$arch.tar.gz" -o "$tgz"
  tar -xzf "$tgz" -C "$BUILD"
  cp "$BUILD/node-$NODE_VERSION-darwin-$arch/bin/node" "$BUILD/node-$arch"
}
fetch_node arm64
fetch_node x64
mkdir -p "$PKGROOT/$APP_HOME/runtime/bin"
lipo -create "$BUILD/node-arm64" "$BUILD/node-x64" -output "$PKGROOT/$APP_HOME/runtime/bin/node"
chmod 755 "$PKGROOT/$APP_HOME/runtime/bin/node"
echo "  ✓ universal node: $(lipo -archs "$PKGROOT/$APP_HOME/runtime/bin/node")"

# 3. Launchers on PATH (/usr/local/bin is on the default macOS PATH)
make_launcher() { # name -> entry .mjs (relative to APP_HOME)
  local name="$1"
  local entry="$2"
  local path="$PKGROOT/$PREFIX/bin/$name"
  cat > "$path" <<EOF
#!/bin/bash
exec "/$APP_HOME/runtime/bin/node" "/$APP_HOME/$entry" "\$@"
EOF
  chmod 755 "$path"
}
make_launcher "$APP_NAME" "connector.mjs"
make_launcher "$APP_NAME-webhook" "src/webhook.mjs"

# 4. Build component + product package
COMPONENT="$BUILD/component.pkg"
pkgbuild --root "$PKGROOT" --install-location "/" \
  --identifier "$IDENTIFIER" --version "$VERSION" "$COMPONENT"

DISTRIBUTION="$BUILD/distribution.xml"
cat > "$DISTRIBUTION" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Mycelium for Speckle</title>
  <organization>systems.mycelium</organization>
  <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <volume-check><allowed-os-versions><os-version min="11.0"/></allowed-os-versions></volume-check>
  <choices-outline><line choice="default"/></choices-outline>
  <choice id="default"><pkg-ref id="$IDENTIFIER"/></choice>
  <pkg-ref id="$IDENTIFIER" version="$VERSION" onConclusion="none">component.pkg</pkg-ref>
</installer-gui-script>
EOF

OUT="$DIST/Mycelium-for-Speckle-$VERSION-macos.pkg"
productbuild --distribution "$DISTRIBUTION" --package-path "$BUILD" "$OUT"

echo "✓ $OUT"
ls -lh "$OUT"
