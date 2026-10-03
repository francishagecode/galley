//! Galley's Typst engine: compiling, page rasterization, click-to-source and
//! export, independent of the app shell. The Electron app reaches it through
//! the Node native module in `native/`.

mod typst_world;

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::thread::JoinHandle;
use std::time::Instant;

use parking_lot::Mutex;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use typst::layout::{Page, PagedDocument};
use typst_html::HtmlDocument;

use typst_world::{EditorWorld, SharedAssets};

#[derive(Serialize)]
pub struct PageData {
    /// Content hash; also names the page's image in the `galley-page:` scheme.
    hash: String,
    width_pt: f64,
    height_pt: f64,
}

#[derive(Serialize, Default)]
pub struct CompileTiming {
    apply_ms: u64,
    compile_ms: u64,
    pages_ms: u64,
    total_ms: u64,
}

#[derive(Serialize)]
pub struct CompileResult {
    success: bool,
    pages: Vec<PageData>,
    error: Option<String>,
    resync_needed: bool,
    source_hash: String,
    timing: CompileTiming,
}

#[derive(Deserialize)]
pub struct Patch {
    from: u32,
    to: u32,
    insert: String,
}

#[derive(Default)]
struct SyncState {
    source_u16: Vec<u16>,
    hash: u64,
}

/// Pages of the last two compiles by content hash, served to the preview by
/// the `galley-page:` protocol. The previous compile's pages are kept so image
/// requests that race a newer compile still resolve.
#[derive(Default)]
struct PageStore {
    current: HashMap<String, Page>,
    previous: HashMap<String, Page>,
}

impl PageStore {
    fn replace(&mut self, pages: HashMap<String, Page>) {
        self.previous = std::mem::replace(&mut self.current, pages);
    }

    fn get(&self, hash: &str) -> Option<Page> {
        self.current
            .get(hash)
            .or_else(|| self.previous.get(hash))
            .cloned()
    }
}

/// Font discovery takes a few hundred milliseconds, so it starts on a
/// background thread when the engine is created and the first compile waits
/// for it, instead of blocking app startup.
struct PendingAssets {
    ready: OnceLock<Arc<SharedAssets>>,
    loading: Mutex<Option<JoinHandle<SharedAssets>>>,
}

impl PendingAssets {
    fn spawn(user_agent: String) -> Self {
        let loading = std::thread::spawn(move || SharedAssets::new(&user_agent));
        Self {
            ready: OnceLock::new(),
            loading: Mutex::new(Some(loading)),
        }
    }

    fn get(&self) -> Arc<SharedAssets> {
        self.ready
            .get_or_init(|| {
                let loading = self.loading.lock().take().expect("assets are loaded once");
                Arc::new(loading.join().expect("font discovery panicked"))
            })
            .clone()
    }
}

pub struct Engine {
    world: Mutex<Option<EditorWorld>>,
    assets: PendingAssets,
    sync: Mutex<HashMap<String, SyncState>>,
    document: Mutex<Option<PagedDocument>>,
    pages: Mutex<PageStore>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompileArgs {
    pub file_path: Option<String>,
    pub project_root: Option<String>,
    pub full_source: Option<String>,
    pub patches: Option<Vec<Patch>>,
    pub base_hash: Option<String>,
}

#[derive(Serialize, Default)]
pub struct JumpResult {
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

#[derive(Serialize)]
pub struct ExportResult {
    files: Vec<String>,
}

fn page_output_paths(base: &std::path::Path, count: usize, ext: &str) -> Vec<PathBuf> {
    if count <= 1 {
        return vec![base.with_extension(ext)];
    }
    let parent = base.parent().unwrap_or_else(|| std::path::Path::new("."));
    let stem = base.file_stem().and_then(|s| s.to_str()).unwrap_or("page");
    let width = (count as f64).log10().floor() as usize + 1;
    (0..count)
        .map(|i| parent.join(format!("{stem}-{:0width$}.{ext}", i + 1, width = width)))
        .collect()
}

#[derive(Serialize)]
pub struct DirEntryInfo {
    path: String,
    rel_path: String,
    name: String,
    is_dir: bool,
}

impl Engine {
    /// `user_agent` identifies the app when downloading Typst packages.
    pub fn new(user_agent: &str) -> Self {
        Self {
            world: Mutex::new(None),
            assets: PendingAssets::spawn(user_agent.to_owned()),
            sync: Mutex::new(HashMap::new()),
            document: Mutex::new(None),
            pages: Mutex::new(PageStore::default()),
        }
    }

