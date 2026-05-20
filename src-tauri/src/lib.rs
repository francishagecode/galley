mod typst_world;

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use typst::layout::PagedDocument;
use typst_html::HtmlDocument;

use typst_world::{EditorWorld, SharedAssets};

#[derive(Serialize)]
struct PageData {
    hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    svg: Option<String>,
}

#[derive(Serialize, Default)]
struct CompileTiming {
    apply_ms: u64,
    compile_ms: u64,
    svg_ms: u64,
    total_ms: u64,
}

#[derive(Serialize)]
struct CompileResult {
    success: bool,
    pages: Vec<PageData>,
    error: Option<String>,
    resync_needed: bool,
    source_hash: String,
    timing: CompileTiming,
}

#[derive(Deserialize)]
struct Patch {
    from: u32,
    to: u32,
    insert: String,
}

#[derive(Default)]
struct SyncState {
    source_u16: Vec<u16>,
    hash: u64,
}

struct AppState {
    world: Mutex<Option<EditorWorld>>,
    assets: Arc<SharedAssets>,
    sync: Mutex<HashMap<String, SyncState>>,
    document: Mutex<Option<PagedDocument>>,
}

impl AppState {
    fn new() -> Self {
        let ua = format!("galley/{}", env!("CARGO_PKG_VERSION"));
        Self {
            world: Mutex::new(None),
            assets: Arc::new(SharedAssets::new(&ua)),
            sync: Mutex::new(HashMap::new()),
            document: Mutex::new(None),
        }
    }
}

fn sync_key(path: &Option<PathBuf>) -> String {
    path.as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "<untitled>".to_string())
}

fn fast_hash<T: Hash + ?Sized>(v: &T) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    v.hash(&mut h);
    h.finish()
}

fn apply_patches(buf: &mut Vec<u16>, mut patches: Vec<Patch>) -> Result<(), String> {
    // Validate against the original length first so a bad patch can't leave
    // the buffer half-mutated.
    let orig_len = buf.len();
    for p in &patches {
        if p.from > p.to || (p.to as usize) > orig_len {
            return Err(format!(
                "patch out of range: from={} to={} len={orig_len}",
                p.from, p.to
            ));
        }
    }
    // Apply right-to-left so earlier positions stay valid.
    patches.sort_by_key(|p| std::cmp::Reverse(p.from));
    for p in patches {
        let insert: Vec<u16> = p.insert.encode_utf16().collect();
        buf.splice(p.from as usize..p.to as usize, insert);
    }
    Ok(())
}

fn same_path(a: &Option<PathBuf>, b: &Option<PathBuf>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => {
            let cx = x.canonicalize().ok();
            let cy = y.canonicalize().ok();
            cx == cy || x == y
        }
        (None, None) => true,
        _ => false,
    }
}

#[tauri::command]
async fn compile_typst(
    state: tauri::State<'_, AppState>,
    file_path: Option<String>,
    project_root: Option<String>,
    full_source: Option<String>,
    patches: Option<Vec<Patch>>,
    base_hash: Option<String>,
    known_hashes: Option<Vec<String>>,
) -> Result<CompileResult, String> {
    let t_total = Instant::now();
    let file_path_buf = file_path.as_ref().map(PathBuf::from);
    let project_root_buf = project_root.as_ref().map(PathBuf::from);
    let key = sync_key(&file_path_buf);
    let known: HashSet<String> = known_hashes.unwrap_or_default().into_iter().collect();

    // ---- Apply source: patches if hash matches, otherwise full source.
    let t_apply = Instant::now();
    let mut sync_map = state.sync.lock();
    let sync = sync_map.entry(key.clone()).or_default();

    let source_string = if let Some(patches) = patches {
        // Patch send. Verify base_hash matches our current state.
        let base = base_hash
            .as_deref()
            .and_then(|s| u64::from_str_radix(s, 16).ok());
        if base != Some(sync.hash) {
            // Resync needed: caller should retry with full_source.
            return Ok(CompileResult {
                success: false,
                pages: vec![],
                error: None,
                resync_needed: true,
                source_hash: format!("{:016x}", sync.hash),
                timing: CompileTiming::default(),
            });
        }
        apply_patches(&mut sync.source_u16, patches)?;
        sync.hash = fast_hash(&*sync.source_u16);
        String::from_utf16(&sync.source_u16).map_err(|e| e.to_string())?
    } else if let Some(full) = full_source {
        sync.source_u16 = full.encode_utf16().collect();
        sync.hash = fast_hash(&*sync.source_u16);
        full
    } else {
        return Err("must provide full_source or patches".into());
    };
    let final_hash_hex = format!("{:016x}", sync.hash);
    drop(sync_map);
    let apply_ms = t_apply.elapsed().as_millis() as u64;

    // ---- World + compile.
    let mut slot = state.world.lock();
    let rebuild = match slot.as_ref() {
        Some(w) => {
            !same_path(&w.file_path, &file_path_buf)
                || !same_path(&w.project_root, &project_root_buf)
        }
        None => true,
    };
    if rebuild {
        let world = EditorWorld::new(
            file_path_buf,
            project_root_buf,
            source_string.clone(),
            state.assets.clone(),
        )?;
        *slot = Some(world);
    }
    let world = slot.as_mut().ok_or("world not initialized")?;
    world.set_source(source_string);
    world.reset();

    let t_compile = Instant::now();
    let warned = typst::compile::<PagedDocument>(world);
    let compile_ms = t_compile.elapsed().as_millis() as u64;
    comemo::evict(30);

    match warned.output {
        Ok(doc) => {
            let t_svg = Instant::now();
            let pages: Vec<PageData> = doc
                .pages
                .par_iter()
                .map(|p| {
                    let svg = typst_svg::svg(p);
                    let hash = format!("{:016x}", fast_hash(&svg));
                    let svg = if known.contains(&hash) { None } else { Some(svg) };
                    PageData { hash, svg }
                })
                .collect();
            let svg_ms = t_svg.elapsed().as_millis() as u64;
            // Cache the document so `jump_from_click` can resolve source spans
            // for click positions in the preview.
            *state.document.lock() = Some(doc);
            Ok(CompileResult {
                success: true,
                pages,
                error: None,
                resync_needed: false,
                source_hash: final_hash_hex,
                timing: CompileTiming {
                    apply_ms,
                    compile_ms,
                    svg_ms,
                    total_ms: t_total.elapsed().as_millis() as u64,
                },
            })
        }
        Err(diags) => {
            Ok(CompileResult {
                success: false,
                pages: vec![],
                error: Some(format_diags(&diags[..])),
                resync_needed: false,
                source_hash: final_hash_hex,
                timing: CompileTiming {
                    apply_ms,
                    compile_ms,
                    svg_ms: 0,
                    total_ms: t_total.elapsed().as_millis() as u64,
                },
            })
        }
    }
}

