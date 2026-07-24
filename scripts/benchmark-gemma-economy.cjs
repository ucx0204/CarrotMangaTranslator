const { app } = require("electron");
const { main } = require("./gemma-benchmark/runner.cjs");

main().catch((error) => {
  console.error(error);
  app.quit();
  process.exitCode = 1;
});
