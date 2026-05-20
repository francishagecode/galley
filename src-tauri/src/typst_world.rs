use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use chrono::{DateTime, Datelike, FixedOffset, Local, Utc};
use parking_lot::{Mutex, RwLock};
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime};
use typst::syntax::{FileId, Source, VirtualPath};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Feature, Features, Library, LibraryExt, World};

use typst_kit::download::ProgressSink;
use typst_kit::fonts::{FontSlot, Fonts};
use typst_kit::package::PackageStorage;

/// Shared, expensive-to-build state reused across compilations.
pub struct SharedAssets {
    pub fonts_book: LazyHash<FontBook>,
    pub fonts_slots: Vec<FontSlot>,
    pub packages: PackageStorage,
}

impl SharedAssets {
    pub fn new(user_agent: &str) -> Self {
        let mut searcher = Fonts::searcher();
        searcher.include_system_fonts(true);
        let fonts = searcher.search();

        let packages = PackageStorage::new(
            None,
            None,
            typst_kit::download::Downloader::new(user_agent),
        );

        Self {
            fonts_book: LazyHash::new(fonts.book),
            fonts_slots: fonts.fonts,
            packages,
        }
    }
}

/// A per-document Typst world. Holds the project root, current main source,
/// and per-compilation caches. Shares fonts + package storage with peer worlds
/// through an `Arc<SharedAssets>`.
pub struct EditorWorld {
    pub file_path: Option<PathBuf>,
    pub project_root: Option<PathBuf>,
    root: PathBuf,
    main: FileId,
    main_source: Arc<RwLock<String>>,
    library: LazyHash<Library>,
    assets: Arc<SharedAssets>,
    slots: Mutex<HashMap<FileId, FileSlot>>,
    now: OnceLock<DateTime<Utc>>,
}

impl EditorWorld {
    pub fn new(
        file_path: Option<PathBuf>,
        project_root: Option<PathBuf>,
        source: String,
        assets: Arc<SharedAssets>,
    ) -> Result<Self, String> {
        let main_source = Arc::new(RwLock::new(source));

        // Project root takes precedence when supplied (e.g. compiling a chapter
        // inside a book), so cross-file imports like `../_setup.typ` resolve.
        // Fall back to the source file's parent directory.
        let (root, main) = match file_path.as_ref() {
            Some(p) => {
                let abs = p
                    .canonicalize()
                    .map_err(|e| format!("canonicalize {}: {}", p.display(), e))?;
                let parent = abs
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| PathBuf::from("/"));
                let root_dir = match project_root.as_ref() {
                    Some(pr) => pr
                        .canonicalize()
                        .map_err(|e| format!("canonicalize {}: {}", pr.display(), e))?,
                    None => parent,
                };
                let vpath = VirtualPath::within_root(&abs, &root_dir)
                    .ok_or_else(|| "source file outside project root".to_string())?;
                let main = FileId::new(None, vpath);
                (root_dir, main)
            }
            None => {
                let tmp = std::env::temp_dir().join("galley");
                let _ = std::fs::create_dir_all(&tmp);
                let main = FileId::new_fake(VirtualPath::new("untitled.typ"));
                (tmp, main)
            }
        };

        Ok(Self {
            file_path,
            project_root,
            root,
            main,
            main_source,
            library: LazyHash::new(
                Library::builder()
                    .with_features(Features::from_iter([Feature::Html]))
                    .build(),
            ),
            assets,
            slots: Mutex::new(HashMap::new()),
            now: OnceLock::new(),
        })
    }

    /// Replace the in-memory main source. Caller must follow this with `reset()`
    /// to invalidate caches before the next compilation.
    pub fn set_source(&self, source: String) {
        *self.main_source.write() = source;
    }

    /// Reset per-compilation state.
    pub fn reset(&mut self) {
        for slot in self.slots.get_mut().values_mut() {
            slot.reset();
        }
        self.now.take();
    }

    fn slot<F, T>(&self, id: FileId, f: F) -> T
    where
        F: FnOnce(&mut FileSlot) -> T,
    {
        let mut map = self.slots.lock();
        f(map.entry(id).or_insert_with(|| FileSlot::new(id)))
    }
}

impl typst_ide::IdeWorld for EditorWorld {
    fn upcast(&self) -> &dyn World {
        self
    }
}

