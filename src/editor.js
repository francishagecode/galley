import { EditorState, EditorSelection, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  indentUnit,
} from "@codemirror/language";
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { typstCompletions } from "./typst-complete.js";
import {
  typstLanguage,
  typstHighlightStyle,
  typstWysiwygPlugin,
} from "./typst-language.js";

// Compartments let us swap individual extensions at runtime (e.g. toggling
// line numbers, changing tab size) without rebuilding the whole state.
const lineNumbersCompartment = new Compartment();
const tabSizeCompartment = new Compartment();

// Theme uses CSS variables so the page-level color-scheme switcher
// (theme-mariana / -monokai / -slate / -paper / -solar) retints the editor
// too — no second source of truth for colors.
const themedEditor = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--bg)",
      color: "var(--fg)",
      height: "100%",
      position: "relative",
    },
    ".cm-content": {
      caretColor: "var(--fg)",
      padding: "12px 14px 12px 6px",
    },
    ".cm-gutters": {
      backgroundColor: "var(--bg)",
      color: "var(--fg-faint)",
      border: "none",
      paddingRight: "8px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 4px 0 12px",
    },
    ".cm-activeLine": { backgroundColor: "var(--accent-2)" },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "var(--fg-dim)",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--accent)",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
      {
        backgroundColor: "var(--accent-3) !important",
      },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "var(--accent-2)",
      outline: "1px solid var(--accent)",
    },
    ".cm-tooltip.cm-tooltip-autocomplete": {
      backgroundColor: "var(--bg-elev)",
      border: "1px solid var(--border)",
      borderRadius: "var(--r-md)",
      boxShadow: "0 10px 28px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.25)",
      color: "var(--fg)",
      fontFamily: "var(--ed-font)",
      fontSize: "12px",
      padding: "2px",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": {
      maxHeight: "260px",
      fontFamily: "inherit",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
      padding: "3px 8px",
      borderRadius: "3px",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "var(--accent-2)",
      color: "var(--fg)",
    },
    ".cm-completionLabel": { color: "var(--fg)" },
    ".cm-completionDetail": {
      color: "var(--fg-dim)",
      fontStyle: "normal",
      marginLeft: "12px",
    },
    ".cm-completionMatchedText": {
      textDecoration: "none",
      color: "var(--accent)",
      fontWeight: "600",
    },
    ".cm-completionIcon": {
      opacity: "0.85",
      width: "1.2em",
      paddingRight: "0.4em",
    },
    ".cm-scroller": {
      // line-height comes from --ed-line via styles.css
      overflow: "auto",
    },
    ".cm-panels": {
      backgroundColor: "transparent",
      color: "var(--fg)",
      border: "none",
    },
    ".cm-panels.cm-panels-top": {
      position: "absolute",
      top: "0 !important",
      marginTop: "24px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "10",
      border: "none",
      backgroundColor: "transparent",
      pointerEvents: "none",
      width: "auto",
    },
    ".cm-panels.cm-panels-top > *": {
      pointerEvents: "auto",
    },
    ".cm-panel.cm-search": {
      padding: "20px 24px",
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: "12px",
      minWidth: "560px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif",
      fontSize: "12px",
      backgroundColor: "var(--bg-elev)",
      border: "1px solid var(--border)",
      borderRadius: "var(--r-lg)",
      boxShadow: "0 12px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.28)",
    },
    ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": {
      margin: "0",
    },
    ".cm-search label": {
      color: "var(--fg-dim)",
      fontSize: "12px",
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
    },
    ".cm-textfield": {
      backgroundColor: "var(--bg-elev-2)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "var(--r-sm)",
      padding: "7px 12px",
      fontSize: "12px",
      fontFamily: "var(--ed-font)",
      outline: "none",
      minWidth: "260px",
    },
    ".cm-textfield:focus": {
      borderColor: "var(--accent)",
      boxShadow: "0 0 0 1px var(--accent-3)",
    },
    ".cm-button": {
      backgroundColor: "var(--bg-elev-2)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "var(--r-sm)",
      padding: "5px 12px",
      fontSize: "12px",
      fontWeight: "500",
      cursor: "pointer",
      backgroundImage: "none",
    },
    ".cm-button:hover": {
      backgroundColor: "var(--bg-elev-3)",
      borderColor: "var(--border-strong)",
    },
    ".cm-button:active": {
      backgroundColor: "var(--accent-2)",
      color: "var(--accent)",
      borderColor: "var(--accent)",
      backgroundImage: "none",
    },
    ".cm-panel.cm-search [name=close]": {
      color: "var(--fg-dim)",
      fontSize: "16px",
      cursor: "pointer",
      background: "transparent",
      border: "none",
      padding: "0 4px",
    },
    ".cm-panel.cm-search [name=close]:hover": {
      color: "var(--fg)",
    },
  },
  { dark: true }
);

