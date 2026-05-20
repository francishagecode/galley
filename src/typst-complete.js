import { snippetCompletion } from "@codemirror/autocomplete";

// Functions/elements invoked with `#name(...)` or `#name[...]` in markup,
// and as bare `name(...)` in code blocks.
const FUNCTIONS = [
  // Structure
  ["heading", "heading(level: ${1:1})[${2:Title}]", "Section heading"],
  ["text", 'text(size: ${1:12pt})[${2:body}]', "Set text properties"],
  ["par", "par(leading: ${1:0.65em})[${2:body}]", "Paragraph"],
  ["set", "set ${1:text}(${2:})", "Set style rule"],
  ["show", "show ${1:heading}: ${2:it} => ${3:it}", "Show rule"],
  ["let", "let ${1:name} = ${2:value}", "Define binding"],
  ["import", 'import "${1:file.typ}": ${2:*}', "Import module"],
  ["include", 'include "${1:file.typ}"', "Include file"],

  // Blocks
  ["page", "page(paper: \"${1:a4}\")[${2:body}]", "Page settings"],
  ["box", "box[${1:body}]", "Inline container"],
  ["block", "block[${1:body}]", "Block container"],
  ["pad", "pad(x: ${1:1em}, y: ${2:1em})[${3:body}]", "Padding"],
  ["align", "align(${1:center})[${2:body}]", "Alignment"],
  ["columns", "columns(${1:2})[${2:body}]", "Multi-column"],
  ["stack", "stack(dir: ${1:ltr})[${2:body}]", "Stack content"],
  ["grid", "grid(\n  columns: (${1:1fr, 1fr}),\n  ${2:content}\n)", "Grid layout"],
  ["place", "place(${1:top + left})[${2:body}]", "Absolute placement"],
  ["hide", "hide[${1:body}]", "Hide content"],
  ["repeat", "repeat[${1:body}]", "Repeat content"],

  // Inline formatting
  ["strong", "strong[${1:body}]", "Bold"],
  ["emph", "emph[${1:body}]", "Italic"],
  ["underline", "underline[${1:body}]", "Underline"],
  ["strike", "strike[${1:body}]", "Strikethrough"],
  ["smallcaps", "smallcaps[${1:body}]", "Small caps"],
  ["sub", "sub[${1:body}]", "Subscript"],
  ["super", "super[${1:body}]", "Superscript"],
  ["highlight", "highlight[${1:body}]", "Highlight"],
  ["raw", "raw(\"${1:code}\", lang: \"${2:rust}\")", "Raw text"],
  ["quote", "quote(block: ${1:true})[${2:body}]", "Quotation"],

  // Lists
  ["list", "list[${1:item}]", "Bullet list"],
  ["enum", "enum[${1:item}]", "Numbered list"],
  ["terms", "terms((${1:term}: [${2:def}]))", "Term list"],

  // Refs & navigation
  ["label", "label(\"${1:name}\")", "Label"],
  ["ref", "ref(<${1:name}>)", "Reference"],
  ["link", 'link("${1:https://}")[${2:text}]', "Hyperlink"],
  ["footnote", "footnote[${1:body}]", "Footnote"],
  ["cite", "cite(<${1:key}>)", "Citation"],
  ["bibliography", 'bibliography("${1:refs.bib}")', "Bibliography"],
  ["outline", "outline()", "Table of contents"],

  // Layout breaks
  ["pagebreak", "pagebreak()", "Page break"],
  ["colbreak", "colbreak()", "Column break"],
  ["linebreak", "linebreak()", "Line break"],
  ["parbreak", "parbreak()", "Paragraph break"],

  // Embeds
  ["image", 'image("${1:path}")', "Image"],
  ["figure", "figure(\n  ${1:content},\n  caption: [${2:caption}],\n)", "Figure"],
  ["table", "table(\n  columns: ${1:2},\n  [${2:H1}], [${3:H2}],\n  [${4:a}], [${5:b}],\n)", "Table"],
  ["line", "line(length: ${1:100%})", "Line"],
  ["rect", "rect(width: ${1:2cm}, height: ${2:1cm})", "Rectangle"],
  ["circle", "circle(radius: ${1:1cm})", "Circle"],
  ["ellipse", "ellipse(width: ${1:2cm}, height: ${2:1cm})", "Ellipse"],
  ["polygon", "polygon(${1:(0pt, 0pt), (1cm, 0pt), (0pt, 1cm)})", "Polygon"],
  ["path", "path(${1:(0pt, 0pt), (1cm, 1cm)})", "Path"],

  // Math (in code position)
  ["math.equation", "math.equation(${1:body})", "Math equation"],

  // State / metadata
  ["counter", 'counter("${1:name}")', "Counter"],
  ["state", 'state("${1:name}", ${2:initial})', "State"],
  ["locate", "locate(${1:loc} => ${2:body})", "Locate"],
  ["query", "query(${1:selector})", "Query"],
  ["measure", "measure(${1:content})", "Measure"],

  // Utility
  ["lorem", "lorem(${1:50})", "Lorem ipsum"],
  ["repr", "repr(${1:value})", "Debug repr"],
  ["eval", 'eval("${1:expr}")', "Evaluate"],
  ["read", 'read("${1:file}")', "Read file"],
];

