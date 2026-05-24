import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ChangeSet } from "@codemirror/state";
import {
  createEditor,
  createEditorState,
  wrapSelection,
  prefixLines,
  insertSnippet,
  getDocText,
  gotoOffset,
  setLineNumbers,
  setTabSize,
  openFind,
} from "./editor.js";

const DEFAULT_DOC = `= Hello, Typst!

This is a *local* Typst editor. Edit on the left, preview updates on the right.

== Try these
- Press *Cmd+B* to bold, *Cmd+I* to italic
- Use #link("https://typst.app/docs")[the Typst docs] for syntax
- Open or save .typ files with the toolbar buttons

== Math
Inline: $ a^2 + b^2 = c^2 $.

Display:
$ integral_0^infinity e^(-x^2) dif x = sqrt(pi)/2 $

== List
+ First
+ Second
+ Third
`;

/* =====================================================================
   Settings (persisted)
   --------------------------------------------------------------------- */

const SETTINGS_KEY = "galley.settings.v2";
const THEMES = ["mariana", "monokai", "slate", "paper", "solar"];
const DEFAULT_SETTINGS = {
  fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
  fontSize: 14, // px
  lineHeight: 16, // tenths -> 1.6
  tabSize: 2,
  theme: "mariana",
  lineNumbers: true,
  sidebarVisible: true,
  autosave: true,
  autosaveDelay: 1000, // ms of idle before autosave fires
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}

const settings = loadSettings();

/* =====================================================================
   State
   --------------------------------------------------------------------- */

const PROJECT_STATE_KEY = "galley.project.v1";

let activePath = null; // path of file currently in the editor view
let dirty = false; // dirty state of the active file
let compileTimer = null;
let compiling = false;
let needsRecompile = false;

const project = {
  root: null, // project root directory, or null
  files: [], // list of DirEntryInfo from backend
  collapsed: new Set(), // collapsed folder rel-paths in the tree
};

// buffers map: path -> { state: EditorState, dirty: bool }
// We keep each file's CodeMirror state around so switching files preserves
// per-file undo history and cursor position.
const buffers = new Map();

const pageCache = new Map();
let pageHashByIndex = [];

const syncByFile = new Map();

function syncKey() {
  return activePath || "<untitled>";
}

function getSyncState() {
  const k = syncKey();
  let s = syncByFile.get(k);
  if (!s) {
    s = { hash: null, pending: ChangeSet.empty(view.state.doc.length) };
    syncByFile.set(k, s);
  }
  return s;
}

const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const errorBoxEl = document.getElementById("error-box");
const splitEl = document.getElementById("split");
const resizerEl = document.getElementById("resizer");
const viewModeSeg = document.getElementById("view-mode-seg");
const zoomLevelEl = document.getElementById("zoom-level");
const previewScrollEl = document.querySelector(".preview-scroll");
const settingsBtn = document.getElementById("btn-settings");
const settingsPanel = document.getElementById("settings-panel");
const exportBtn = document.getElementById("btn-export");
const exportPanel = document.getElementById("export-panel");

// Toolbar popovers (settings, export) share open/close/outside-click/Escape
// behavior. `otherClose` lets opening one close the other.
function makePopover(panel, btn, { onOpen, otherClose } = {}) {
  function toggle(force) {
    const isOpen = !panel.hidden;
    const next = force !== undefined ? force : !isOpen;
    panel.hidden = !next;
    btn.classList.toggle("is-active", next);
    if (next) {
      otherClose?.();
      onOpen?.();
    }
  }
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });
  document.addEventListener("click", (e) => {
    if (panel.hidden) return;
    if (e.target.closest(`#${panel.id}`) || e.target.closest(`#${btn.id}`)) return;
    toggle(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) toggle(false);
  });
  return toggle;
}

let toggleSettings, toggleExport;

/* =====================================================================
   Editor
   --------------------------------------------------------------------- */

// Module-level handler that all per-buffer states share, since `view.setState`
// swaps CodeMirror state when the user clicks a different file in the tree.
function handleEdit(update) {
  dirty = true;
  if (activePath) {
    const buf = buffers.get(activePath);
    if (buf) buf.dirty = true;
  }
  if (update.changes) {
    const s = getSyncState();
    s.pending = s.pending.compose(update.changes);
  }
  updateStatus();
  scheduleCompile();
  scheduleOutline();
  scheduleAutosave();
}

const view = createEditor(document.getElementById("editor"), DEFAULT_DOC, handleEdit, {
  lineNumbers: settings.lineNumbers,
  tabSize: settings.tabSize,
});

/* =====================================================================
   Settings → DOM
   --------------------------------------------------------------------- */

function applySettings() {
  const root = document.documentElement;
  root.style.setProperty("--ed-font", settings.fontFamily);
  root.style.setProperty("--ed-size", `${settings.fontSize}px`);
  root.style.setProperty("--ed-line", (settings.lineHeight / 10).toFixed(2));

  if (!THEMES.includes(settings.theme)) settings.theme = "mariana";
  for (const t of THEMES) document.body.classList.remove(`theme-${t}`);
  document.body.classList.add(`theme-${settings.theme}`);
}

