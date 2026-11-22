// The three parts of this repo and the rules between them (README, docs/DECISIONS.md → D-10). npm run check:arch.
const PARTS = ["backend", "frontend", "extension"];

const separateParts = PARTS.map((part) => ({
  name: `${part}-stays-separate`,
  comment: `${part} never imports another part's code; shared shapes are copied with their source named.`,
  severity: "error",
  from: { path: `^${part}/src/` },
  to: { path: `^(${PARTS.filter((p) => p !== part).join("|")})/` },
}));

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    ...separateParts,
    {
      name: "backend-no-new-dependency",
      comment: "The backend's only npm dependency is @anthropic-ai/sdk (D-10); everything else is node: built-ins.",
      severity: "error",
      from: { path: "^backend/src/" },
      to: {
        dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg", "npm-unknown"],
        pathNot: "@anthropic-ai/sdk",
      },
    },
    {
      name: "no-cycle",
      comment: "A cycle between modules means neither can be read or tested alone.",
      severity: "error",
      from: { path: "^(backend|frontend|extension)/src/" },
      to: { circular: true },
    },
    {
      name: "src-not-to-tests",
      comment: "Shipped code never imports test code.",
      severity: "error",
      from: { path: "^(backend|frontend|extension)/src/" },
      to: { path: "^(backend|frontend|extension)/tests/" },
    },
  ],
  options: {
    includeOnly: "^(backend|frontend|extension)/src/|^node_modules/",
    exclude: { path: "^node_modules/.+/node_modules/" },
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    moduleSystems: ["es6", "cjs"],
  },
};