impl World for EditorWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.assets.fonts_book
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        self.slot(id, |slot| {
            slot.source(self.main, &self.main_source, &self.root, &self.assets.packages)
        })
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.slot(id, |slot| {
            slot.file(self.main, &self.main_source, &self.root, &self.assets.packages)
        })
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.assets.fonts_slots.get(index)?.get()
    }

    fn today(&self, offset: Option<i64>) -> Option<Datetime> {
        let now = self.now.get_or_init(Utc::now);
        let with_offset = match offset {
            None => now.with_timezone(&Local).fixed_offset(),
            Some(hours) => {
                let seconds = i32::try_from(hours).ok()?.checked_mul(3600)?;
                now.with_timezone(&FixedOffset::east_opt(seconds)?)
            }
        };
        Datetime::from_ymd(
            with_offset.year(),
            with_offset.month().try_into().ok()?,
            with_offset.day().try_into().ok()?,
        )
    }
}

struct FileSlot {
    id: FileId,
    source: SlotCell<Source>,
    file: SlotCell<Bytes>,
}

impl FileSlot {
    fn new(id: FileId) -> Self {
        Self {
            id,
            file: SlotCell::new(),
            source: SlotCell::new(),
        }
    }

    fn reset(&mut self) {
        self.source.reset();
        self.file.reset();
    }

    fn source(
        &mut self,
        main: FileId,
        main_source: &Arc<RwLock<String>>,
        root: &Path,
        packages: &PackageStorage,
    ) -> FileResult<Source> {
        let id = self.id;
        self.source.get_or_init(
            || read(id, main, main_source, root, packages),
            |data, prev| {
                let text = decode_utf8(&data)?;
                if let Some(mut prev) = prev {
                    prev.replace(text);
                    Ok(prev)
                } else {
                    Ok(Source::new(id, text.into()))
                }
            },
        )
    }

    fn file(
        &mut self,
        main: FileId,
        main_source: &Arc<RwLock<String>>,
        root: &Path,
        packages: &PackageStorage,
    ) -> FileResult<Bytes> {
        let id = self.id;
        self.file.get_or_init(
            || read(id, main, main_source, root, packages),
            |data, _| Ok(Bytes::new(data)),
        )
    }
}

struct SlotCell<T> {
    data: Option<FileResult<T>>,
    fingerprint: u128,
    accessed: bool,
}

impl<T: Clone> SlotCell<T> {
    fn new() -> Self {
        Self {
            data: None,
            fingerprint: 0,
            accessed: false,
        }
    }

    fn reset(&mut self) {
        self.accessed = false;
    }

    fn get_or_init(
        &mut self,
        load: impl FnOnce() -> FileResult<Vec<u8>>,
        f: impl FnOnce(Vec<u8>, Option<T>) -> FileResult<T>,
    ) -> FileResult<T> {
        if std::mem::replace(&mut self.accessed, true) {
            if let Some(data) = &self.data {
                return data.clone();
            }
        }

        let result = load();
        let fingerprint = typst::utils::hash128(&result);

        if std::mem::replace(&mut self.fingerprint, fingerprint) == fingerprint {
            if let Some(data) = &self.data {
                return data.clone();
            }
        }

        let prev = self.data.take().and_then(Result::ok);
        let value = result.and_then(|data| f(data, prev));
        self.data = Some(value.clone());
        value
    }
}

fn read(
    id: FileId,
    main: FileId,
    main_source: &Arc<RwLock<String>>,
    root: &Path,
    packages: &PackageStorage,
) -> FileResult<Vec<u8>> {
    if id == main {
        return Ok(main_source.read().as_bytes().to_vec());
    }
    read_from_disk(&system_path(root, id, packages)?)
}

fn system_path(
    project_root: &Path,
    id: FileId,
    packages: &PackageStorage,
) -> FileResult<PathBuf> {
    let buf;
    let mut root = project_root;
    if let Some(spec) = id.package() {
        let mut sink = ProgressSink;
        buf = packages.prepare_package(spec, &mut sink)?;
        root = &buf;
    }
    id.vpath().resolve(root).ok_or(FileError::AccessDenied)
}

fn read_from_disk(path: &Path) -> FileResult<Vec<u8>> {
    let f = |e| FileError::from_io(e, path);
    if std::fs::metadata(path).map_err(f)?.is_dir() {
        Err(FileError::IsDirectory)
    } else {
        std::fs::read(path).map_err(f)
    }
}

fn decode_utf8(buf: &[u8]) -> FileResult<&str> {
    Ok(std::str::from_utf8(buf.strip_prefix(b"\xef\xbb\xbf").unwrap_or(buf))?)
}