function reflectSettingsToControls() {
  document.getElementById("set-font").value = settings.fontFamily;
  document.getElementById("set-size").value = settings.fontSize;
  document.getElementById("set-size-val").textContent = settings.fontSize;
  document.getElementById("set-line").value = settings.lineHeight;
  document.getElementById("set-line-val").textContent = (settings.lineHeight / 10).toFixed(1);
  document.getElementById("set-tab").value = settings.tabSize;
  document.getElementById("set-tab-val").textContent = settings.tabSize;

  document.getElementById("set-theme").value = settings.theme;
  document.getElementById("set-linenums-on").classList.toggle("is-active", settings.lineNumbers);
  document.getElementById("set-linenums-off").classList.toggle("is-active", !settings.lineNumbers);

  document.getElementById("set-autosave-on").classList.toggle("is-active", settings.autosave);
  document.getElementById("set-autosave-off").classList.toggle("is-active", !settings.autosave);
  document.getElementById("set-autosave-delay").value = settings.autosaveDelay;
  document.getElementById("set-autosave-delay-val").textContent =
    `${(settings.autosaveDelay / 1000).toFixed(1)}s`;
}

applySettings();
reflectSettingsToControls();

/* settings event wiring */
document.getElementById("set-font").addEventListener("change", (e) => {
  settings.fontFamily = e.target.value;
  applySettings();
  saveSettings(settings);
});

document.getElementById("set-size").addEventListener("input", (e) => {
  settings.fontSize = +e.target.value;
  document.getElementById("set-size-val").textContent = settings.fontSize;
  applySettings();
  saveSettings(settings);
});

document.getElementById("set-line").addEventListener("input", (e) => {
  settings.lineHeight = +e.target.value;
  document.getElementById("set-line-val").textContent = (settings.lineHeight / 10).toFixed(1);
  applySettings();
  saveSettings(settings);
});

document.getElementById("set-tab").addEventListener("input", (e) => {
  settings.tabSize = +e.target.value;
  document.getElementById("set-tab-val").textContent = settings.tabSize;
  setTabSize(view, settings.tabSize);
  saveSettings(settings);
});

document.getElementById("set-theme").addEventListener("change", (e) => {
  settings.theme = e.target.value;
  applySettings();
  saveSettings(settings);
});

document.getElementById("set-linenums-on").addEventListener("click", () => {
  settings.lineNumbers = true;
  setLineNumbers(view, true);
  reflectSettingsToControls();
  saveSettings(settings);
});

document.getElementById("set-linenums-off").addEventListener("click", () => {
  settings.lineNumbers = false;
  setLineNumbers(view, false);
  reflectSettingsToControls();
  saveSettings(settings);
});

document.getElementById("set-autosave-on").addEventListener("click", () => {
  settings.autosave = true;
  reflectSettingsToControls();
  saveSettings(settings);
  // If there are unsaved changes, kick the timer so the next save matches the
  // user's just-confirmed expectation that autosave is on.
  if (dirty) scheduleAutosave();
});

document.getElementById("set-autosave-off").addEventListener("click", () => {
  settings.autosave = false;
  cancelAutosave();
  reflectSettingsToControls();
  saveSettings(settings);
});

document.getElementById("set-autosave-delay").addEventListener("input", (e) => {
  settings.autosaveDelay = +e.target.value;
  document.getElementById("set-autosave-delay-val").textContent =
    `${(settings.autosaveDelay / 1000).toFixed(1)}s`;
  saveSettings(settings);
  // Don't reschedule mid-drag — the next edit (or release) picks up the new delay.
});

// eslint-disable-next-line prefer-const -- forward-declared above for mutual reference with toggleExport
toggleSettings = makePopover(settingsPanel, settingsBtn, {
  otherClose: () => toggleExport?.(false),
});

/* =====================================================================
   Filename / status
   --------------------------------------------------------------------- */

function fileName(p) {
  if (!p) return "Untitled";
  return p.split(/[\\/]/).pop();
}

function updateStatus(extra) {
  statusEl.classList.remove("error", "working");
  if (extra) {
    statusEl.textContent = extra;
    return;
  }
  const mark = dirty ? " ●" : "";
  statusEl.textContent = `${fileName(activePath)}${mark}`;
}

function setError(message) {
  errorBoxEl.hidden = false;
  errorBoxEl.textContent = message;
  statusEl.textContent = "Compile error";
  statusEl.classList.add("error");
}

function clearError() {
  errorBoxEl.hidden = true;
  errorBoxEl.textContent = "";
  statusEl.classList.remove("error");
}

/* =====================================================================
   Compile pipeline
   --------------------------------------------------------------------- */

function scheduleCompile() {
  if (compileTimer) clearTimeout(compileTimer);
  compileTimer = setTimeout(triggerCompile, 180);
}

async function triggerCompile() {
  if (compiling) {
    needsRecompile = true;
    return;
  }
  compiling = true;
  statusEl.classList.add("working");
  try {
    await compile();
  } finally {
    compiling = false;
    statusEl.classList.remove("working");
    if (needsRecompile) {
      needsRecompile = false;
      queueMicrotask(triggerCompile);
    }
  }
}

function changeSetToPatches(cs) {
  const out = [];
  cs.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    out.push({ from: fromA, to: toA, insert: inserted.toString() });
  });
  return out;
}