#[derive(Serialize, Default)]
struct JumpResult {
    found: bool,
    /// UTF-16 code-unit offset in the main source (matches JS string indexing,
    /// which is what CodeMirror uses).
    offset_utf16: Option<u32>,
    /// 1-based line and column for status / debugging.
    line: Option<u32>,
    column: Option<u32>,
    /// If the jumped-to file is *not* the current main file, this is the
    /// resolved absolute path. The frontend can decide whether to open it.
    file_path: Option<String>,
    /// External URL, if the click was on a #link to one.
    url: Option<String>,
}

#[tauri::command]
fn jump_from_click(
    state: tauri::State<'_, AppState>,
    page_index: usize,
    x: f64,
    y: f64,
) -> Result<JumpResult, String> {
    use typst::layout::{Abs, Point};
    use typst::World;

    let world_slot = state.world.lock();
    let world = world_slot.as_ref().ok_or("no world")?;
    let doc_slot = state.document.lock();
    let doc = doc_slot.as_ref().ok_or("no document")?;

    let page = doc
        .pages
        .get(page_index)
        .ok_or_else(|| format!("page {page_index} out of range"))?;

    let click = Point::new(Abs::pt(x), Abs::pt(y));
    let jump = typst_ide::jump_from_click(world, doc, &page.frame, click);

    let Some(jump) = jump else {
        return Ok(JumpResult::default());
    };

    match jump {
        typst_ide::Jump::File(file_id, byte_offset) => {
            let source = world.source(file_id).map_err(|e| e.to_string())?;
            let text = source.text();
            let byte_offset = byte_offset.min(text.len());

            // byte offset → utf-16 offset (what CodeMirror uses)
            let prefix = &text[..byte_offset];
            let offset_utf16 = prefix.encode_utf16().count() as u32;

            // 1-based line/column.
            let mut line: u32 = 1;
            let mut column: u32 = 1;
            for ch in prefix.chars() {
                if ch == '\n' {
                    line += 1;
                    column = 1;
                } else {
                    column += 1;
                }
            }

            // Multi-file support out of scope; we only surface jumps inside the
            // currently-open main source.
            let file_path: Option<String> = None;

            Ok(JumpResult {
                found: true,
                offset_utf16: Some(offset_utf16),
                line: Some(line),
                column: Some(column),
                file_path,
                url: None,
            })
        }
        typst_ide::Jump::Url(url) => Ok(JumpResult {
            found: true,
            url: Some(url.to_string()),
            ..Default::default()
        }),
        typst_ide::Jump::Position(_) => Ok(JumpResult::default()),
    }
}

#[derive(Serialize)]
struct ExportResult {
    files: Vec<String>,
}

fn page_output_paths(base: &std::path::Path, count: usize, ext: &str) -> Vec<PathBuf> {
    if count <= 1 {
        return vec![base.with_extension(ext)];
    }
    let parent = base.parent().unwrap_or_else(|| std::path::Path::new("."));
    let stem = base
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("page");
    let width = (count as f64).log10().floor() as usize + 1;
    (0..count)
        .map(|i| parent.join(format!("{stem}-{:0width$}.{ext}", i + 1, width = width)))
        .collect()
}

