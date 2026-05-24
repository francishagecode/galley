import { StreamLanguage, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

// A pragmatic, line-by-line Typst tokenizer. Not a full grammar — just enough
// to colour markers, strings, comments, functions, math, and inline emphasis.
const typstStream = {
  startState() {
    return {
      math: 0,
      strong: false,
      emph: false,
      inBlockComment: false,
      inRawBlock: false,
    };
  },

  copyState(s) {
    return { ...s };
  },

  token(stream, state) {
    // Multi-line raw block ```lang ... ```
    if (state.inRawBlock) {
      if (stream.match("```")) {
        state.inRawBlock = false;
        return "rawDelim";
      }
      stream.skipToEnd();
      return "raw";
    }

    // Multi-line block comment
    if (state.inBlockComment) {
      while (!stream.eol()) {
        if (stream.match("*/")) {
          state.inBlockComment = false;
          return "comment";
        }
        stream.next();
      }
      return "comment";
    }

    // Line-start patterns (markup only)
    if (stream.sol() && state.math === 0) {
      // Heading: 1–6 leading `=` followed by space
      const headingMatch = stream.match(/^={1,6}(?=\s)/);
      if (headingMatch) return "headingMark";

      // Bullet / numbered / term list markers (allow leading indent)
      const bullet = stream.match(/^[ \t]*[-+](?=\s)/);
      if (bullet) return "listMark";
      const term = stream.match(/^[ \t]*\/(?=\s)/);
      if (term) return "listMark";
    }

    // Block-comment open
    if (stream.match("/*")) {
      state.inBlockComment = true;
      return "comment";
    }

    // Line comment
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }

    // Raw block open
    if (stream.match("```")) {
      state.inRawBlock = true;
      return "rawDelim";
    }

    // Math delimiter
    if (stream.peek() === "$") {
      stream.next();
      state.math = state.math ? 0 : 1;
      return "mathDelim";
    }

    // Inside math
    if (state.math > 0) {
      if (stream.match(/^[A-Za-z][A-Za-z0-9._]*/)) return "mathSym";
      if (stream.match(/^\d+(\.\d+)?/)) return "number";
      if (stream.match(/^[+\-*/=<>!&|^~]+/)) return "operator";
      if (stream.match(/^[_^]/)) return "operator";
      stream.next();
      return null;
    }

    // # — function call / variable / set / show / let / if / for / etc.
    if (stream.peek() === "#") {
      stream.next();
      const kwMatch = stream.match(
        /^(set|show|let|import|include|if|else|for|while|return|break|continue|context|none|auto|true|false)\b/,
      );
      if (kwMatch) return "keyword";
      if (stream.match(/^[A-Za-z_][A-Za-z0-9_.]*/)) return "function";
      return "punctuation";
    }

    // Label <name>
    if (stream.peek() === "<") {
      const startPos = stream.pos;
      stream.next();
      if (stream.match(/^[A-Za-z_][A-Za-z0-9_:.-]*>/)) return "label";
      stream.pos = startPos + 1;
    }

    // Reference @name
    if (stream.peek() === "@") {
      stream.next();
      if (stream.match(/^[A-Za-z_][A-Za-z0-9_:.-]*/)) return "ref";
      return null;
    }

    // Strong: *
    if (stream.peek() === "*") {
      stream.next();
      state.strong = !state.strong;
      return "strongMark";
    }

    // Emph: _
    if (stream.peek() === "_") {
      stream.next();
      state.emph = !state.emph;
      return "emphMark";
    }

    // Inline raw `code`
    if (stream.peek() === "`") {
      stream.next();
      while (!stream.eol() && stream.peek() !== "`") {
        stream.next();
      }
      if (stream.peek() === "`") stream.next();
      return "raw";
    }

    // String "..."
    if (stream.peek() === '"') {
      stream.next();
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === "\\" && !stream.eol()) {
          stream.next();
          continue;
        }
        if (ch === '"') break;
      }
      return "string";
    }

    // URLs (auto-link): http(s)://...
    if (stream.match(/^https?:\/\/[^\s\])]+/)) return "link";

    // Eat one char applying current inline state
    stream.next();
    if (state.strong) return "strong";
    if (state.emph) return "emph";
    return null;
  },

  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
  },

  tokenTable: {
    headingMark: t.heading,
    listMark: t.list,
    comment: t.comment,
    mathDelim: t.special(t.string),
    mathSym: t.variableName,
    number: t.number,
    operator: t.operator,
    keyword: t.keyword,
    function: t.function(t.variableName),
    label: t.labelName,
    ref: t.atom,
    strongMark: t.special(t.strong),
    emphMark: t.special(t.emphasis),
    raw: t.monospace,
    rawDelim: t.special(t.string),
    string: t.string,
    strong: t.strong,
    emph: t.emphasis,
    link: t.link,
    punctuation: t.punctuation,
  },
};