async function invokeCompile(args) {
  return invoke("compile_typst", args);
}

async function compile() {
  const cpath = activePath;
  const sync = getSyncState();
  const knownHashes = Array.from(pageCache.keys());
  const usePatchFlow = sync.hash !== null;
  const projectRoot = project.root;
  let result;

  if (usePatchFlow) {
    const patchesToSend = sync.pending;
    sync.pending = ChangeSet.empty(view.state.doc.length);
    try {
      result = await invokeCompile({
        filePath: cpath,
        projectRoot,
        patches: changeSetToPatches(patchesToSend),
        baseHash: sync.hash,
        knownHashes,
      });
    } catch (e) {
      setError(String(e));
      return;
    }
    if (result.resync_needed) {
      sync.pending = ChangeSet.empty(view.state.doc.length);
      try {
        result = await invokeCompile({
          filePath: cpath,
          projectRoot,
          fullSource: getDocText(view),
          knownHashes,
        });
      } catch (e) {
        setError(String(e));
        return;
      }
    }
  } else {
    const source = getDocText(view);
    sync.pending = ChangeSet.empty(source.length);
    try {
      result = await invokeCompile({
        filePath: cpath,
        projectRoot,
        fullSource: source,
        knownHashes,
      });
    } catch (e) {
      setError(String(e));
      return;
    }
  }

  sync.hash = result.source_hash;

  if (result.success) {
    requestAnimationFrame(() => renderPages(result.pages));
    clearError();
    const pageCount = result.pages.length;
    const mark = dirty ? " ●" : "";
    const t = result.timing;
    if (t) {
      console.log(
        `compile: apply=${t.apply_ms}ms compile=${t.compile_ms}ms svg=${t.svg_ms}ms total=${t.total_ms}ms`,
      );
    }
    statusEl.textContent = `${fileName(cpath)}${mark} · ${pageCount} page${
      pageCount === 1 ? "" : "s"
    } · ${t ? t.total_ms : "?"}ms`;
  } else {
    setError(result.error || "Unknown compile error");
  }
}

function svgToFragment(slot, svg) {
  const range = document.createRange();
  range.selectNodeContents(slot);
  return range.createContextualFragment(svg);
}

