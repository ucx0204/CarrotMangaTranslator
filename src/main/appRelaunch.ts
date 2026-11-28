import { app } from "electron";
import { RENDERER_RECOVERY_ARGUMENT } from "./bootstrapGraphicsGpu";

/** Let npm run dev retain Vite and replace its own Electron child. */
export async function prepareAppRelaunch(
  rendererRecovery = false,
): Promise<void> {
  const send = process.send?.bind(process);
  if (
    app.isPackaged ||
    process.env.MGT_DEV_SUPERVISED_RELAUNCH !== "1" ||
    !send
  ) {
    if (rendererRecovery) {
      app.relaunch({
        args: [
          ...process.argv
            .slice(1)
            .filter((arg) => arg !== RENDERER_RECOVERY_ARGUMENT),
          RENDERER_RECOVERY_ARGUMENT,
        ],
      });
    } else {
      app.relaunch();
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    send(
      {
        type: "mgt:dev-relaunch",
        ...(rendererRecovery && { rendererRecovery }),
      },
      (error: Error | null) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}