export const typstLanguage = StreamLanguage.define(typstStream);

// Token classes — actual colors live in styles.css under each theme so a
// single theme switch retints both the chrome and the editor.
export const typstHighlightStyle = HighlightStyle.define([
  { tag: t.heading, class: "tok-heading" },
  { tag: t.list, class: "tok-list" },
  { tag: t.strong, class: "tok-strong" },
  { tag: t.emphasis, class: "tok-emph" },
  { tag: t.special(t.strong), class: "tok-strong-mark" },
  { tag: t.special(t.emphasis), class: "tok-emph-mark" },
  { tag: t.processingInstruction, class: "tok-comment" },
  { tag: t.monospace, class: "tok-raw" },
  { tag: t.string, class: "tok-string" },
  { tag: t.comment, class: "tok-comment" },
  { tag: t.function(t.variableName), class: "tok-function" },
  { tag: t.keyword, class: "tok-keyword" },
  { tag: t.labelName, class: "tok-label" },
  { tag: t.atom, class: "tok-atom" },
  { tag: t.variableName, class: "tok-variable" },
  { tag: t.number, class: "tok-number" },
  { tag: t.operator, class: "tok-operator" },
  { tag: t.special(t.string), class: "tok-raw-delim" },
  { tag: t.punctuation, class: "tok-punct" },
  { tag: t.link, class: "tok-link" },
]);

// Line decorations: scale heading lines and tag list lines for indented look.
// We DO NOT replace or hide markers — they remain visible (Obsidian-style with
// the line "selected", but applied always).
const HEADING_RE = /^(={1,6})\s/;
const LIST_RE = /^[ \t]*[-+]\s/;
const TERM_RE = /^[ \t]*\/\s/;

const headingLineDecos = [
  Decoration.line({ class: "cm-h1" }),
  Decoration.line({ class: "cm-h2" }),
  Decoration.line({ class: "cm-h3" }),
  Decoration.line({ class: "cm-h4" }),
  Decoration.line({ class: "cm-h5" }),
  Decoration.line({ class: "cm-h6" }),
];
const listLineDeco = Decoration.line({ class: "cm-list-line" });
const termLineDeco = Decoration.line({ class: "cm-list-line cm-term-line" });

function buildLineDecorations(view) {
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      const hm = HEADING_RE.exec(text);
      if (hm) {
        const level = Math.min(hm[1].length, 6);
        builder.add(line.from, line.from, headingLineDecos[level - 1]);
      } else if (LIST_RE.test(text)) {
        builder.add(line.from, line.from, listLineDeco);
      } else if (TERM_RE.test(text)) {
        builder.add(line.from, line.from, termLineDeco);
      }
      if (line.to + 1 <= pos) break;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const typstWysiwygPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildLineDecorations(view);
    }
    update(u) {
      if (u.docChanged || u.viewportChanged) {
        this.decorations = buildLineDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
