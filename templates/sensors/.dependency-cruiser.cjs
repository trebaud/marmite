// Marmite drift sensor — dependency-cruiser config.
//
// Scoped at invocation time to files changed by the current marmite run. The
// orchestrator passes the changed-file list as positional args, so the cruiser
// only walks the import graphs rooted at modified entry points — not the whole
// brownfield repo.
//
// Invoke (do not run on the whole tree):
//   CHANGED=$(git diff --name-only "$baseBranch"...HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs')
//   [ -n "$CHANGED" ] && npx depcruise --config .marmite/sensors/.dependency-cruiser.cjs $CHANGED
//
// Edit the `forbidden` rules below to encode the architecture you want enforced
// on new code. The defaults catch the universals (cycles, orphans, dev-only
// imports leaking into prod). Layered-architecture rules belong here too — add
// `from`/`to` path patterns that mirror the project's module boundaries.

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Circular dependencies make module boundaries meaningless and break dead-code analysis. Untangle by extracting the shared concept into a third module.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment: "Orphan modules suggest dead code or a missing wiring step.",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$",
          "\\.d\\.ts$",
          "(^|/)tsconfig\\.json$",
          "(^|/)(babel|webpack|vite|rollup|jest|vitest)\\.config\\.(js|cjs|mjs|ts)$",
        ],
      },
      to: {},
    },
    {
      name: "no-deprecated-core",
      severity: "warn",
      from: {},
      to: { dependencyTypes: ["core"], path: ["^(punycode|domain|constants|sys|querystring|_linklist)$"] },
    },
    {
      name: "not-to-dev-dep",
      severity: "error",
      comment:
        "Importing a devDependency from runtime code breaks production installs that omit devDeps.",
      from: { path: "^(src|lib|app)", pathNot: "\\.(spec|test)\\.(js|mjs|cjs|ts|tsx)$" },
      to: { dependencyTypes: ["npm-dev"] },
    },
    {
      name: "no-non-package-json",
      severity: "error",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    // Add layering rules here, e.g.:
    // { name: "domain-pure", severity: "error",
    //   from: { path: "^src/domain" }, to:   { path: "^src/(infra|http|db)" } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
