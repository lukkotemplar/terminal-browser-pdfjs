# terminal-browser-pdfjs

PDF.js integration for terminal-browser.

This repository adds PDF support to terminal-browser using the official
PDF.js viewer.

## Requirements

- terminal-browser
- curl
- unzip

Missing Arch Linux dependencies are installed automatically by `install.sh`.

## Install

    ./install.sh

This installs:

    ${XDG_CONFIG_HOME:-~/.config}/terminal-browser/pdfjs-main.cjs

and PDF.js under:

    ${XDG_DATA_HOME:-~/.local/share}/tb-pdfjs/pdfjs

PDF.js version:

    6.3.289

## Usage

Start terminal-browser with:

    terminal-browser open 'https://moodle.upm.es/' \
      --main-script="$HOME/.config/terminal-browser/pdfjs-main.cjs"

The script intercepts PDFs and displays them through the local PDF.js viewer.

## Personal data

This repository contains no terminal-browser profile, cookies, sessions or
credentials.
