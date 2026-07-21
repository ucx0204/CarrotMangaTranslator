import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  APP_MAC_ALPHA_ISSUE_URL,
  resolveMacIssueMenuTarget,
} from "../shared/appRelease";
import { isAppleSiliconAlpha } from "./buildChannel";
import { tMain } from "./i18n";

const MAC_ALPHA_ONBOARDING_MARKER = ".mac-alpha-onboarding-v1";
type WarningLogger = (message: string, detail?: unknown) => void;

export function installNativeApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const alpha = isAppleSiliconAlpha();
  const issueMenuTarget = resolveMacIssueMenuTarget(alpha);
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        {
          label: tMain("macAlpha.aboutMenu", { appName: app.name }),
          click: () => void showAboutDialog(),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: tMain(issueMenuTarget.labelKey),
          click: () => void shell.openExternal(issueMenuTarget.url),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function reactivateDock(): void {
  if (process.platform === "darwin") {
    void app.dock?.show();
  }
}

export async function showMacAlphaFirstRunNotice(
  dataRoot: string,
  parent: BrowserWindow | null,
  logWarning: WarningLogger,
): Promise<void> {
  if (!isAppleSiliconAlpha()) {
    return;
  }
  const markerPath = join(dataRoot, MAC_ALPHA_ONBOARDING_MARKER);
  if (existsSync(markerPath)) {
    return;
  }
  const options: Electron.MessageBoxOptions = {
    type: "info",
    title: tMain("macAlpha.firstRunTitle"),
    message: tMain("macAlpha.firstRunMessage"),
    detail: tMain("macAlpha.firstRunDetail"),
    buttons: [tMain("macAlpha.continue"), tMain("macAlpha.reportIssueMenu")],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  if (result.response === 1) {
    await shell.openExternal(APP_MAC_ALPHA_ISSUE_URL);
  }
  try {
    await writeFile(markerPath, `${new Date().toISOString()}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (!existsSync(markerPath)) {
      logWarning(
        "Failed to persist macOS Alpha first-run acknowledgement",
        error,
      );
    }
  }
}

async function showAboutDialog(): Promise<void> {
  const alpha = isAppleSiliconAlpha();
  await dialog.showMessageBox({
    type: "info",
    title: tMain("macAlpha.aboutMenu", { appName: app.name }),
    message: `${app.name} ${app.getVersion()}`,
    detail: alpha
      ? tMain("macAlpha.aboutDetail")
      : tMain("macAlpha.stableAboutDetail"),
    buttons: [tMain("macAlpha.continue")],
    noLink: true,
  });
}
