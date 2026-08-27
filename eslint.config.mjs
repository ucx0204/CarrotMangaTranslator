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
      "release/**",
      "runtime/**",
      "data/**",
      "artifacts/**",
      "datasets/**",
      ".tmp-*/**",
      ".pytest_cache/**",
      ".ruff_cache/**",
      ".settings-pairs/**",
      ".mgt-instance-*/**",
      ".claude/**",
      ".agents/**",
      "codex/**",
      "**/__pycache__/**",
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
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "react-refresh/only-export-components": [
        "error",
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
      complexity: ["error", 20],
      "max-depth": ["error", 4],
      "max-lines": [
        "error",
        { max: 1200, skipBlankLines: true, skipComments: true },
      ],
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
    files: ["src/main/runtime/**/*.cjs"],
    rules: {
      complexity: ["error", 12],
      "max-depth": ["error", 3],
      "max-lines": [
        "error",
        { max: 400, skipBlankLines: true, skipComments: true },
      ],
      "max-lines-per-function": [
        "error",
        { max: 80, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    // All build/release/QA scripts have a structural ceiling. High-risk,
    // actively maintained CLIs below use the same tighter budget as runtime
    // code after being split into domain modules.
    files: ["scripts/**/*.{cjs,mjs}"],
    rules: {
      complexity: ["error", 20],
      "max-depth": ["error", 4],
      "max-lines": [
        "error",
        { max: 600, skipBlankLines: true, skipComments: true },
      ],
      "max-lines-per-function": [
        "error",
        { max: 160, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: [
      "scripts/build-flux-rocm-runtime.cjs",
      "scripts/benchmark-gemma-economy.cjs",
      "scripts/smoke-overlay.cjs",
      "scripts/verify-mac-package.cjs",
      "scripts/ui-qa.mjs",
      "scripts/flux-rocm-build/**/*.cjs",
      "scripts/gemma-benchmark/**/*.cjs",
      "scripts/smoke-overlay/**/*.cjs",
      "scripts/mac-package-verification/**/*.cjs",
      "scripts/ui-qa/**/*.mjs",
    ],
    rules: {
      complexity: ["error", 16],
      "max-depth": ["error", 3],
      "max-lines": [
        "error",
        { max: 400, skipBlankLines: true, skipComments: true },
      ],
      "max-lines-per-function": [
        "error",
        { max: 120, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: ["**/*.{js,cjs,mjs,ts,tsx}"],
    rules: {
      "no-control-regex": "off",
      "no-empty": ["error", { allowEmptyCatch: false }],
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
        {
          selector: "TSAsExpression[expression.type='TSAsExpression']",
          message:
            "Nested type assertions hide contract mismatches. Validate the boundary or use one checked assertion.",
        },
        {
          selector:
            "ImportDeclaration[source.value=/shared\\/types$/], ExportNamedDeclaration[source.value=/shared\\/types$/]",
          message:
            "Import the owning domain contract directly instead of recreating the shared/types umbrella.",
        },
      ],
      "no-this-alias": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-non-null-assertion": "error",
      "no-useless-assignment": "error",
      "preserve-caught-error": "error",
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
      complexity: ["error", 12],
      "max-depth": ["error", 3],
      "max-lines": [
        "error",
        { max: 400, skipBlankLines: true, skipComments: true },
      ],
      "max-lines-per-function": [
        "error",
        { max: 80, skipBlankLines: true, skipComments: true },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  {
    // Isolated CommonJS-to-native-ESM bridge for the allowlisted OAuth package.
    files: ["src/main/nativeDynamicImport.ts"],
    rules: {
      "no-new-func": "off",
    },
  },
);