function renderPages(pages) {
  for (const { hash, svg } of pages) {
    if (svg != null) pageCache.set(hash, svg);
  }

  while (previewEl.children.length > pages.length) {
    previewEl.lastChild.remove();
  }
  while (previewEl.children.length < pages.length) {
    const div = document.createElement("div");
    div.className = "page";
    previewEl.appendChild(div);
  }

  const updates = [];
  for (let i = 0; i < pages.length; i++) {
    const hash = pages[i].hash;
    if (pageHashByIndex[i] !== hash) {
      const svg = pageCache.get(hash);
      if (svg) updates.push({ i, svg });
      pageHashByIndex[i] = hash;
    }
  }
  pageHashByIndex.length = pages.length;

  if (updates.length <= 2) {
    for (const { i, svg } of updates) {
      const slot = previewEl.children[i];
      slot.replaceChildren(svgToFragment(slot, svg));
    }
  } else {
    const PER_FRAME = 2;
    let cursor = 0;
    const step = () => {
      const end = Math.min(cursor + PER_FRAME, updates.length);
      for (let k = cursor; k < end; k++) {
        const { i, svg } = updates[k];
        const slot = previewEl.children[i];
        if (slot) slot.replaceChildren(svgToFragment(slot, svg));
      }
      cursor = end;
      if (cursor < updates.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const live = new Set(pages.map((p) => p.hash));
  for (const h of pageCache.keys()) {
    if (!live.has(h)) pageCache.delete(h);
  }
}

/* =====================================================================
   File ops + project mode
   --------------------------------------------------------------------- */

const ENTRY_FILE_CANDIDATES = ["main.typ", "book.typ", "index.typ"];

function closeProject() {
  cancelAutosave();
  if (activePath && dirty) autosaveBuffer(activePath);
  project.root = null;
  project.files = [];
  project.collapsed.clear();
  buffers.clear();
  syncByFile.clear();
  pageHashByIndex = [];
  pageCache.clear();
  previewEl.innerHTML = "";
  saveProjectState();
}

function saveProjectState() {
  try {
    if (project.root) {
      localStorage.setItem(
        PROJECT_STATE_KEY,
        JSON.stringify({
          root: project.root,
          activePath,
          collapsed: Array.from(project.collapsed),
        }),
      );
    } else {
      localStorage.removeItem(PROJECT_STATE_KEY);
    }
  } catch {}
}

function loadProjectState() {
  try {
    const raw = localStorage.getItem(PROJECT_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Picks which file to open first when a folder is loaded. Prefers a few
// well-known top-level names, then any .typ at the root, then any .typ anywhere.
function pickInitialFile(files) {
  for (const candidate of ENTRY_FILE_CANDIDATES) {
    const hit = files.find((f) => !f.is_dir && f.rel_path === candidate);
    if (hit) return hit.path;
  }
  const rootTyp = files.find(
    (f) => !f.is_dir && !f.rel_path.includes("/") && f.rel_path.endsWith(".typ"),
  );
  if (rootTyp) return rootTyp.path;
  const anyTyp = files.find((f) => !f.is_dir && f.rel_path.endsWith(".typ"));
  return anyTyp ? anyTyp.path : null;
}

async function refreshProjectFiles() {
  if (!project.root) return;
  try {
    project.files = await invoke("list_project_files", { root: project.root });
  } catch (e) {
    setError("List failed: " + e);
    project.files = [];
  }
  renderFileTree();
}

async function openFolder() {
  try {
    const selected = await open({
      multiple: false,
      directory: true,
    });
    if (!selected) return;
    const root = typeof selected === "string" ? selected : selected.path;
    await openProjectAt(root);
  } catch (e) {
    setError("Open folder failed: " + e);
  }
}

async function openProjectAt(root, preferredActive = null, opts = {}) {
  let files;
  try {
    files = await invoke("list_project_files", { root });
  } catch (e) {
    setError("List failed: " + e);
    return;
  }
  const initial = pickInitialFile(files);
  if (!initial) {
    setError("No .typ file found in folder");
    return;
  }
  cancelAutosave();
  if (activePath && dirty) autosaveBuffer(activePath);
  buffers.clear();
  syncByFile.clear();
  pageHashByIndex = [];
  pageCache.clear();
  previewEl.innerHTML = "";

  project.root = root;
  project.files = files;
  if (!opts.keepCollapsed) project.collapsed.clear();
  activePath = null;

  const target =
    preferredActive && files.some((f) => f.path === preferredActive) ? preferredActive : initial;
  await loadFileIntoView(target, { isInitial: true });

  saveProjectState();
  renderFileTree();
  updateStatus();
  triggerCompile();
}

async function ensureBuffer(path) {
  if (buffers.has(path)) return buffers.get(path);
  const content = await invoke("read_file_text", { path });
  const state = createEditorState(content, handleEdit, {
    lineNumbers: settings.lineNumbers,
    tabSize: settings.tabSize,
  });
  const buf = { state, dirty: false };
  buffers.set(path, buf);
  return buf;
}

async function loadFileIntoView(path, opts = {}) {
  const previousPath = activePath;
  if (activePath && buffers.has(activePath)) {
    buffers.get(activePath).state = view.state;
  }
  // Flush the debounce timer and persist the previous file before switching —
  // otherwise the pending timer would fire against the new activePath.
  cancelAutosave();
  if (previousPath && dirty) autosaveBuffer(previousPath);
  let buf;
  try {
    buf = await ensureBuffer(path);
  } catch (e) {
    setError("Open failed: " + e);
    return;
  }
  view.setState(buf.state);
  activePath = path;
  dirty = buf.dirty;
  if (!opts.isInitial) {
    saveProjectState();
    renderFileTree();
    updateStatus();
    scheduleOutline();
    triggerCompile();
  }
}

async function openFile() {
  try {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Typst", extensions: ["typ"] }],
    });
    if (!selected) return;
    const path = typeof selected === "string" ? selected : selected.path;
    // "Open File" leaves project mode — it's an explicit choice to work on a
    // standalone document.
    closeProject();
    buffers.clear();
    const content = await invoke("read_file_text", { path });
    const state = createEditorState(content, handleEdit, {
      lineNumbers: settings.lineNumbers,
      tabSize: settings.tabSize,
    });
    const buf = { state, dirty: false };
    buffers.set(path, buf);
    view.setState(buf.state);
    activePath = path;
    dirty = false;
    pageHashByIndex = [];
    pageCache.clear();
    previewEl.innerHTML = "";
    syncByFile.set(syncKey(), {
      hash: null,
      pending: ChangeSet.empty(view.state.doc.length),
    });
    updateStatus();
    renderFileTree();
    scheduleOutline();
    triggerCompile();
  } catch (e) {
    setError("Open failed: " + e);
  }
}

async function saveFileAs() {
  const path = await save({
    defaultPath: activePath || "untitled.typ",
    filters: [{ name: "Typst", extensions: ["typ"] }],
  });
  if (!path) return;
  await writeCurrent(path);
}

async function saveFile() {
  if (!activePath) {
    await saveFileAs();
    return;
  }
  await writeCurrent(activePath);
}

async function writeCurrent(path) {
  const content = getDocText(view);
  try {
    await invoke("write_file_text", { path, content });
    const wasNew = activePath !== path;
    activePath = path;
    // Only clear dirty if the user hasn't typed since we captured the content —
    // otherwise we'd silently mark unsaved changes as saved.
    const stillUnchanged = getDocText(view) === content;
    if (stillUnchanged) dirty = false;
    const buf = buffers.get(path) || { state: view.state, dirty: false };
    if (stillUnchanged) buf.dirty = false;
    buffers.set(path, buf);
    if (wasNew && project.root) {
      // Refresh tree if the file was saved into the project.
      await refreshProjectFiles();
    } else {
      renderFileTree();
    }
    updateStatus(`Saved ${fileName(path)}`);
    setTimeout(updateStatus, 1500);
    triggerCompile();
  } catch (e) {
    setError("Save failed: " + e);
  }
}

/* =====================================================================
   Autosave
   --------------------------------------------------------------------- */

let autosaveTimer = null;
const autosaveInFlight = new Set(); // paths currently being written
const autosaveQueued = new Set(); // paths needing another pass after the current write

function scheduleAutosave() {
  if (!settings.autosave) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    autosaveBuffer(activePath);
  }, settings.autosaveDelay);
}

function cancelAutosave() {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
}

// Saves `path`'s buffer to disk. Reads content synchronously up to the
// `invoke` call so it can be safely called fire-and-forget right before
// switching files — the post-await checks re-validate the active state.
async function autosaveBuffer(path) {
  if (!settings.autosave || !path) return;
  const buf = buffers.get(path);
  if (!buf) return;
  const startedActive = path === activePath;
  // For the active buffer, the editor view holds the latest content; otherwise
  // `loadFileIntoView` has already mirrored view → buf.state on its way out.
  const content = startedActive ? getDocText(view) : buf.state.doc.toString();
  const wasDirty = startedActive ? dirty : buf.dirty;
  if (!wasDirty) return;
  if (autosaveInFlight.has(path)) {
    autosaveQueued.add(path);
    return;
  }
  autosaveInFlight.add(path);
  try {
    await invoke("write_file_text", { path, content });
    const buf2 = buffers.get(path);
    if (!buf2) return;
    const nowActive = path === activePath;
    if (nowActive) {
      if (getDocText(view) === content) {
        dirty = false;
        buf2.dirty = false;
        updateStatus();
      }
    } else if (buf2.state.doc.toString() === content) {
      buf2.dirty = false;
    }
    renderFileTree();
  } catch (e) {
    console.warn("autosave failed:", e);
  } finally {
    autosaveInFlight.delete(path);
    if (autosaveQueued.delete(path)) {
      // More edits arrived during the write — kick off another pass.
      autosaveBuffer(path);
    }
  }
}

async function newProjectFile() {
  if (!project.root) return;
  const path = await save({
    defaultPath: `${project.root}/untitled.typ`,
    filters: [{ name: "Typst", extensions: ["typ"] }],
  });
  if (!path) return;
  try {
    await invoke("write_file_text", { path, content: "" });
    await refreshProjectFiles();
    await loadFileIntoView(path);
    triggerCompile();
  } catch (e) {
    setError("Create failed: " + e);
  }
}

document.getElementById("btn-open").addEventListener("click", openFile);
document.getElementById("btn-save").addEventListener("click", saveFile);
document.getElementById("btn-open-folder").addEventListener("click", openFolder);
document.getElementById("btn-new-file").addEventListener("click", newProjectFile);

/* =====================================================================
   Export
   --------------------------------------------------------------------- */

const EXPORT_KEY = "galley.export.v1";
const FORMAT_META = {
  pdf: { ext: "pdf", label: "PDF", perPage: false },
  png: { ext: "png", label: "PNG", perPage: true },
  svg: { ext: "svg", label: "SVG", perPage: true },
  html: { ext: "html", label: "HTML", perPage: false },
};

const exportState = (() => {
  try {
    const raw = localStorage.getItem(EXPORT_KEY);
    if (raw) return { format: "pdf", ppi: 144, ...JSON.parse(raw) };
  } catch {}
  return { format: "pdf", ppi: 144 };
})();

const exportFormatEl = document.getElementById("export-format");
const exportPpiRow = document.getElementById("export-ppi-row");
const exportPpiEl = document.getElementById("export-ppi");
const exportPpiVal = document.getElementById("export-ppi-val");
const exportNote = document.getElementById("export-note");
const exportGo = document.getElementById("export-go");

function persistExport() {
  try {
    localStorage.setItem(EXPORT_KEY, JSON.stringify(exportState));
  } catch {}
}

function reflectExport() {
  exportFormatEl.value = exportState.format;
  exportPpiEl.value = exportState.ppi;
  exportPpiVal.textContent = `${exportState.ppi} dpi`;
  const meta = FORMAT_META[exportState.format];
  exportPpiRow.hidden = exportState.format !== "png";
  const pageCount = pageHashByIndex.length || 0;
  if (meta.perPage && pageCount > 1) {
    const width = String(pageCount).length;
    const example = "1".padStart(width, "0");
    exportNote.textContent = `${pageCount} pages — files will be numbered (e.g. name-${example}.${meta.ext}).`;
  } else if (exportState.format === "html") {
    exportNote.textContent =
      "Recompiles in HTML mode — paged-only syntax (e.g. #pagebreak) may not work.";
  } else {
    exportNote.textContent = "";
  }
}

toggleExport = makePopover(exportPanel, exportBtn, {
  onOpen: reflectExport,
  otherClose: () => toggleSettings?.(false),
});

exportFormatEl.addEventListener("change", (e) => {
  exportState.format = e.target.value;
  persistExport();
  reflectExport();
});

exportPpiEl.addEventListener("input", (e) => {
  exportState.ppi = +e.target.value;
  exportPpiVal.textContent = `${exportState.ppi} dpi`;
  persistExport();
});

function defaultExportBase() {
  const meta = FORMAT_META[exportState.format];
  if (activePath) {
    return activePath.replace(/\.typ$/i, "") + "." + meta.ext;
  }
  return `untitled.${meta.ext}`;
}

async function runExport() {
  const meta = FORMAT_META[exportState.format];
  let target;
  try {
    target = await save({
      defaultPath: defaultExportBase(),
      filters: [{ name: meta.label, extensions: [meta.ext] }],
    });
  } catch (e) {
    setError("Export failed: " + e);
    return;
  }
  if (!target) return;
  toggleExport(false);
  updateStatus(`Exporting ${meta.label}…`);
  statusEl.classList.add("working");
  try {
    const result = await invoke("export_document", {
      format: exportState.format,
      path: target,
      ppi: exportState.format === "png" ? exportState.ppi : null,
    });
    statusEl.classList.remove("working");
    const n = result.files.length;
    const summary =
      n === 1 ? fileName(result.files[0]) : `${n} files (${fileName(result.files[0])} …)`;
    updateStatus(`Exported ${meta.label}: ${summary}`);
    setTimeout(updateStatus, 2500);
  } catch (e) {
    statusEl.classList.remove("working");
    setError("Export failed: " + e);
  }
}

exportGo.addEventListener("click", runExport);

/* =====================================================================
   Toolbar actions
   --------------------------------------------------------------------- */

const bind = (id, fn) => document.getElementById(id).addEventListener("click", fn);

bind("btn-h1", () => prefixLines(view, "= "));
bind("btn-h2", () => prefixLines(view, "== "));
bind("btn-h3", () => prefixLines(view, "=== "));
bind("btn-bold", () => wrapSelection(view, "*", "*"));
bind("btn-italic", () => wrapSelection(view, "_", "_"));
bind("btn-strike", () => wrapSelection(view, "#strike[", "]"));
bind("btn-underline", () => wrapSelection(view, "#underline[", "]"));
bind("btn-list", () => prefixLines(view, "- "));
bind("btn-numlist", () => prefixLines(view, "+ "));
bind("btn-quote", () => wrapSelection(view, "#quote(block: true)[", "]"));
bind("btn-code", () => wrapSelection(view, "`", "`"));
bind("btn-codeblock", () => insertSnippet(view, "\n```\n$|\n```\n"));
bind("btn-math-inline", () => wrapSelection(view, "$", "$"));
bind("btn-math-block", () => insertSnippet(view, "\n$ $| $\n"));
bind("btn-link", () => wrapSelection(view, '#link("https://")[', "]"));
bind("btn-image", () => insertSnippet(view, '#image("$|")'));
bind("btn-table", () =>
  insertSnippet(view, "\n#table(\n  columns: 2,\n  [*Header 1*], [*Header 2*],\n  [$|], [],\n)\n"),
);
bind("btn-hr", () => insertSnippet(view, "\n#line(length: 100%)\n"));

/* =====================================================================
   View-mode segmented control
   --------------------------------------------------------------------- */

function applyViewMode(mode) {
  splitEl.classList.remove("view-both", "view-editor", "view-preview");
  splitEl.classList.add(`view-${mode}`);
  for (const btn of viewModeSeg.querySelectorAll("button")) {
    btn.classList.toggle("is-active", btn.dataset.mode === mode);
  }
}

for (const btn of viewModeSeg.querySelectorAll("button")) {
  btn.addEventListener("click", () => applyViewMode(btn.dataset.mode));
}

/* =====================================================================
   Pane resizer
   --------------------------------------------------------------------- */

let resizing = false;
let resizeStartX = 0;
let resizeStartW = 0;
resizerEl.addEventListener("pointerdown", (e) => {
  resizing = true;
  resizeStartX = e.clientX;
  resizeStartW = document.querySelector(".editor-pane").getBoundingClientRect().width;
  resizerEl.classList.add("dragging");
  resizerEl.setPointerCapture(e.pointerId);
});
resizerEl.addEventListener("pointermove", (e) => {
  if (!resizing) return;
  const dx = e.clientX - resizeStartX;
  const splitWidth = splitEl.getBoundingClientRect().width;
  const newW = Math.max(200, Math.min(splitWidth - 200, resizeStartW + dx));
  splitEl.style.setProperty("--editor-w", `${newW}px`);
});
function endResize(e) {
  if (!resizing) return;
  resizing = false;
  resizerEl.classList.remove("dragging");
  try {
    resizerEl.releasePointerCapture(e.pointerId);
  } catch {}
}
resizerEl.addEventListener("pointerup", endResize);
resizerEl.addEventListener("pointercancel", endResize);
resizerEl.addEventListener("dblclick", () => {
  splitEl.style.removeProperty("--editor-w");
});

/* =====================================================================
   Preview zoom — buttons + keyboard shortcuts
   --------------------------------------------------------------------- */

const BASE_PAGE_WIDTH = 720;
const MIN_ZOOM = 20;
const MAX_ZOOM = 500;
let zoomPercent = 100;

function applyZoom() {
  const w = BASE_PAGE_WIDTH * (zoomPercent / 100);
  previewEl.style.setProperty("--page-width", `${w}px`);
  zoomLevelEl.textContent = `${Math.round(zoomPercent)}%`;
}

function setZoom(p) {
  zoomPercent = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, p));
  applyZoom();
}

