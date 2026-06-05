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
      "tools/**",
      "fonts/**",
      "docs/**",
      "build/**",
      "coverage/**"
    ]
  },
  {
    files: ["**/*.{js,cjs,mjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {}
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts", "vite*.ts", "vitest.config.ts"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
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
          varsIgnorePattern: "^_"
        }
      ],
      "react-refresh/only-export-components": [
        "warn",
        {
          allowConstantExport: true
        }
      ],
      "react-hooks/immutability": "off",
      "react-hooks/set-state-in-effect": "off"
    }
  },
  {
    files: ["tests/**/*.{ts,tsx}"],
    rules: {
      "no-this-alias": "off"
    }
  },
  {
    files: ["src/main/runtime/**/*.cjs", "scripts/**/*.cjs", "electron-builder.config.cjs"],
    languageOptions: {
      sourceType: "commonjs"
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off"
    }
  },
  {
    files: ["**/*.{js,cjs,mjs,ts,tsx}"],
    rules: {
      "no-control-regex": "off",
      "no-redeclare": "off",
      "no-this-alias": "off",
      "@typescript-eslint/no-this-alias": "off",
      "no-useless-assignment": "warn",
      "preserve-caught-error": "off"
    }
  }
);
