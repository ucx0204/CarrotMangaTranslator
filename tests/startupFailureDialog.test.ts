import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";

// Execute the real private startup dialog without initializing Electron, IPC or native models.
const file = ts.createSourceFile(
  "index.ts",
  readFileSync(resolve("src/main/index.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const declaration = file.statements.find(
  (statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) &&
    statement.name?.text === "showStartupFailureDialog",
);
if (!declaration)
  throw new Error("Startup failure dialog declaration is missing");
const script = ts.transpileModule(declaration.getFullText(file), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;

it.each([
  { response: 0, window: "absent" },
  { response: 1, window: "absent" },
  { response: 0, window: "destroyed" },
  { response: 1, window: "destroyed" },
  { response: 0, window: "live" },
  { response: 1, window: "live" },
  { response: 2, window: "absent" },
  { response: 2, window: "live" },
] as const)(
  "settles startup failure action $response with a $window main window",
  async ({ response, window }) => {
    const context = fixture(response, window);
    await context.show("startup failure");
    expect(context.rendererLoadFailureDialogOpen).toBe(false);
    expect(context.app.quit).toHaveBeenCalledTimes(
      response === 2 || window !== "live" ? 1 : 0,
    );
    expect(context.shell.openExternal).toHaveBeenCalledTimes(
      response === 0 ? 1 : 0,
    );
    expect(context.shell.openPath).toHaveBeenCalledTimes(
      response === 1 ? 1 : 0,
    );
    if (response !== 2 && window !== "live") {
      const opened =
        response === 0 ? context.shell.openExternal : context.shell.openPath;
      expect(opened.mock.invocationCallOrder[0]).toBeLessThan(
        context.app.quit.mock.invocationCallOrder[0],
      );
    }
  },
);

it("exits a headless startup even when opening diagnostics fails", async () => {
  const context = fixture(0, "absent");
  context.shell.openExternal.mockRejectedValueOnce(new Error("browser failed"));
  await context.show("startup failure");
  expect(context.logError).toHaveBeenCalledOnce();
  expect(context.app.quit).toHaveBeenCalledOnce();
  expect(context.rendererLoadFailureDialogOpen).toBe(false);
});

function fixture(response: number, window: "absent" | "destroyed" | "live") {
  const context = {
    rendererLoadFailureDialogOpen: false,
    mainWindow:
      window === "absent"
        ? null
        : { isDestroyed: () => window === "destroyed" },
    app: { quit: vi.fn() },
    dialog: { showMessageBox: vi.fn(async () => ({ response })) },
    shell: {
      openExternal: vi.fn(async () => undefined),
      openPath: vi.fn(async () => ""),
    },
    APP_ISSUES_URL: "https://example.test/issues",
    getLogDirectory: () => "isolated-logs",
    tMain: (key: string) => key,
    logError: vi.fn(),
  };
  const show = runInNewContext(
    `${script}\nshowStartupFailureDialog`,
    context,
  ) as (detail: string) => Promise<void>;
  return Object.assign(context, { show });
}
