# Galley

A fast, local-first editor for the [Typst](https://typst.app) typesetting language.
Galley compiles your document in the background and shows a live, page-by-page
preview with syntax highlighting, autocomplete, and instant feedback.

Built with [Electron](https://www.electronjs.org), [CodeMirror](https://codemirror.net),
and the native [`typst`](https://crates.io/crates/typst) crate. Compiling and
page rendering run in Rust, off the UI thread, so typing and scrolling stay at
your display's full refresh rate. No cloud round-trip.

## Install

Download the latest release from the
[Releases page](https://github.com/francishagecode/galley/releases).

### Linux

- **Debian / Ubuntu:** download the `.deb` and install with
  `sudo apt install ./galley_<version>_amd64.deb`.
- **Other distros:** download the `.AppImage`, mark it executable
  (`chmod +x Galley-<version>.AppImage`), and run it.

## Build from source

Prerequisites: [Rust](https://rustup.rs) (stable) and
[Node.js](https://nodejs.org) 20+.

```bash
npm install
npm run native     # build the Rust engine as a Node module (once, and after Rust changes)
npm run dev        # run with a hot-reloading UI
npm run dist       # build installers for this platform into release/
```

## Layout

| Path        | What                                                               |
| ----------- | ------------------------------------------------------------------ |
| `src/`      | The UI: editor, preview, file tree (bundled by Vite)               |
| `electron/` | Main process and preload: window, dialogs, protocols               |
| `engine/`   | Rust: Typst compiling, page rasterization, click-to-source, export |
| `native/`   | Rust: the engine as a Node native module (`native/galley.node`)    |
| `build/`    | App icons for packaging                                            |

The preview shows each page as a PNG rendered by the engine at the exact
device-pixel size it's displayed at, served over the `galley-page:` protocol.

`scripts/bench.sh` measures frame timing while scrolling and typing (with
`npx vite` running and the native module built).
