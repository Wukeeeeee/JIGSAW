/* ============================================================
   JIGSAW — 桌面壳（Electron 主进程）
   启动方式：cd desktop && npm start
   加载 ../index.html（与网页版共用同一套前端代码）
   ============================================================ */
const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");

const APP_URL = "file://" + path.resolve(__dirname, "..", "index.html").replace(/\\/g, "/");

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "JIGSAW",
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // 去掉默认菜单，保持极简桌面应用外观
  Menu.setApplicationMenu(null);

  // 窗口标题固定为 JIGSAW，不被页面 <title> 覆盖
  win.on("page-title-updated", e => e.preventDefault());

  win.loadURL(APP_URL);

  // 阻止页面内导航离开本应用
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // 外部链接一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