    pub fn compile(&self, args: CompileArgs) -> Result<CompileResult, String> {
        let t_total = Instant::now();
        let CompileArgs {
            file_path,
            project_root,
            full_source,
            patches,
            base_hash,
        } = args;
        let file_path_buf = file_path.as_ref().map(PathBuf::from);
        let project_root_buf = project_root.as_ref().map(PathBuf::from);
        let key = sync_key(&file_path_buf);

        // ---- Apply source: patches if hash matches, otherwise full source.
        let t_apply = Instant::now();
        let mut sync_map = self.sync.lock();
        let sync = sync_map.entry(key.clone()).or_default();

        let source_string = if let Some(patches) = patches {
            // Patch send. Verify base_hash matches our current self.
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
        let mut slot = self.world.lock();
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
                self.assets.get(),
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
                // Pages are only identified here; the preview fetches the ones it
                // hasn't seen as images, rasterized on demand by `page_png`.
                let t_pages = Instant::now();
                let mut store = HashMap::with_capacity(doc.pages.len());
                let pages: Vec<PageData> = doc
                    .pages
                    .iter()
                    .map(|p| {
                        let hash = format!("{:032x}", typst::utils::hash128(p));
                        store.insert(hash.clone(), p.clone());
                        PageData {
                            hash,
                            width_pt: p.frame.width().to_pt(),
                            height_pt: p.frame.height().to_pt(),
                        }
                    })
                    .collect();
                self.pages.lock().replace(store);
                let pages_ms = t_pages.elapsed().as_millis() as u64;
                // Cache the document so `jump_from_click` can resolve source spans
                // for click positions in the preview.
                *self.document.lock() = Some(doc);
                Ok(CompileResult {
                    success: true,
                    pages,
                    error: None,
                    resync_needed: false,
                    source_hash: final_hash_hex,
                    timing: CompileTiming {
                        apply_ms,
                        compile_ms,
                        pages_ms,
                        total_ms: t_total.elapsed().as_millis() as u64,
                    },
                })
            }
            Err(diags) => Ok(CompileResult {
                success: false,
                pages: vec![],
                error: Some(format_diags(&diags[..])),
                resync_needed: false,
                source_hash: final_hash_hex,
                timing: CompileTiming {
                    apply_ms,
                    compile_ms,
                    pages_ms: 0,
                    total_ms: t_total.elapsed().as_millis() as u64,
                },
            }),
        }
    }

    pub fn jump_from_click(&self, page_index: usize, x: f64, y: f64) -> Result<JumpResult, String> {
        use typst::layout::{Abs, Point};
        use typst::World;

        let world_slot = self.world.lock();
        let world = world_slot.as_ref().ok_or("no world")?;
        let doc_slot = self.document.lock();
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

    pub fn export(
        &self,
        format: &str,
        path: &str,
        ppi: Option<f32>,
    ) -> Result<ExportResult, String> {
        let base_path = PathBuf::from(&path);
        let fmt = format.to_lowercase();

        match fmt.as_str() {
            "pdf" => {
                let doc_slot = self.document.lock();
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
                let doc_slot = self.document.lock();
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
                let doc_slot = self.document.lock();
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
                let mut slot = self.world.lock();
                let world = slot.as_mut().ok_or("no world — open a document first")?;
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

    /// Renders `<hash>-<width>.png`: the page with that content hash from a recent
    /// compile, rasterized `<width>` device pixels wide. The preview shows pages as
    /// these images, so the browser decodes them off its main thread rather
    /// than parsing and painting each page's SVG there on every edit.
    pub fn page_png(&self, name: &str) -> Option<Vec<u8>> {
        let (hash, width) = name.strip_suffix(".png")?.rsplit_once('-')?;
        let width: u32 = width.parse().ok().filter(|w| (1..=16384).contains(w))?;
        let page = self.pages.lock().get(hash)?;
        let pixel_per_pt = width as f32 / page.frame.width().to_pt() as f32;
        let pixmap = typst_render::render(&page, pixel_per_pt);

        let mut rgba = Vec::with_capacity(pixmap.data().len());
        for pixel in pixmap.pixels() {
            let c = pixel.demultiply();
            rgba.extend_from_slice(&[c.red(), c.green(), c.blue(), c.alpha()]);
        }
        let mut png = Vec::new();
        let mut encoder = png::Encoder::new(&mut png, pixmap.width(), pixmap.height());
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        encoder.write_header().ok()?.write_image_data(&rgba).ok()?;
        Some(png)
    }

    /// Runs a command by name with JSON arguments (camelCase keys, as the
    /// frontend sends them) and returns the JSON result.
    pub fn invoke_json(&self, command: &str, args: &str) -> Result<String, String> {
        fn parse<'a, T: Deserialize<'a>>(args: &'a str) -> Result<T, String> {
            serde_json::from_str(args).map_err(|e| e.to_string())
        }
        fn json<T: Serialize>(value: T) -> Result<String, String> {
            serde_json::to_string(&value).map_err(|e| e.to_string())
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct JumpArgs {
            page_index: usize,
            x: f64,
            y: f64,
        }
        #[derive(Deserialize)]
        struct ExportArgs {
            format: String,
            path: String,
            ppi: Option<f32>,
        }
        #[derive(Deserialize)]
        struct ListArgs {
            root: String,
        }
        match command {
            "compile_typst" => json(self.compile(parse(args)?)?),
            "jump_from_click" => {
                let a: JumpArgs = parse(args)?;
                json(self.jump_from_click(a.page_index, a.x, a.y)?)
            }
            "export_document" => {
                let a: ExportArgs = parse(args)?;
                json(self.export(&a.format, &a.path, a.ppi)?)
            }
            "list_project_files" => json(list_project_files(&parse::<ListArgs>(args)?.root)?),
            other => Err(format!("unknown command: {other}")),
        }
    }
}

pub fn list_project_files(root: &str) -> Result<Vec<DirEntryInfo>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let mut out = Vec::new();
    walk_project(&root_path, &root_path, &mut out, 0)?;
    Ok(out)
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
