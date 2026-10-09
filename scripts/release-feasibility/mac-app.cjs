// Experiment only: the packaged config confines state to this lab's scratch directory.
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  autoUpdater: nativeUpdater,
} = require("electron");
const { MacUpdater } = require("electron-updater");
const { appendFileSync, readFileSync, mkdirSync } = require("node:fs");
const assert = require("node:assert/strict");
const { homedir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const config = require("./lab-config.json");

mkdirSync(join(config.root, "user-data"), { recursive: true });
mkdirSync(join(config.root, "cache"), { recursive: true });
app.setPath("userData", join(config.root, "user-data"));
app.setPath("cache", join(config.root, "cache"));
const log = (event, detail = {}) =>
  appendFileSync(
    join(config.root, "events.jsonl"),
    JSON.stringify({
      time: new Date().toISOString(),
      version: app.getVersion(),
      event,
      ...detail,
    }) + "\n",
  );
let window;
let updater;
let release;
let artifact;
let trust;
let installing = false;

function report(text) {
  log("status", { text });
  window?.webContents
    .executeJavaScript(`document.body.innerText = ${JSON.stringify(text)}`)
    .catch(() => {});
}

async function install() {
  if (installing || !artifact) return;
  const { response } = await dialog.showMessageBox(window, {
    type: "question",
    title: "Nevix 更新实验",
    message: "明确批准本次实验更新并重启？",
    detail: "仅更新隔离的实验应用；稍后与普通退出不会安装。",
    buttons: ["稍后", "批准本次安装"],
    defaultId: 0,
    cancelId: 0,
  });
  log("confirmation", { approved: response === 1 });
  if (response !== 1 || installing) return;
  try {
    // This lab has no business drafts/uploads; production readiness is a later ticket.
    await trust.verifyArtifact(release, artifact);
    installing = true;
    log("install-approved", { artifact });
    updater.quitAndInstall();
  } catch (error) {
    report(`拒绝安装: ${error.message}`);
  }
}

app.whenReady().then(async () => {
  log("boot", {
    packaged: app.isPackaged,
    arch: process.arch,
    electron: process.versions.electron,
  });
  window = new BrowserWindow({
    width: 660,
    height: 300,
    webPreferences: { sandbox: true },
  });
  await window.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent('<meta charset="UTF-8"><body>启动实验应用</body>'),
  );
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "更新实验",
        submenu: [
          { label: "确认重启安装", click: install },
          {
            label: "稍后并正常退出",
            click: () => {
              log("later");
              app.quit();
            },
          },
          { label: "普通退出", role: "quit" },
        ],
      },
    ]),
  );
  nativeUpdater.on("update-downloaded", () => log("native-update-downloaded"));
  nativeUpdater.on("error", (error) =>
    report(`Squirrel 拒绝: ${error.message}`),
  );
  try {
    if (app.getVersion() === "0.1.341") {
      report(`已运行实验预期新版 ${app.getVersion()}`);
      return;
    }
    const envelope = JSON.parse(
      readFileSync(join(config.root, "release.json"), "utf8"),
    );
    const publicKey = readFileSync(
      join(config.root, "release-public.pem"),
      "utf8",
    );
    trust = await import(
      pathToFileURL(join(__dirname, "release-trust.mjs")).href
    );
    release = trust.verifyRelease(envelope, publicKey, {
      platform: "darwin",
      arch: "arm64",
      currentVersion: app.getVersion(),
      serverVersion: "1.0.0",
      serverMinDesktopVersion: "0.1.0",
      allowLoopbackHttp: true,
    });
    const updateConfig = JSON.parse(
      readFileSync(join(process.resourcesPath, "app-update.yml"), "utf8"),
    );
    assert.equal(
      resolve(homedir(), "Library", "Caches", updateConfig.updaterCacheDirName),
      join(config.root, "cache"),
    );
    updater = new MacUpdater({
      provider: "generic",
      url: "http://127.0.0.1:13400/",
    });
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.disableDifferentialDownload = true;
    updater.allowDowngrade = false;
    updater.logger = {
      info: (message) => log("updater", { message }),
      warn: (message) => log("warning", { message: String(message) }),
      error: (message) => log("error", { message: String(message) }),
      debug: (message) => log("debug", { message }),
    };
    updater.on("error", (error) => report(`更新失败: ${error.message}`));
    updater.on("update-downloaded", (event) => {
      artifact = event.downloadedFile;
    });
    const result = await updater.checkForUpdates();
    trust.assertUpdaterDescription(
      release,
      result.updateInfo,
      result.updateInfo.files.map((file) => ({
        url: new URL(file.url, "http://127.0.0.1:13400/"),
        info: file,
      })),
    );
    await updater.downloadUpdate();
    await trust.verifyArtifact(release, artifact);
    log("download-verified", { artifact });
    report(
      `版本 ${app.getVersion()}：更新已下载；从“更新实验”菜单明确确认后才安装。`,
    );
  } catch (error) {
    report(`拒绝更新: ${error.message}`);
  }
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => log("before-quit", { installing }));
