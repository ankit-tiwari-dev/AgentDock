import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["node_modules/**", "**/*.vsix", "**/.next/**", "**/out/**", "frontend/next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.js"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    // The dashboard runs in the browser.
    files: ["frontend/src/**/*.tsx", "frontend/src/**/*.ts"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // The CLI's tables are written once, in fixtures/cli-schema.sql; a hand-written copy drifts from what the CLI
    // creates (six copies diverged before this rule). An older CLI's layout is the fixture with parts dropped.
    files: ["backend/tests/**/*.ts", "frontend/tests/**/*.ts", "scripts/**/*.ts"],
    ignores: ["backend/tests/live-view-fixture.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/CREATE TABLE (IF NOT EXISTS )?(sessions|events|session_usage)\\b/]",
          message:
            "Use applyCliSchema(), cliTable() or createAuditDb() from backend/tests/live-view-fixture.ts; they read fixtures/cli-schema.sql.",
        },
        {
          selector: "TemplateElement[value.raw=/CREATE TABLE (IF NOT EXISTS )?(sessions|events|session_usage)\\b/]",
          message:
            "Use applyCliSchema(), cliTable() or createAuditDb() from backend/tests/live-view-fixture.ts; they read fixtures/cli-schema.sql.",
        },
      ],
    },
  },
  prettier,
);
