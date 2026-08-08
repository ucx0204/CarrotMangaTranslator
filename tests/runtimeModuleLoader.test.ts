import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  assertRuntimeFunctions,
  loadAppRuntimeModule,
  resolveAppRuntimeModulePath,
  selectAppRuntimeDirectory,
} from "../src/main/runtimeModuleLoader";

describe("runtime module boundary", () => {
  it("resolves only manifest-owned module identifiers", () => {
    expect(resolveAppRuntimeModulePath("C:\\runtime", "requestBuilders")).toBe(
      join("C:\\runtime", "simple-page-request-builders.cjs"),
    );
    expect(resolveAppRuntimeModulePath("/runtime", "apiKeyRetry")).toBe(
      join("/runtime", "transport/api-key-retry.cjs"),
    );
    expect(resolveAppRuntimeModulePath("/runtime", "zipExtractor")).toBe(
      join("/runtime", "simple-page-zip-utils.cjs"),
    );
  });

  it.each([
    null,
    [],
    {},
    { request: "not-a-function" },
    { request: () => undefined },
  ])("rejects an invalid runtime contract: %j", (runtime) => {
    expect(() =>
      assertRuntimeFunctions(runtime, "test-runtime.cjs", ["request", "parse"]),
    ).toThrow(/test-runtime\.cjs/);
  });

  it("accepts a runtime only when every required operation is callable", () => {
    const runtime = {
      request: () => "ok",
      parse: () => ({ ok: true }),
    };

    assertRuntimeFunctions(runtime, "test-runtime.cjs", ["request", "parse"]);

    expect(runtime.request()).toBe("ok");
  });

  it("uses source runtime modules only in a non-Electron Vitest process", () => {
    const resolveInstalledRuntimeDir = vi.fn(() => "C:\\installed-runtime");
    const baseOptions = {
      testRuntimeDir: "C:\\source-runtime",
      resolveInstalledRuntimeDir,
    };

    expect(
      selectAppRuntimeDirectory({
        ...baseOptions,
        isVitest: true,
        resourcesPath: undefined,
      }),
    ).toBe("C:\\source-runtime");
    expect(resolveInstalledRuntimeDir).not.toHaveBeenCalled();

    expect(
      selectAppRuntimeDirectory({
        ...baseOptions,
        isVitest: false,
        resourcesPath: undefined,
      }),
    ).toBe("C:\\installed-runtime");
    expect(
      selectAppRuntimeDirectory({
        ...baseOptions,
        isVitest: true,
        resourcesPath: "C:\\electron-resources",
      }),
    ).toBe("C:\\installed-runtime");
    expect(resolveInstalledRuntimeDir).toHaveBeenCalledTimes(2);
  });

  it("loads a manifest-owned source runtime through the application boundary", () => {
    const runtime = loadAppRuntimeModule("apiKeyRetry");

    assertRuntimeFunctions(runtime, "api-key-retry.cjs", [
      "runWithApiKeyRetry",
    ]);
  });

  it("keeps computed require calls inside the validated runtime boundary", () => {
    const mainRoot = join(__dirname, "..", "src", "main");
    const dynamicRequireFiles = listTypeScriptFiles(mainRoot).filter((file) =>
      containsComputedRequire(file),
    );

    expect(
      dynamicRequireFiles.map((file) => file.replaceAll("\\", "/")),
    ).toEqual([expect.stringMatching(/src\/main\/runtimeModuleLoader\.ts$/)]);
  });
});

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listTypeScriptFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

function containsComputedRequire(file: string): boolean {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      !ts.isStringLiteral(node.arguments[0])
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