document.getElementById("btn-zoom-in").addEventListener("click", () => setZoom(zoomPercent + 10));
document.getElementById("btn-zoom-out").addEventListener("click", () => setZoom(zoomPercent - 10));
document.getElementById("btn-zoom-reset").addEventListener("click", () => setZoom(100));
document.getElementById("btn-zoom-fit").addEventListener("click", () => {
  const avail = previewScrollEl.clientWidth - 40;
  if (avail > 0) setZoom((avail / BASE_PAGE_WIDTH) * 100);
});

/* =====================================================================
   Keyboard shortcuts
   --------------------------------------------------------------------- */

window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === "o") {
    e.preventDefault();
    if (e.shiftKey) openFolder();
    else openFile();
  } else if (k === "s") {
    e.preventDefault();
    if (e.shiftKey) saveFileAs();
    else saveFile();
  } else if (k === "b") {
    e.preventDefault();
    wrapSelection(view, "*", "*");
  } else if (k === "i") {
    e.preventDefault();
    wrapSelection(view, "_", "_");
  } else if (k === "=" || k === "+") {
    e.preventDefault();
    setZoom(zoomPercent + 10);
  } else if (k === "-") {
    e.preventDefault();
    setZoom(zoomPercent - 10);
  } else if (k === "0") {
    e.preventDefault();
    setZoom(100);
  } else if (k === ",") {
    e.preventDefault();
    toggleSettings();
  } else if (k === "f" && !e.altKey) {
    e.preventDefault();
    openFind(view);
  } else if (k === "e") {
    e.preventDefault();
    toggleExport();
  }
});