#[tauri::command]
async fn export_document(
    state: tauri::State<'_, AppState>,
    format: String,
    path: String,
    ppi: Option<f32>,
) -> Result<ExportResult, String> {
    let base_path = PathBuf::from(&path);
    let fmt = format.to_lowercase();

    match fmt.as_str() {
        "pdf" => {
            let doc_slot = state.document.lock();
            let doc = doc_slot
                .as_ref()
                .ok_or("no compiled document — compile first")?;
            let buf = typst_pdf::pdf(doc, &typst_pdf::PdfOptions::default())
                .map_err(|diags| format_diags(&diags[..]))?;
            let out = base_path.with_extension("pdf");
            std::fs::write(&out, buf).map_err(|e| e.to_string())?;
            Ok(ExportResult {
                files: vec![out.to_string_lossy().into_owned()],
            })
        }
        "svg" => {
            let doc_slot = state.document.lock();
            let doc = doc_slot
                .as_ref()
                .ok_or("no compiled document — compile first")?;
            let paths = page_output_paths(&base_path, doc.pages.len(), "svg");
            for (page, out) in doc.pages.iter().zip(paths.iter()) {
                let svg = typst_svg::svg(page);
                std::fs::write(out, svg).map_err(|e| e.to_string())?;
            }
            Ok(ExportResult {
                files: paths
                    .into_iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect(),
            })
        }
        "png" => {
            let doc_slot = state.document.lock();
            let doc = doc_slot
                .as_ref()
                .ok_or("no compiled document — compile first")?;
            let pixel_per_pt = ppi.unwrap_or(144.0).max(24.0) / 72.0;
            let paths = page_output_paths(&base_path, doc.pages.len(), "png");
            let encoded: Result<Vec<Vec<u8>>, String> = doc
                .pages
                .par_iter()
                .map(|page| {
                    let pixmap = typst_render::render(page, pixel_per_pt);
                    pixmap.encode_png().map_err(|e| e.to_string())
                })
                .collect();
            let encoded = encoded?;
            for (bytes, out) in encoded.iter().zip(paths.iter()) {
                std::fs::write(out, bytes).map_err(|e| e.to_string())?;
            }
            Ok(ExportResult {
                files: paths
                    .into_iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect(),
            })
        }
        "html" => {
            let mut slot = state.world.lock();
            let world = slot
                .as_mut()
                .ok_or("no world — open a document first")?;
            world.reset();
            let warned = typst::compile::<HtmlDocument>(world);
            let doc = warned.output.map_err(|diags| format_diags(&diags[..]))?;
            let html = typst_html::html(&doc).map_err(|diags| format_diags(&diags[..]))?;
            let out = base_path.with_extension("html");
            std::fs::write(&out, html).map_err(|e| e.to_string())?;
            Ok(ExportResult {
                files: vec![out.to_string_lossy().into_owned()],
            })
        }
        other => Err(format!("unsupported export format: {other}")),
    }
}

fn format_diags(diags: &[typst::diag::SourceDiagnostic]) -> String {
    let mut msg = String::new();
    for d in diags.iter() {
        let label = match d.severity {
            typst::diag::Severity::Error => "error",
            typst::diag::Severity::Warning => "warning",
        };
        msg.push_str(&format!("{label}: {}\n", d.message));
        for hint in d.hints.iter() {
            msg.push_str(&format!("  hint: {hint}\n"));
        }
    }
    msg
}

#[tauri::command]
fn read_file_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file_text(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct DirEntryInfo {
    path: String,
    rel_path: String,
    name: String,
    is_dir: bool,
}

#[tauri::command]
fn list_project_files(root: String) -> Result<Vec<DirEntryInfo>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let mut out = Vec::new();
    walk_project(&root_path, &root_path, &mut out, 0)?;
    Ok(out)
}

fn walk_project(
    dir: &std::path::Path,
    root: &std::path::Path,
    out: &mut Vec<DirEntryInfo>,
    depth: usize,
) -> Result<(), String> {
    const MAX_DEPTH: usize = 8;
    const MAX_ENTRIES: usize = 4000;
    if depth > MAX_DEPTH {
        return Ok(());
    }
    let read = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut entries: Vec<_> = read.filter_map(|r| r.ok()).collect();
    entries.sort_by(|a, b| {
        let af = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let bf = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
        // dirs first, then alpha by name (case-insensitive)
        bf.cmp(&af).then_with(|| {
            let na = a.file_name().to_string_lossy().to_lowercase();
            let nb = b.file_name().to_string_lossy().to_lowercase();
            na.cmp(&nb)
        })
    });
    for entry in entries {
        if out.len() >= MAX_ENTRIES {
            return Ok(());
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if matches!(
            name.as_str(),
            "node_modules" | "target" | "dist" | "build" | "__pycache__"
        ) {
            continue;
        }
        let path = entry.path();
        let is_dir = match entry.file_type() {
            Ok(t) => t.is_dir(),
            Err(_) => continue,
        };
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        out.push(DirEntryInfo {
            path: path.to_string_lossy().into_owned(),
            rel_path: rel,
            name,
            is_dir,
        });
        if is_dir {
            walk_project(&path, root, out, depth + 1)?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(AppState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            compile_typst,
            jump_from_click,
            read_file_text,
            write_file_text,
            list_project_files,
            export_document
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