function buildExtensions(onChange, opts) {
  const showLineNumbers = opts.lineNumbers !== false;
  const tabSize = opts.tabSize || 2;
  return [
    lineNumbersCompartment.of(showLineNumbers ? lineNumbers() : []),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    drawSelection(),
    rectangularSelection(),
    history(),
    bracketMatching(),
    closeBrackets(),
    indentOnInput(),
    tabSizeCompartment.of([
      EditorState.tabSize.of(tabSize),
      indentUnit.of(" ".repeat(tabSize)),
    ]),
    typstLanguage,
    typstWysiwygPlugin,
    syntaxHighlighting(typstHighlightStyle),
    autocompletion({
      override: [typstCompletions],
      activateOnTyping: true,
      defaultKeymap: true,
      closeOnBlur: true,
      icons: true,
    }),
    search({ top: true }),
    keymap.of([
      ...closeBracketsKeymap,
      ...searchKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    themedEditor,
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update);
    }),
  ];
}

export function createEditorState(initialDoc, onChange, opts = {}) {
  return EditorState.create({
    doc: initialDoc,
    extensions: buildExtensions(onChange, opts),
  });
}

export function createEditor(parent, initialDoc, onChange, opts = {}) {
  const state = createEditorState(initialDoc, onChange, opts);
  return new EditorView({ state, parent });
}

export function setLineNumbers(view, on) {
  view.dispatch({
    effects: lineNumbersCompartment.reconfigure(on ? lineNumbers() : []),
  });
}

export function setTabSize(view, n) {
  view.dispatch({
    effects: tabSizeCompartment.reconfigure([
      EditorState.tabSize.of(n),
      indentUnit.of(" ".repeat(n)),
    ]),
  });
}

export function wrapSelection(view, prefix, suffix) {
  view.dispatch(
    view.state.changeByRange((range) => ({
      changes: [
        { from: range.from, insert: prefix },
        { from: range.to, insert: suffix },
      ],
      range: EditorSelection.range(
        range.from + prefix.length,
        range.to + prefix.length
      ),
    }))
  );
  view.focus();
}

export function prefixLines(view, prefix) {
  const { state } = view;
  const changes = [];
  const seen = new Set();
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from).number;
    const endLine = state.doc.lineAt(range.to).number;
    for (let i = startLine; i <= endLine; i++) {
      if (seen.has(i)) continue;
      seen.add(i);
      const line = state.doc.line(i);
      changes.push({ from: line.from, insert: prefix });
    }
  }
  if (changes.length) view.dispatch({ changes });
  view.focus();
}

export function insertSnippet(view, snippet) {
  // `$|` marks the desired final cursor position. Optional.
  const cursorIdx = snippet.indexOf("$|");
  const text = cursorIdx === -1 ? snippet : snippet.replace("$|", "");
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(
      from + (cursorIdx === -1 ? text.length : cursorIdx)
    ),
  });
  view.focus();
}

export function getDocText(view) {
  return view.state.doc.toString();
}

export function openFind(view) {
  openSearchPanel(view);
}

export function gotoOffset(view, offset) {
  const clamped = Math.max(0, Math.min(view.state.doc.length, offset));
  view.dispatch({
    selection: EditorSelection.cursor(clamped),
    effects: EditorView.scrollIntoView(clamped, { y: "center" }),
  });
  view.focus();
}
