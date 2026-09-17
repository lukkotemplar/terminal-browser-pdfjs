#!/bin/bash
set -euo pipefail

PDFJS_VERSION="6.3.289"

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"

CONFIG_DIR="$CONFIG_HOME/terminal-browser"
PDFJS_DIR="$DATA_HOME/tb-pdfjs/pdfjs"

DEPS=(
    curl
    unzip
)

MISSING=()

for pkg in "${DEPS[@]}"; do
    pacman -Q "$pkg" &>/dev/null || MISSING+=("$pkg")
done

if ((${#MISSING[@]})); then
    echo "Installing missing dependencies:"
    printf '  %s\n' "${MISSING[@]}"
    sudo pacman -S --needed "${MISSING[@]}"
fi

mkdir -p "$CONFIG_DIR"
mkdir -p "$DATA_HOME/tb-pdfjs"

cp pdfjs-main.cjs "$CONFIG_DIR/pdfjs-main.cjs"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fL \
    "https://github.com/mozilla/pdf.js/releases/download/v${PDFJS_VERSION}/pdfjs-${PDFJS_VERSION}-dist.zip" \
    -o "$TMP/pdfjs.zip"

rm -rf "$PDFJS_DIR"
mkdir -p "$PDFJS_DIR"

unzip -q "$TMP/pdfjs.zip" -d "$PDFJS_DIR"

echo
echo "Installed:"
echo "  $CONFIG_DIR/pdfjs-main.cjs"
echo "  $PDFJS_DIR"
echo
echo "PDF.js viewer:"
echo "  $PDFJS_DIR/web/viewer.html"
