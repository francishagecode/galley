import js from "@eslint/js";
import globals from "globals";

const rules = {
  "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-console": "off",
  eqeqeq: ["error", "always", { null: "ignore" }],
  "no-var": "error",
  "prefer-const": ["warn", { ignoreReadBeforeAssign: true }],
};

export default [
  {
    ignores: ["dist/**", "node_modules/**", "target/**", "release/**"],
  },
  js.configs.recommended,
  {
    // The renderer (frontend).
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.es2022 },
    },
    rules,
  },
  {
    // The Electron main process, build scripts and config files.
    files: ["electron/**/*.js", "scripts/**/*.js", "*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules,
  },
  {
    files: ["electron/**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules,
  },
];