/* =====================================================================
   Reverse search (click preview → jump source)
   --------------------------------------------------------------------- */

previewEl.addEventListener("click", async (e) => {
  const pageEl = e.target.closest(".page");
  if (!pageEl) return;
  const svg = pageEl.querySelector("svg");
  if (!svg) return;

  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const vb = svg.viewBox && svg.viewBox.baseVal;
  if (!vb || vb.width === 0 || vb.height === 0) return;

  const xPt = ((e.clientX - rect.left) / rect.width) * vb.width;
  const yPt = ((e.clientY - rect.top) / rect.height) * vb.height;

  const pageIndex = Array.prototype.indexOf.call(previewEl.children, pageEl);
  if (pageIndex < 0) return;

  try {
    const result = await invoke("jump_from_click", {
      pageIndex,
      x: xPt,
      y: yPt,
    });
    if (!result || !result.found) return;
    if (result.url) return;
    if (result.offset_utf16 != null) gotoOffset(view, result.offset_utf16);
  } catch (err) {
    console.warn("jump_from_click failed:", err);
  }
});

/* =====================================================================
   File tree
   --------------------------------------------------------------------- */

const fileTreeEl = document.getElementById("file-tree");
const fileTreeEmptyEl = document.getElementById("file-tree-empty");
const projectNameEl = document.getElementById("project-name");
const newFileBtn = document.getElementById("btn-new-file");

