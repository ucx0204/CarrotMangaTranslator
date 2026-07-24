/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "renderer-not-to-preload-or-main",
      severity: "error",
      from: { path: "^src/renderer/" },
      to: { path: "^src/(preload|main)/" },
    },
    {
      name: "shared-is-domain-neutral",
      severity: "error",
      from: { path: "^src/shared/" },
      to: { path: "^src/(main|renderer|preload)/" },
    },
    {
      name: "page-export-renderer-does-not-enter-app-features",
      severity: "error",
      from: { path: "^src/renderer/src/pageExport/" },
      to: { path: "^src/renderer/src/(api|app|hooks|panels)/" },
    },
    {
      name: "ipc-and-jobs-use-locked-library-facade",
      severity: "error",
      from: { path: "^src/main/(ipc|jobs)/" },
      to: { path: "^src/main/libraryStore/" },
    },
    {
      name: "main-ipc-uses-facades-not-runtime-or-pipeline",
      severity: "error",
      from: { path: "^src/main/ipc/" },
      to: { path: "^src/main/(runtime|pipeline)/" },
    },
    {
      name: "main-pipeline-uses-library-facade",
      severity: "error",
      from: { path: "^src/main/(pipeline/|wholePagePipeline\\.ts$)" },
      to: { path: "^src/main/libraryStore/" },
    },
    {
      name: "main-pipeline-does-not-own-gpu-resources",
      severity: "error",
      from: { path: "^src/main/pipeline/" },
      to: { path: "^src/main/inpainting/" },
    },
    {
      name: "main-jobs-do-not-import-ipc",
      severity: "error",
      from: { path: "^src/main/jobs/" },
      to: { path: "^src/main/ipc/" },
    },
    {
      name: "library-store-stays-below-ipc-and-jobs",
      severity: "error",
      from: { path: "^src/main/libraryStore/" },
      to: { path: "^src/main/(ipc|jobs)/" },
    },
    {
      name: "renderer-lib-does-not-import-app-components-or-hooks",
      severity: "error",
      from: { path: "^src/renderer/src/lib/" },
      to: { path: "^src/renderer/src/(app|components|hooks)/" },
    },
    {
      name: "renderer-hooks-do-not-import-components",
      severity: "error",
      from: { path: "^src/renderer/src/hooks/" },
      to: { path: "^src/renderer/src/components/" },
    },
    {
      name: "renderer-api-does-not-import-app-components-or-hooks",
      severity: "error",
      from: { path: "^src/renderer/src/api/" },
      to: { path: "^src/renderer/src/(app|components|hooks|lib)/" },
    },
    {
      name: "renderer-features-use-domain-gateways",
      severity: "error",
      from: { path: "^src/renderer/src/(?!api/)" },
      to: { path: "^src/renderer/src/api/mangaGateway\\.ts$" },
    },
    {
      name: "renderer-ui-components-stay-leaf-level",
      severity: "error",
      from: { path: "^src/renderer/src/components/ui/" },
      to: {
        path: "^src/renderer/src/(app|hooks|inpainting|components/(?!ui/))",
      },
    },
    {
      name: "runtime-cjs-does-not-import-electron",
      severity: "error",
      from: { path: "^src/main/runtime/.*\\.cjs$" },
      to: { path: "^electron$" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    exclude: {
      path: "^(node_modules|out|dist|build|coverage|tools|fonts|docs|logs|models|library)/",
    },
    tsConfig: {
      fileName: "tsconfig.json",
    },
    tsPreCompilationDeps: true,
  },
};
