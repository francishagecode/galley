# Galley

A fast, local-first editor for the [Typst](https://typst.app) typesetting language.
Galley compiles your document in the background and shows a live, page-by-page
preview with syntax highlighting, autocomplete, and instant feedback.

Built with [Tauri](https://tauri.app), [CodeMirror](https://codemirror.net),
and the native [`typst`](https://crates.io/crates/typst) crate — no embedded
browser engine doing the typesetting, no cloud round-trip.

## Install

Download the latest release from the
[Releases page](https://github.com/francishage/galley/releases).

### Linux

- **Debian / Ubuntu:** download the `.deb` and install with
  `sudo apt install ./galley_<version>_amd64.deb`.
- **Other distros:** download the `.AppImage`, mark it executable
  (`chmod +x galley_<version>_amd64.AppImage`), and run it.
- Requires `webkit2gtk-4.1` and `gtk-3` (pulled in automatically by the `.deb`).

## Build from source

Prerequisites:

- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) 18+
- Platform deps for Tauri 2 — see the
  [Tauri prerequisites guide](https://tauri.app/start/prerequisites/).
  On Linux you need `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`,
  `file`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`,
  `librsvg2-dev`.

Then:

```bash
npm install

# Run in dev mode (hot-reloads the UI, rebuilds Rust on change)
npm run tauri:dev

# Build a release bundle for the current platform
npm run tauri:build
```

Bundles land in `src-tauri/target/release/bundle/`.
