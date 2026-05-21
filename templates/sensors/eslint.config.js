// Marmite debt sensor — eslint flat config (eslint v9+).
//
// Scoped at invocation time to files changed by the current marmite run. The
// orchestrator computes that file list with `git diff --name-only $baseBranch...HEAD`
// and passes it as positional args, so this config never lints the whole brownfield
// repo — only what the harness has actually touched.
//
// Invoke (do not run on the whole tree):
//   CHANGED=$(git diff --name-only "$baseBranch"...HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs')
//   [ -n "$CHANGED" ] && npx eslint --no-config-lookup -c .marmite/sensors/eslint.config.js $CHANGED
//
// `--no-config-lookup` prevents eslint from also picking up the project's own
// eslint config and double-reporting. To inherit the user's house style on top
// of marmite's debt rules, import their config below and spread it into the
// returned array. The init wizard detects an existing config and uncomments the
// import + spread when applicable; review the result if you re-run init.

// import userConfig from "../../eslint.config.js"; // ← uncomment to extend user's flat config
import tseslint from "typescript-eslint";

export default [
  // ...userConfig, // ← spread alongside the import above to layer on top
  ...tseslint.configs.recommended,
  {
    rules: {
      // Debt signals — surface accumulated quality issues without being noisy.
      "complexity": ["warn", { max: 12 }],
      "max-lines-per-function": ["warn", { max: 80, skipBlankLines: true, skipComments: true }],
      "max-depth": ["warn", 4],
      "max-params": ["warn", 5],
      "no-console": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },
];
