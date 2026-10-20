import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "playwright-report/**", "test-results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/rules-of-hooks": "error",
    },
  },
  {
    files: [
      "apps/api/**/*.ts",
      "shared/**/*.ts",
      "tests/**/*.ts",
      "playwright.config.ts",
      "vite.config.ts",
      "eslint.config.js",
    ],
    languageOptions: { globals: globals.node },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
