import { beforeAll, beforeEach } from "vitest";
import { appI18n, initializeAppI18n } from "../src/renderer/src/appI18n";

beforeAll(async () => {
  await initializeAppI18n("ko");
});

beforeEach(async () => {
  await appI18n.changeLanguage("ko");
});
