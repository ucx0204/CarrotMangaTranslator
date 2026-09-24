import { app } from "electron";

/** Let npm run dev retain Vite and replace its own Electron child. */
export async function prepareAppRelaunch(): Promise<void> {
  const send = process.send?.bind(process);
  if (
    app.isPackaged ||
    process.env.MGT_DEV_SUPERVISED_RELAUNCH !== "1" ||
    !send
  ) {
    app.relaunch();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    send({ type: "mgt:dev-relaunch" }, (error: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
