// Galley's Electron main process: one window running the frontend in src/,
// with the Rust Typst engine (engine/, bound in native/) doing compiles and
// page rendering off the main thread.
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, screen, shell } from "electron";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, "../dist");
const devUrl = process.env.GALLEY_DEV_URL;

// A second launch hands over to the running instance (see "second-instance").
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) app.quit();

const { Engine } = createRequire(import.meta.url)("../native/galley.node");
// Cheap to create: font discovery runs on a background thread.
const engine = isPrimary ? new Engine(`galley/${app.getVersion()}`) : null;

// The built app is served from app://galley/ rather than file:// so it gets a
// stable origin (for localStorage) and a real Content-Security-Policy.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // CodeMirror styles elements inline
  "img-src 'self' data: blob: galley-page:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "galley-page", privileges: { standard: true, secure: true } },
]);

// --- Launch target ----------------------------------------------------------

// `galley <folder>` opens that folder as the project; `galley <file>` opens the
// file within its folder. Flags (Chromium's included) are ignored.
function launchTarget(argv, cwd) {
  const [arg] = argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-"));
  if (!arg) return null;
  const target = path.resolve(cwd, arg);
  try {
    const stat = statSync(target);
    if (stat.isDirectory()) return { root: target, file: null };
    if (stat.isFile()) return { root: path.dirname(target), file: target };
  } catch {
    // Not a path we can open; start normally.
  }
  return null;
}

// Handed to the renderer once, so a reload restores the last session instead.
let launch = launchTarget(process.argv, process.cwd());
ipcMain.handle("galley:take-launch-target", () => {
  const target = launch;
  launch = null;
  return target;
});

// --- Commands ---------------------------------------------------------------

// File I/O is plain Node; everything else goes to the engine as JSON.
const nodeCommands = {
  read_file_text: ({ path }) => readFile(path, "utf8"),
  write_file_text: ({ path, content }) => writeFile(path, content),
};

// Errors come back as { error } rather than a rejection so the renderer gets
// the plain message instead of Electron's "Error invoking remote method" text.
ipcMain.handle("galley:invoke", async (_event, command, args = {}) => {
  try {
    const value = nodeCommands[command]
      ? await nodeCommands[command](args)
      : JSON.parse(await engine.invoke(command, JSON.stringify(args)));
    return { value };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
});

// A path, an array of paths with `multiple`, or null when cancelled.
ipcMain.handle("galley:open", async (event, options = {}) => {
  const properties = [options.directory ? "openDirectory" : "openFile"];
  if (options.multiple) properties.push("multiSelections");
  const { canceled, filePaths } = await dialog.showOpenDialog(
    BrowserWindow.fromWebContents(event.sender),
    {
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
      properties,
    },
  );
  if (canceled || filePaths.length === 0) return null;
  return options.multiple ? filePaths : filePaths[0];
});

ipcMain.handle("galley:save", async (event, options = {}) => {
  const { canceled, filePath } = await dialog.showSaveDialog(
    BrowserWindow.fromWebContents(event.sender),
    { title: options.title, defaultPath: options.defaultPath, filters: options.filters },
  );
  return canceled ? null : filePath;
});

// --- Protocols --------------------------------------------------------------

function registerProtocols() {
  // Preview page images, rasterized by the engine on a worker thread.
  protocol.handle("galley-page", async (request) => {
    const png = await engine.pagePng(decodeURIComponent(new URL(request.url).pathname.slice(1)));
    if (!png) return new Response(null, { status: 404 });
    return new Response(png, {
      headers: { "content-type": "image/png", "cache-control": "max-age=31536000, immutable" },
    });
  });

  protocol.handle("app", async (request) => {
    const file = path.join(distDir, decodeURIComponent(new URL(request.url).pathname));
    if (path.relative(distDir, file).startsWith("..")) return new Response(null, { status: 403 });
    const response = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(response.headers);
    headers.set("content-security-policy", CSP);
    return new Response(response.body, { status: response.status, headers });
  });
}

// --- Window -----------------------------------------------------------------

const stateFile = path.join(app.getPath("userData"), "window-state.json");

function loadWindowState() {
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    // Drop the saved position if that part of the desktop no longer exists.
    const visible = screen
      .getAllDisplays()
      .some(
        ({ workArea: a }) =>
          state.x >= a.x && state.y >= a.y && state.x < a.x + a.width && state.y < a.y + a.height,
      );
    return visible ? state : { width: state.width, height: state.height };
  } catch {
    return { width: 1280, height: 820 };
  }
}

function saveWindowState(win) {
  const bounds = win.getNormalBounds();
  try {
    writeFileSync(stateFile, JSON.stringify({ ...bounds, maximized: win.isMaximized() }));
  } catch {
    // Not worth interrupting quit over.
  }
}

function createWindow() {
  const state = loadWindowState();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 700,
    minHeight: 500,
    title: "Galley",
    show: false, // shown once the first frame is ready, so it never flashes white
    backgroundColor: "#303841", // the default theme's background
    // The taskbar icon on Linux; elsewhere it comes from the app bundle.
    icon: process.platform === "linux" ? path.join(here, "../build/icon.png") : undefined,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      // Typst source isn't prose, and Chromium would otherwise download
      // Hunspell dictionaries on Linux.
      spellcheck: false,
    },
  });
  if (state.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  win.on("close", () => saveWindowState(win));

  // Links open in the browser; the window itself never navigates away (e.g. to
  // a file dropped onto it), though reloading is fine.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => {
    if (event.url !== win.webContents.getURL()) event.preventDefault();
  });

  // Chromium has no built-in context menu; offer the usual editing actions.
  win.webContents.on("context-menu", (_event, params) => {
    const { editFlags, isEditable, selectionText } = params;
    if (!isEditable && !selectionText) return;
    Menu.buildFromTemplate([
      { role: "cut", enabled: editFlags.canCut, visible: isEditable },
      { role: "copy", enabled: editFlags.canCopy },
      { role: "paste", enabled: editFlags.canPaste, visible: isEditable },
      { type: "separator", visible: isEditable },
      { role: "selectAll", enabled: editFlags.canSelectAll, visible: isEditable },
    ]).popup({ window: win });
  });

  if (devUrl) {
    win.webContents.on("before-input-event", (event, input) => {
      const devtools = input.key === "F12" || (input.control && input.shift && input.key === "I");
      if (input.type === "keyDown" && devtools) {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
    win.loadURL(devUrl);
  } else {
    win.loadURL("app://galley/index.html");
  }
  return win;
}

app.on("second-instance", (_event, argv, workingDirectory) => {
  const [win] = BrowserWindow.getAllWindows();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const target = launchTarget(argv, workingDirectory);
  if (target) win.webContents.send("galley:open", target);
});

app.on("window-all-closed", () => app.quit());

app.whenReady().then(() => {
  if (!isPrimary) return;
  // The editor handles its own shortcuts; a menu bar would only add clutter and
  // conflicting accelerators. macOS still needs the standard app/edit menus.
  Menu.setApplicationMenu(
    process.platform === "darwin"
      ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
      : null,
  );
  registerProtocols();
  createWindow();
});
