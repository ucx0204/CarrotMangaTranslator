import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "out/**",
      "dist/**",
      ".tmp/**",
      "tmp/**",
      "library/**",
      "logs/**",
      "models/**",
      "ocr-runtime/**",
      "tools/**",
      "fonts/**",
      "docs/**",
      "build/**",
      "coverage/**",
    ],
  },
  {
    files: ["**/*.{js,cjs,mjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {},
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      "src/**/*.{ts,tsx}",
      "tests/**/*.ts",
      "vite*.ts",
      "vitest.config.ts",
    ],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "react-refresh/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
        },
      ],
      "react-hooks/immutability": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: ["tests/**/*.{ts,tsx}"],
    rules: {
      "no-this-alias": "off",
    },
  },
  {
    files: [
      "src/renderer/src/app/session/**/*.{ts,tsx}",
      "src/shared/ipcContracts.ts",
      "src/preload/ipcContracts.ts",
      "tests/appSessionSelectors.test.ts",
      "tests/ipcContracts.test.ts",
      "tests/mangaGateway.test.ts",
      "tests/translationRefreshFailure.test.ts",
    ],
    rules: {
      complexity: ["error", 12],
      "max-depth": ["error", 3],
      "max-lines-per-function": [
        "error",
        { max: 80, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: ["src/renderer/src/app/session/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "../../../shared/types",
              message:
                "Use domain shared imports such as libraryTypes, jobTypes, textTypes, or inpaintingTypes.",
            },
            {
              name: "../../../../shared/types",
              message:
                "Use domain shared imports such as libraryTypes, jobTypes, textTypes, or inpaintingTypes.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/main/{ipc,jobs}/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../libraryStore",
                "../libraryStore/*",
                "../../libraryStore",
                "../../libraryStore/*",
                "**/libraryStore",
                "**/libraryStore/*",
              ],
              message:
                "IPC and job modules must use src/main/library.ts instead of importing libraryStore directly.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../shared/types",
                "../shared/types/*",
                "../../shared/types",
                "../../shared/types/*",
                "../../../shared/types",
                "../../../shared/types/*",
                "../../../../shared/types",
                "../../../../shared/types/*",
                "**/shared/types",
                "**/shared/types/*",
                "../preload",
                "../preload/*",
                "../../preload",
                "../../preload/*",
                "../../../preload",
                "../../../preload/*",
                "../main",
                "../main/*",
                "../../main",
                "../../main/*",
                "../../../main",
                "../../../main/*",
                "**/preload",
                "**/preload/*",
                "**/main",
                "**/main/*",
              ],
              message:
                "Renderer modules must use shared contracts and the preload bridge, not preload/main imports.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/shared/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../main",
                "../main/*",
                "../../main",
                "../../main/*",
                "../renderer",
                "../renderer/*",
                "../../renderer",
                "../../renderer/*",
                "../preload",
                "../preload/*",
                "../../preload",
                "../../preload/*",
                "**/main",
                "**/main/*",
                "**/renderer",
                "**/renderer/*",
                "**/preload",
                "**/preload/*",
              ],
              message:
                "Shared modules must not import main, renderer, or preload layers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/main/runtime/**/*.cjs",
      "scripts/**/*.cjs",
      "electron-builder.config.cjs",
    ],
    languageOptions: {
      sourceType: "commonjs",
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.{js,cjs,mjs,ts,tsx}"],
    rules: {
      "no-control-regex": "off",
      "no-empty": ["warn", { allowEmptyCatch: false }],
      "no-new-func": "error",
      "no-redeclare": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportAllDeclaration",
          message: "Use explicit exports instead of export *.",
        },
        {
          selector: "CatchClause[param=null]",
          message:
            "Use catch (error) and handle, rethrow, or explicitly ignore expected optional failures.",
        },
      ],
      "no-this-alias": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
    },
  },
  {
    files: [
      "src/main/**/*.{ts,tsx}",
      "src/preload/**/*.{ts,tsx}",
      "src/renderer/**/*.{ts,tsx}",
      "src/shared/**/*.{ts,tsx}",
    ],
    rules: {
      complexity: ["warn", 12],
      "max-depth": ["warn", 3],
      "max-lines": [
        "warn",
        { max: 400, skipBlankLines: true, skipComments: true },
      ],
      "max-lines-per-function": [
        "warn",
        { max: 80, skipBlankLines: true, skipComments: true },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
);
