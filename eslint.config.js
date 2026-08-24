// @ts-check
import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default defineConfig(
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.config.js", "*.config.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.eval.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  globalIgnores(["dist/**", "node_modules/**", "coverage/**"]),
  prettier,
);
