import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo", "**/*.js", "**/*.mjs"],
  },
  {
    files: ["packages/*/src/**/*.ts", "examples/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      prettier: prettierPlugin,
    },
    rules: {
      // TypeScript recommended rules
      ...tseslint.configs.recommended.rules,

      // Prettier as ESLint rule
      "prettier/prettier": "error",

      // Style rules matching CONTRIBUTING.md
      quotes: ["error", "double", { avoidEscape: true }],
      semi: ["error", "always"],

      // TypeScript-specific
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  {
    files: ["packages/*/src/**/*.test.ts", "examples/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  prettierConfig,
];
