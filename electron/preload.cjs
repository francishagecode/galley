// The few native capabilities the frontend needs; it reaches them through
// src/platform.js.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("galley", {
  invoke: async (command, args) => {
    const result = await ipcRenderer.invoke("galley:invoke", command, args);
    if ("error" in result) throw result.error;
    return result.value;
  },
  open: (options) => ipcRenderer.invoke("galley:open", options),
  save: (options) => ipcRenderer.invoke("galley:save", options),
  takeLaunchTarget: () => ipcRenderer.invoke("galley:take-launch-target"),
  onOpenRequest: (callback) => ipcRenderer.on("galley:open", (_event, target) => callback(target)),
});
