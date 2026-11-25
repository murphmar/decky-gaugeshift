#!/usr/bin/env bash
# Builds the plugin and packages it as a zip that Decky can install.
set -euo pipefail
cd "$(dirname "$0")"
NAME=gaugeshift
npx -y pnpm@9 install --frozen-lockfile >/dev/null
npx -y pnpm@9 run build >/dev/null
rm -rf out && mkdir -p "out/$NAME/dist"
cp dist/index.js "out/$NAME/dist/"
cp main.py plugin.json package.json LICENSE README.md CHANGELOG.md "out/$NAME/"
(cd out && zip -qr "$NAME.zip" "$NAME")
echo "out/$NAME.zip"
