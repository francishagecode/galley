// The frontend's bridge to the Electron main process (see electron/preload.cjs).

/** Runs a main-process command; rejects with the error message on failure. */
export const invoke = (command, args) => window.galley.invoke(command, args);

/** File dialogs: a path (or paths with `multiple`), or null when cancelled. */
export const open = (options) => window.galley.open(options);
export const save = (options) => window.galley.save(options);

/** A native question (`{ message, detail, confirm, cancel }`); true when `confirm` is chosen. */
export const ask = (options) => window.galley.ask(options);

/** Watches a folder (null to stop) for changes made outside Galley. */
export const watch = (root) => window.galley.watch(root);

/** Calls back with `{ paths, restructured }` once files under the watched folder change. */
export const onFilesChanged = (callback) => window.galley.onFilesChanged(callback);

/** The `{ root, file }` given on the command line (`galley <path>`), or null. Once only. */
export const takeLaunchTarget = () => window.galley.takeLaunchTarget();

/** Calls back with `{ root, file }` when `galley <path>` is run while Galley is open. */
export const onOpenRequest = (callback) => window.galley.onOpenRequest(callback);

/** URL of a preview page image rasterized by the engine (`<hash>-<width>.png`). */
export const pageImageUrl = (name) => `galley-page://localhost/${name}`;
