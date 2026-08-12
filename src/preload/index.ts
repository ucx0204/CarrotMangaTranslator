import { contextBridge, ipcRenderer, webUtils } from "electron";
import { createContractInvoker } from "./ipcContracts";
import { createMangaApi, type IpcEventPort } from "./mangaApi";

const eventPort: IpcEventPort = {
  on: (channel, listener) => {
    ipcRenderer.on(channel, listener);
  },
  removeListener: (channel, listener) => {
    ipcRenderer.removeListener(channel, listener);
  },
};

const api = createMangaApi({
  invoke: createContractInvoker(ipcRenderer),
  events: eventPort,
  getPathForFile: (file) => webUtils.getPathForFile(file),
  warn: (message) => console.warn(message),
});

contextBridge.exposeInMainWorld("mangaApi", api);