// Build a nested tree from the flat list returned by the backend. Walk emits
// entries in pre-order (dirs first within each level, then alphabetical), so
// the children list for each node ends up in the same order.
function buildTreeNodes(files) {
  const root = { rel: "", children: new Map(), entries: [] };
  const dirNodes = new Map();
  dirNodes.set("", root);
  for (const f of files) {
    if (f.rel_path === "") continue;
    const parts = f.rel_path.split("/").filter(Boolean);
    const parentRel = parts.slice(0, -1).join("/");
    const parent = dirNodes.get(parentRel) || root;
    parent.entries.push(f);
    if (f.is_dir) {
      const child = { rel: f.rel_path, children: new Map(), entries: [] };
      parent.children.set(parts[parts.length - 1], child);
      dirNodes.set(f.rel_path, child);
    }
  }
  return root;
}

function isVisibleFile(name) {
  return name.endsWith(".typ");
}

// Returns true if this node has at least one visible file in its subtree.
function nodeHasVisible(node) {
  for (const entry of node.entries) {
    if (!entry.is_dir && isVisibleFile(entry.name)) return true;
    if (entry.is_dir) {
      const child = node.children.get(entry.name);
      if (child && nodeHasVisible(child)) return true;
    }
  }
  return false;
}

function renderFileTree() {
  if (!project.root) {
    fileTreeEl.replaceChildren();
    fileTreeEmptyEl.hidden = false;
    projectNameEl.textContent = "No project";
    newFileBtn.hidden = true;
    return;
  }
  fileTreeEmptyEl.hidden = true;
  projectNameEl.textContent = project.root.split(/[\\/]/).pop() || project.root;
  newFileBtn.hidden = false;

  const tree = buildTreeNodes(project.files);
  const frag = document.createDocumentFragment();

  const renderNode = (node, depth) => {
    for (const entry of node.entries) {
      if (entry.is_dir) {
        const child = node.children.get(entry.name);
        if (!child || !nodeHasVisible(child)) continue;
        const collapsed = project.collapsed.has(entry.rel_path);
        const row = document.createElement("div");
        row.className = "tree-row tree-folder";
        row.style.setProperty("--indent", depth);
        row.dataset.relPath = entry.rel_path;
        const chev = document.createElement("span");
        chev.className = "tree-chev";
        chev.textContent = collapsed ? "▸" : "▾";
        const name = document.createElement("span");
        name.className = "tree-name";
        name.textContent = entry.name;
        row.append(chev, name);
        frag.appendChild(row);
        if (!collapsed) renderNode(child, depth + 1);
      } else if (isVisibleFile(entry.name)) {
        const row = document.createElement("div");
        row.className = "tree-row tree-file";
        row.style.setProperty("--indent", depth);
        row.dataset.path = entry.path;
        if (entry.path === activePath) row.classList.add("is-active");
        const buf = buffers.get(entry.path);
        if (buf && buf.dirty) row.classList.add("is-dirty");
        const name = document.createElement("span");
        name.className = "tree-name";
        name.textContent = entry.name;
        row.appendChild(name);
        if (buf && buf.dirty) {
          const dot = document.createElement("span");
          dot.className = "tree-dot";
          dot.title = "Unsaved changes";
          row.appendChild(dot);
        }
        frag.appendChild(row);
      }
    }
  };

  renderNode(tree, 0);
  fileTreeEl.replaceChildren(frag);
}

