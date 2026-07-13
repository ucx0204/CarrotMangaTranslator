import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  externalIpcContracts,
  fontIpcContracts,
  importShareIpcContracts,
  inpaintingIpcContracts,
  ipcEventContracts,
  ipcInvokeContracts,
  jobControlIpcContracts,
  libraryIpcContracts,
  logsIpcContracts,
  pageImageExportIpcContracts,
  settingsIpcContracts,
  textReviewIpcContracts,
  translationJobIpcContracts,
  workContextIpcContracts,
  type IpcContract,
} from "../src/shared/ipcContracts";

const invokeContractGroups = [
  {
    sourceName: "importShareIpcContracts",
    contracts: importShareIpcContracts,
    mainFiles: ["src/main/ipc/importShareIpc.ts"],
  },
  {
    sourceName: "libraryIpcContracts",
    contracts: libraryIpcContracts,
    mainFiles: ["src/main/ipc/libraryIpc.ts"],
  },
  {
    sourceName: "workContextIpcContracts",
    contracts: workContextIpcContracts,
    mainFiles: ["src/main/ipc/workContextIpc.ts"],
  },
  {
    sourceName: "textReviewIpcContracts",
    contracts: textReviewIpcContracts,
    mainFiles: [
      "src/main/ipc/textExportIpc.ts",
      "src/main/ipc/reviewTextIpc.ts",
    ],
  },
  {
    sourceName: "fontIpcContracts",
    contracts: fontIpcContracts,
    mainFiles: ["src/main/ipc/fontsIpc.ts"],
  },
  {
    sourceName: "settingsIpcContracts",
    contracts: settingsIpcContracts,
    mainFiles: ["src/main/ipc/settingsIpc.ts"],
  },
  {
    sourceName: "externalIpcContracts",
    contracts: externalIpcContracts,
    mainFiles: ["src/main/ipc/externalLinksIpc.ts"],
  },
  {
    sourceName: "logsIpcContracts",
    contracts: logsIpcContracts,
    mainFiles: ["src/main/ipc/logsIpc.ts"],
  },
  {
    sourceName: "translationJobIpcContracts",
    contracts: translationJobIpcContracts,
    mainFiles: ["src/main/ipc/translationJobIpc.ts"],
  },
  {
    sourceName: "inpaintingIpcContracts",
    contracts: inpaintingIpcContracts,
    mainFiles: ["src/main/ipc/inpaintingIpc.ts"],
  },
  {
    sourceName: "pageImageExportIpcContracts",
    contracts: pageImageExportIpcContracts,
    mainFiles: ["src/main/ipc/pageImageExportIpc.ts"],
  },
  {
    sourceName: "jobControlIpcContracts",
    contracts: jobControlIpcContracts,
    mainFiles: ["src/main/ipc/jobControlIpc.ts"],
  },
] as const;

const invokeContractEntries = Object.entries(ipcInvokeContracts);

describe("IPC contracts", () => {
  it("keeps invoke API keys and channels unique and explicit", () => {
    const keys = invokeContractEntries.map(([, contract]) => contract.apiKey);
    const channels = invokeContractEntries.map(
      ([, contract]) => contract.channel,
    );

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(channels).size).toBe(channels.length);
    for (const [name, contract] of invokeContractEntries) {
      expect(contract.apiKey).toBe(name);
    }
  });

  it("routes preload invoke calls through invokeContract", () => {
    const preloadSource = readProjectFile("src/preload/index.ts");

    expect(preloadSource).not.toContain("ipcRenderer.invoke(");
    for (const group of invokeContractGroups) {
      for (const name of Object.keys(group.contracts)) {
        expect(preloadSource).toContain(
          `invokeContract(${group.sourceName}.${name}`,
        );
      }
    }
  });

  it("routes main invoke handlers through trustedHandleContract", () => {
    for (const group of invokeContractGroups) {
      const mainSource = group.mainFiles.map(readProjectFile).join("\n");
      expect(mainSource).not.toContain('trustedHandle(context, "');

      for (const [name, contract] of Object.entries(group.contracts) as Array<
        [string, IpcContract]
      >) {
        expect(mainSource).toContain(`${group.sourceName}.${name}`);
        expect(mainSource).not.toContain(`"${contract.channel}"`);
      }
    }
  });

  it("routes renderer and main events through event contracts", () => {
    const preloadSource = readProjectFile("src/preload/index.ts");
    const mainSource = [
      "src/main/jobs/jobEvents.ts",
      "src/main/ipc/jobControlIpc.ts",
      "src/main/ipc/settingsIpc.ts",
    ]
      .map(readProjectFile)
      .join("\n");

    expect(preloadSource).toContain("ipcEventContracts.jobEvent.channel");
    expect(preloadSource).toContain(
      "ipcEventContracts.modelTestProgress.channel",
    );
    expect(mainSource).toContain("ipcEventContracts.jobEvent.channel");
    expect(mainSource).toContain("ipcEventContracts.modelTestProgress.channel");

    for (const contract of Object.values(ipcEventContracts)) {
      expect(preloadSource).not.toContain(`"${contract.channel}"`);
      expect(mainSource).not.toContain(`"${contract.channel}"`);
    }
  });
});

function readProjectFile(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}