// Math-mode shortcuts: typed as bare identifiers between `$...$`. Typst
// already resolves most of these on its own, but offering them in the
// completion popup makes them discoverable.
const MATH_SYMBOLS = [
  // Greek lower
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
  "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi", "rho",
  "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega",
  // Greek upper
  "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta",
  "Iota", "Kappa", "Lambda", "Mu", "Nu", "Xi", "Omicron", "Pi", "Rho",
  "Sigma", "Tau", "Upsilon", "Phi", "Chi", "Psi", "Omega",
  // Operators & relations
  "plus.minus", "minus.plus", "times", "div", "dot", "ast", "star",
  "circ", "bullet", "oplus", "ominus", "otimes", "odot",
  "leq", "geq", "neq", "approx", "equiv", "prop", "sim", "simeq",
  "subset", "supset", "subseteq", "supseteq", "in", "notin", "ni",
  "union", "sect", "without", "compl",
  // Big operators
  "sum", "product", "integral", "integral.double", "integral.triple",
  "integral.cont", "limits", "lim", "max", "min", "sup", "inf",
  // Calculus
  "diff", "dif", "partial", "nabla", "grad", "curl",
  // Arrows
  "arrow", "arrow.r", "arrow.l", "arrow.t", "arrow.b",
  "arrow.r.long", "arrow.l.long", "arrow.r.double", "arrow.l.double",
  "mapsto", "to",
  // Constants & sets
  "infinity", "infty", "emptyset", "RR", "NN", "ZZ", "QQ", "CC",
  // Brackets / delimiters
  "lr", "abs", "norm", "floor", "ceil", "round",
  // Functions
  "sqrt", "root", "frac", "binom", "vec", "mat", "cases",
  "sin", "cos", "tan", "cot", "sec", "csc",
  "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
  "log", "ln", "exp", "det", "gcd", "lcm", "mod",
  // Style
  "bold", "italic", "upright", "cal", "frak", "mono", "bb",
  "hat", "tilde", "bar", "dot", "ddot", "arrow", "vec",
  "underbrace", "overbrace", "underline", "overline",
];

const MATH_SNIPPETS = [
  ["frac", "frac(${1:num}, ${2:den})", "Fraction"],
  ["sqrt", "sqrt(${1:x})", "Square root"],
  ["root", "root(${1:n}, ${2:x})", "n-th root"],
  ["sum", "sum_(${1:i=0})^(${2:n}) ${3:x_i}", "Summation"],
  ["product", "product_(${1:i=0})^(${2:n}) ${3:x_i}", "Product"],
  ["integral", "integral_(${1:a})^(${2:b}) ${3:f(x)} dif ${4:x}", "Integral"],
  ["lim", "lim_(${1:x -> 0}) ${2:f(x)}", "Limit"],
  ["binom", "binom(${1:n}, ${2:k})", "Binomial"],
  ["mat", "mat(\n  ${1:a}, ${2:b};\n  ${3:c}, ${4:d}\n)", "Matrix"],
  ["vec", "vec(${1:a}, ${2:b}, ${3:c})", "Column vector"],
  ["cases", "cases(\n  ${1:expr1} & ${2:cond1},\n  ${3:expr2} & ${4:cond2}\n)", "Cases"],
];

// Compile completion option arrays once.
const FUNCTION_OPTIONS = FUNCTIONS.map(([label, template, detail]) =>
  snippetCompletion(template, {
    label: "#" + label,
    detail,
    type: "function",
  })
);

// Same options but without the leading `#`, for use inside `#{...}` code mode.
const FUNCTION_OPTIONS_BARE = FUNCTIONS.map(([label, template, detail]) =>
  snippetCompletion(template, { label, detail, type: "function" })
);

const MATH_SYMBOL_OPTIONS = MATH_SYMBOLS.map((s) => ({
  label: s,
  type: "constant",
}));

const MATH_SNIPPET_OPTIONS = MATH_SNIPPETS.map(([label, template, detail]) =>
  snippetCompletion(template, { label, detail, type: "function" })
);

const MATH_OPTIONS = [...MATH_SNIPPET_OPTIONS, ...MATH_SYMBOL_OPTIONS];

// Determine whether the cursor sits inside `$...$` math by counting
// unescaped dollar signs from the start of the document to the cursor.
function inMath(state, pos) {
  const text = state.doc.sliceString(0, pos);
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 92 /* \ */) {
      i++; // skip next char
      continue;
    }
    if (ch === 36 /* $ */) count++;
  }
  return count % 2 === 1;
}

export function typstCompletions(context) {
  const { state, pos } = context;
  const math = inMath(state, pos);

  if (math) {
    const word = context.matchBefore(/[A-Za-z][A-Za-z0-9.]*/);
    if (!word) return null;
    if (word.from === word.to && !context.explicit) return null;
    return {
      from: word.from,
      options: MATH_OPTIONS,
      validFor: /^[A-Za-z][A-Za-z0-9.]*$/,
    };
  }

  // Markup mode: completions triggered by `#`.
  const hashWord = context.matchBefore(/#[A-Za-z][A-Za-z0-9.]*/);
  if (hashWord) {
    return {
      from: hashWord.from,
      options: FUNCTION_OPTIONS,
      validFor: /^#[A-Za-z][A-Za-z0-9.]*$/,
    };
  }

  // Bare `#` — explicitly triggered, show full list.
  const hash = context.matchBefore(/#/);
  if (hash && context.explicit) {
    return {
      from: hash.from,
      options: FUNCTION_OPTIONS,
      validFor: /^#[A-Za-z][A-Za-z0-9.]*$/,
    };
  }

  // Explicit invocation with no prefix: still offer the function list
  // (so Ctrl-Space anywhere in markup is useful).
  if (context.explicit) {
    const word = context.matchBefore(/[A-Za-z][A-Za-z0-9.]*/);
    if (word) {
      return {
        from: word.from,
        options: FUNCTION_OPTIONS_BARE,
        validFor: /^[A-Za-z][A-Za-z0-9.]*$/,
      };
    }
  }

  return null;
}
