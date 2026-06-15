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
      name: "ipc-and-jobs-use-locked-library-facade",
      severity: "error",
      from: { path: "^src/main/(ipc|jobs)/" },
      to: { path: "^src/main/libraryStore/" },
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
