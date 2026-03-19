#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
OUT_DIR="$ROOT_DIR/dist/bncedgb-glitch"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

copy_file() {
  src="$1"
  dst="$OUT_DIR/$2"
  mkdir -p "$(dirname "$dst")"
  cp "$ROOT_DIR/$src" "$dst"
}

copy_dir() {
  src="$1"
  dst="$OUT_DIR/$2"
  mkdir -p "$(dirname "$dst")"
  cp -R "$ROOT_DIR/$src" "$dst"
}

# Core app files
copy_file "README.md" "README.md"
copy_file "CHANGELOG.md" "CHANGELOG.md"
copy_file "LICENSE" "LICENSE"
copy_file "package.json" "package.json"
copy_file "package-lock.json" "package-lock.json"
copy_file "next.config.ts" "next.config.ts"
copy_file "postcss.config.mjs" "postcss.config.mjs"
copy_file "tsconfig.json" "tsconfig.json"
copy_file "eslint.config.mjs" "eslint.config.mjs"
copy_file "next-env.d.ts" "next-env.d.ts"
copy_file ".gitignore" ".gitignore"

copy_dir "src" "src"
copy_dir "public" "public"
copy_dir "bin" "bin"
copy_dir "scripts" "scripts"

# Keep only the source-based resources needed to rebuild/install locally.
mkdir -p "$OUT_DIR/resources/source/hangul-daemon"
copy_file "resources/install.sh" "resources/install.sh"
copy_file "resources/hangul-daemon.service" "resources/hangul-daemon.service"
copy_file "resources/source/hangul-daemon/go.mod" "resources/source/hangul-daemon/go.mod"
copy_file "resources/source/hangul-daemon/main.go" "resources/source/hangul-daemon/main.go"

cat <<MSG
Prepared GitHub bundle at:
  $OUT_DIR

Included:
  - web app source and config
  - install/runtime scripts
  - source files required to rebuild the daemon

Excluded:
  - .next, node_modules
  - compiled .so / binaries
  - bundled font binary
MSG
