// 화면(ui)에 꼭 필요한 통로 하나만 열어 준다: window.mpl.call(경로, 내용)
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mpl", {
  call: (url, body) => ipcRenderer.invoke("api", url, body),
  onSignIn: (cb) => ipcRenderer.on("ai-signin", (_e, ev) => cb(ev)),
  onAction: (cb) => ipcRenderer.on("action-event", (_e, ev) => cb(ev)),
  onAsk: (cb) => ipcRenderer.on("ask-event", (_e, ev) => cb(ev)),
  onUpdate: (cb) => ipcRenderer.on("update-event", (_e, ev) => cb(ev)),
});
