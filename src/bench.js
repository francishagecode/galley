// Dev-only rendering benchmark. Only imported when `import.meta.env.DEV`, and
// only runs when scripts/bench.sh has dropped a request file, so normal dev
// sessions and release builds are unaffected.
//
// Measures requestAnimationFrame cadence while idle, while scrolling the
// preview and the editor, and while typing. rAF is paced by what the
// compositor can actually present, so slow work shows up as long frames.

import { invoke } from "./platform.js";
import { EditorView } from "@codemirror/view";

const DIR = "/tmp/galley-bench";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(r));

async function readJSON(path) {
  try {
    return JSON.parse(await invoke("read_file_text", { path }));
  } catch {
    return null;
  }
}

function stats(deltas) {
  const sorted = [...deltas].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const total = deltas.reduce((a, b) => a + b, 0);
  const round = (x) => Math.round(x * 100) / 100;
  return {
    frames: deltas.length,
    fps: round((deltas.length / total) * 1000),
    p50: round(pct(50)),
    p95: round(pct(95)),
    p99: round(pct(99)),
    max: round(sorted[sorted.length - 1]),
    over16ms: deltas.filter((d) => d > 16.7).length,
    over33ms: deltas.filter((d) => d > 33.4).length,
  };
}

// Calls `step(progress)` once per frame for `ms`, returning frame stats.
async function run(ms, step) {
  const deltas = [];
  let last = await frame();
  const start = last;
  while (last - start < ms) {
    const t = await frame();
    deltas.push(t - last);
    last = t;
    step?.(Math.min(1, (t - start) / ms));
  }
  return stats(deltas);
}

// Scrolls `el` top → bottom → top at constant speed.
function scrollScenario(el, ms) {
  el.scrollTop = 0;
  return run(ms, (p) => {
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = (p < 0.5 ? p * 2 : (1 - p) * 2) * max;
  });
}

// Types into the middle of the document at a fast typist's pace, measuring
// frame cadence while typing, how often the preview refreshed mid-typing, and
// how long the preview took to settle after the last keystroke.
async function typingScenario(ms, intervalMs) {
  const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
  const text = view.state.doc.toString();
  const anchor = text.indexOf("== Strike");
  let pos = anchor > 0 ? anchor : Math.floor(text.length / 2);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  await sleep(500);

  const swaps = [];
  const observer = new MutationObserver(() => swaps.push(performance.now()));
  observer.observe(document.getElementById("preview"), { childList: true, subtree: true });

  let lastKey = 0;
  let nextKey = 0;
  const frames = await run(ms, () => {
    const now = performance.now();
    if (now >= nextKey) {
      view.dispatch({ changes: { from: pos, insert: "x" }, userEvent: "input.type" });
      pos += 1;
      lastKey = now;
      nextKey = now + intervalMs;
    }
  });
  const t0 = performance.now();
  while (performance.now() - t0 < 3000 && !swaps.some((t) => t > lastKey)) await sleep(10);
  await sleep(300);
  observer.disconnect();
  const after = swaps.filter((t) => t > lastKey);
  return {
    ...frames,
    previewUpdatesWhileTyping: new Set(swaps.filter((t) => t <= lastKey).map((t) => Math.round(t)))
      .size,
    settleMs: after.length ? Math.round(Math.max(...after) - lastKey) : null,
  };
}

async function waitForPages(timeout) {
  const t0 = performance.now();
  let lastCount = -1;
  let stableSince = performance.now();
  while (performance.now() - t0 < timeout) {
    const pages = document.querySelectorAll("#preview .page");
    const filled = [...pages].filter((p) => p.firstElementChild).length;
    if (filled !== lastCount) {
      lastCount = filled;
      stableSince = performance.now();
    } else if (filled > 0 && performance.now() - stableSince > 800) {
      // Only pages near the viewport get images, so wait for those to settle.
      return filled;
    }
    await sleep(100);
  }
  return lastCount;
}

async function main() {
  const req = await readJSON(`${DIR}/request.json`);
  if (!req) return;

  // Open the requested project the way the app restores its last session.
  const saved = JSON.parse(localStorage.getItem("galley.project.v1") || "null");
  if (req.project && saved?.root !== req.project) {
    const state = { root: req.project, activePath: `${req.project}/main.typ`, collapsed: [] };
    localStorage.setItem("galley.project.v1", JSON.stringify(state));
    location.reload();
    return;
  }

  if (req.css) {
    const style = document.createElement("style");
    style.textContent = req.css;
    document.head.appendChild(style);
  }

  const pages = await waitForPages(30000);
  await sleep(1000);

  const preview = document.querySelector(".preview-scroll");
  const editor = document.querySelector(".cm-scroller");
  const ms = req.durationMs ?? 4000;
  const result = {
    label: req.label,
    pages,
    window: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
    previewScrollHeight: preview.scrollHeight,
    domNodes: document.getElementsByTagName("*").length,
  };

  result.idle = await run(1000);
  for (let i = 0; i < (req.repeats ?? 2); i++) {
    result[`preview${i}`] = await scrollScenario(preview, ms);
    await sleep(300);
  }
  result.editor = await scrollScenario(editor, ms);
  result.typing = await typingScenario(3000, 80);

  await invoke("write_file_text", {
    path: `${DIR}/result.json`,
    content: JSON.stringify(result, null, 2),
  });
}

main();