fileTreeEl.addEventListener("click", (e) => {
  const folder = e.target.closest(".tree-folder");
  if (folder) {
    const rel = folder.dataset.relPath;
    if (project.collapsed.has(rel)) project.collapsed.delete(rel);
    else project.collapsed.add(rel);
    renderFileTree();
    saveProjectState();
    return;
  }
  const file = e.target.closest(".tree-file");
  if (file) {
    const path = file.dataset.path;
    if (path && path !== activePath) loadFileIntoView(path);
  }
});

/* =====================================================================
   Outline sidebar
   --------------------------------------------------------------------- */

const sidebarListEl = document.getElementById("sidebar-list");
const sidebarEmptyEl = document.getElementById("sidebar-empty");
const sidebarToggleBtn = document.getElementById("btn-sidebar");

let outlineTimer = null;

// Parse the doc into headings (h1-h3) and explicit #pagebreak markers,
// preserving source offsets so each entry can jump the editor.
function buildOutline(text) {
  const items = [];
  const lines = text.split("\n");
  let offset = 0;
  let inRaw = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      inRaw = !inRaw;
      offset += line.length + 1;
      continue;
    }
    if (!inRaw) {
      const m = line.match(/^(={1,3})(?=\s)\s+(.+?)\s*$/);
      if (m) {
        items.push({
          type: "heading",
          level: m[1].length,
          text: m[2],
          offset,
        });
      }
      const pb = /#pagebreak\b/g;
      let pm;
      while ((pm = pb.exec(line)) !== null) {
        items.push({ type: "pagebreak", offset: offset + pm.index });
      }
    }
    offset += line.length + 1;
  }
  return items;
}

function renderOutline() {
  const items = buildOutline(getDocText(view));
  sidebarListEl.replaceChildren();
  if (items.length === 0) {
    sidebarEmptyEl.hidden = false;
    return;
  }
  sidebarEmptyEl.hidden = true;
  const frag = document.createDocumentFragment();
  for (const item of items) {
    if (item.type === "heading") {
      const a = document.createElement("a");
      a.className = `outline-item level-${item.level}`;
      a.textContent = item.text;
      a.dataset.offset = item.offset;
      a.title = item.text;
      a.tabIndex = 0;
      a.href = "#";
      frag.appendChild(a);
    } else {
      const hr = document.createElement("div");
      hr.className = "outline-pagebreak";
      hr.dataset.offset = item.offset;
      hr.setAttribute("role", "button");
      hr.setAttribute("aria-label", "Page break");
      hr.title = "Page break";
      hr.tabIndex = 0;
      frag.appendChild(hr);
    }
  }
  sidebarListEl.appendChild(frag);
}

function scheduleOutline() {
  if (outlineTimer) clearTimeout(outlineTimer);
  outlineTimer = setTimeout(renderOutline, 120);
}

sidebarListEl.addEventListener("click", (e) => {
  const target = e.target.closest("[data-offset]");
  if (!target) return;
  e.preventDefault();
  gotoOffset(view, +target.dataset.offset);
});

sidebarListEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const target = e.target.closest("[data-offset]");
  if (!target) return;
  e.preventDefault();
  gotoOffset(view, +target.dataset.offset);
});

function applySidebarVisibility() {
  document.body.classList.toggle("sidebar-hidden", !settings.sidebarVisible);
  sidebarToggleBtn.classList.toggle("is-active", settings.sidebarVisible);
}

sidebarToggleBtn.addEventListener("click", () => {
  settings.sidebarVisible = !settings.sidebarVisible;
  applySidebarVisibility();
  saveSettings(settings);
});

applySidebarVisibility();

/* =====================================================================
   Boot
   --------------------------------------------------------------------- */

applyZoom();
renderFileTree();

(async function boot() {
  const saved = loadProjectState();
  if (saved && saved.root) {
    project.collapsed = new Set(saved.collapsed || []);
    await openProjectAt(saved.root, saved.activePath, { keepCollapsed: true });
    return;
  }
  updateStatus();
  renderOutline();
  triggerCompile();
})();
