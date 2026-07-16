const { pathToFileURL } = require("node:url");

async function main() {
  const runtimePath = process.argv[2];
  const nativeImportModulePath = process.argv[3];
  if (!runtimePath || !nativeImportModulePath) {
    throw new Error(
      "OAuth runtime path and packaged native import module path are required.",
    );
  }

  const { importNativeEsm } = require(nativeImportModulePath);
  if (typeof importNativeEsm !== "function") {
    throw new Error(
      "Packaged native import module does not export importNativeEsm.",
    );
  }
  const runtime = await importNativeEsm(pathToFileURL(runtimePath).href);
  if (typeof runtime.startOpenAIOAuthServer !== "function") {
    throw new Error(
      "Packaged OAuth runtime does not export startOpenAIOAuthServer.",
    );
  }

  const server = await runtime.startOpenAIOAuthServer({
    host: "127.0.0.1",
    port: 0,
  });
  try {
    if (
      typeof server?.url !== "string" ||
      typeof server?.close !== "function" ||
      server.port <= 0
    ) {
      throw new Error("Packaged OAuth runtime returned an invalid server.");
    }
    console.log(`packaged-oauth-runtime-ok ${server.url}`);
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
