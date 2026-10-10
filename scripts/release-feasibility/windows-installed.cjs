// Node builds/runs the lab; the same entry is packaged as its Electron Main.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function runInstalled() {
  const { app } = require("electron");
  const { root, publicKey } = require("./lab-config.json");
  app.setAppUserModelId("com.nevix.ai");
  app.setPath("userData", path.join(root, "userData"));
  await app.whenReady();
  const scenario = JSON.parse(
    await fs.readFile(path.join(root, "scenario.json"), "utf8"),
  );
  const write = (result) =>
    fs.writeFile(
      path.join(root, `${scenario.id}.json`),
      JSON.stringify(result, null, 2),
    );
  const version = app.getVersion();
  const host = {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    version,
    executable: process.execPath,
  };
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(process.versions.electron, "39.8.10");
  if (
    version === "1.0.1" ||
    scenario.mode === "relaunch-return" ||
    scenario.mode === "initial"
  ) {
    await write({
      ...host,
      mode: scenario.mode,
      result: "launched",
      executable: process.execPath,
    });
    app.quit();
    return;
  }
  // Keep the updater cache on the workspace drive, including C:/D: CI layouts.
  process.env.LOCALAPPDATA = path.join(root, "cache-home");
  await fs.mkdir(process.env.LOCALAPPDATA, { recursive: true });
  const { NsisUpdater } = require("electron-updater");
  const { verifyRelease, assertUpdaterDescription, verifyArtifact } =
    await import(pathToFileURL(path.join(__dirname, "release-trust.mjs")));
  await fs.writeFile(
    path.join(process.resourcesPath, "app-update.yml"),
    JSON.stringify({
      provider: "generic",
      url: scenario.base,
      updaterCacheDirName: "updater",
    }),
  );
  const updater = new NsisUpdater({ provider: "generic", url: scenario.base });
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.disableDifferentialDownload = true;
  updater.disableWebInstaller = true;
  updater.allowDowngrade = false;
  updater.logger = null;
  const context = {
    platform: "win32",
    arch: "x64",
    currentVersion: version,
    serverVersion: "1.0.0",
    serverMinDesktopVersion: "1.0.0",
    allowLoopbackHttp: true,
  };
  const readRelease = async () =>
    verifyRelease(
      await (await fetch(scenario.base + "release.json")).json(),
      publicKey,
      context,
    );
  const release = await readRelease();
  const result = await updater.checkForUpdates();
  assert.equal(result.isUpdateAvailable, true);
  assert.equal(result.downloadPromise, null);
  assertUpdaterDescription(
    release,
    result.updateInfo,
    result.updateInfo.files.map((info) => ({ url: new URL(info.url), info })),
  );
  const [file] = await updater.downloadUpdate();
  await verifyArtifact(release, file);
  if (scenario.mode === "approved") {
    const currentRelease = await readRelease();
    assert.deepEqual(currentRelease, release);
    await verifyArtifact(currentRelease, file);
    await write({
      ...host,
      result: "approved",
      autoInstallOnAppQuit: updater.autoInstallOnAppQuit,
      signed: release,
    });
    // Only this explicit test scenario approves installation; no UI approval is claimed.
    updater.quitAndInstall(true, true);
  } else if (scenario.mode === "relaunch") {
    await fs.writeFile(
      path.join(root, "scenario.json"),
      JSON.stringify({ ...scenario, mode: "relaunch-return" }),
    );
    app.relaunch();
    app.quit();
  } else {
    assert.ok(["ordinary", "later"].includes(scenario.mode));
    await write({
      ...host,
      result: "downloaded-and-quit",
      autoInstallOnAppQuit: updater.autoInstallOnAppQuit,
      signed: release,
    });
    app.quit();
  }
}

async function runLab() {
  assert.equal(
    process.platform,
    "win32",
    "NSIS installed test requires a Windows runner",
  );
  assert.equal(process.arch, "x64");
  const { spawn } = require("node:child_process");
  const { createHash, generateKeyPairSync, sign } = require("node:crypto");
  const { createServer } = require("node:http");
  const root = path.resolve(
    __dirname,
    "../../.scratch/340-release-feasibility/windows-installed",
  );
  const repo = path.resolve(__dirname, "../..");
  const packageDir = path.join(root, "app");
  const installDir = path.join(root, "installed");
  const executable = path.join(installDir, "Nevix Release Experiment.exe");
  await fs.mkdir(path.join(root, "userData"), { recursive: true });
  await fs.mkdir(packageDir, { recursive: true });
  const run = (command, args, options = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: repo,
        stdio: "inherit",
        ...options,
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
      );
    });
  async function waitFor(file, predicate) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const value = JSON.parse(await fs.readFile(file, "utf8"));
        if (predicate(value)) return value;
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
          throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out awaiting ${file}`);
  }
  const npmCli = path.join(
    path.dirname(process.execPath),
    "node_modules/npm/bin/npm-cli.js",
  );
  await fs.access(npmCli);
  const scratch = path.dirname(root);
  const lab = path.join(scratch, "lab");
  const downloadRuntime = path.join(scratch, "windows-runtime");
  await fs.mkdir(lab, { recursive: true });
  await fs.mkdir(path.join(downloadRuntime, "userData"), { recursive: true });
  await fs.writeFile(
    path.join(downloadRuntime, "package.json"),
    JSON.stringify({
      name: "nevix-windows-download-experiment",
      version: "1.0.0",
      main: path.join(__dirname, "windows-download.cjs"),
    }),
  );
  await fs.rm(path.join(downloadRuntime, "result.json"), { force: true });
  await run(process.execPath, [
    npmCli,
    "install",
    "--prefix",
    lab,
    "--no-audit",
    "--no-fund",
    "electron-updater@6.8.9",
  ]);
  await run(
    path.join(repo, "apps/desktop/node_modules/electron/dist/electron.exe"),
    [downloadRuntime],
  );
  const downloadReport = JSON.parse(
    await fs.readFile(path.join(downloadRuntime, "result.json"), "utf8"),
  );
  assert.equal(downloadReport.host.platform, "win32");
  assert.equal(downloadReport.host.arch, "x64");
  assert.equal(downloadReport.checks.length, 10);

  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  await fs.copyFile(__filename, path.join(packageDir, "windows-installed.cjs"));
  await fs.copyFile(
    path.join(__dirname, "release-trust.mjs"),
    path.join(packageDir, "release-trust.mjs"),
  );
  await fs.writeFile(
    path.join(packageDir, "lab-config.json"),
    JSON.stringify({ root, publicKey }),
  );
  const builderDir = path.join(
    repo,
    "apps/desktop/node_modules/electron-builder",
  );
  assert.equal(
    require(path.join(builderDir, "package.json")).version,
    "26.15.3",
  );
  assert.equal(
    require(path.join(repo, "apps/desktop/node_modules/electron/package.json"))
      .version,
    "39.8.10",
  );
  const config = {
    appId: "com.nevix.ai",
    productName: "Nevix Release Experiment",
    electronVersion: "39.8.10",
    directories: { app: packageDir, output: path.join(root, "artifacts") },
    files: ["**/*"],
    npmRebuild: false,
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      signAndEditExecutable: false,
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      runAfterFinish: false,
      createDesktopShortcut: false,
      createStartMenuShortcut: false,
      artifactName: "nevix-lab-${version}.exe",
    },
    publish: { provider: "generic", url: "http://127.0.0.1/unused" },
  };
  const configPath = path.join(root, "builder.json");
  await fs.writeFile(configPath, JSON.stringify(config));
  for (const version of ["1.0.0", "1.0.1"]) {
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "nevix-release-experiment",
        version,
        description: "Isolated release feasibility lab",
        author: "Nevix AI",
        main: "windows-installed.cjs",
        dependencies: { "electron-updater": "6.8.9" },
      }),
    );
    if (version === "1.0.0") {
      await run(process.execPath, [
        npmCli,
        "install",
        "--prefix",
        packageDir,
        "--no-audit",
        "--no-fund",
      ]);
    }
    await run(process.execPath, [
      path.join(builderDir, "cli.js"),
      "--win",
      "--x64",
      "--config",
      configPath,
      "--publish",
      "never",
    ]);
  }
  const oldInstaller = path.join(root, "artifacts/nevix-lab-1.0.0.exe");
  const newInstaller = path.join(root, "artifacts/nevix-lab-1.0.1.exe");
  const bytes = await fs.readFile(newInstaller);
  const requests = [];
  let envelope, metadata;
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    requests.push(pathname);
    if (pathname === "/release.json") res.end(JSON.stringify(envelope));
    else if (pathname === "/latest.yml") res.end(JSON.stringify(metadata));
    else if (pathname === "/nevix-lab-1.0.1.exe") {
      res.setHeader("Content-Length", bytes.length);
      res.end(bytes);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const release = {
    version: "1.0.1",
    channel: "stable",
    platform: "win32",
    arch: "x64",
    min_server_version: "1.0.0",
    min_desktop_version: "1.0.0",
    url: base + "nevix-lab-1.0.1.exe",
    size: bytes.length,
    sha512: createHash("sha512").update(bytes).digest("base64"),
  };
  const payload = Buffer.from(JSON.stringify(release));
  envelope = {
    format: "nevix-release-v1",
    payload: payload.toString("base64"),
    signature: sign(null, payload, keys.privateKey).toString("base64"),
  };
  metadata = {
    version: release.version,
    files: [{ url: release.url, size: release.size, sha512: release.sha512 }],
  };
  const results = [];
  try {
    await fs.writeFile(
      path.join(root, "scenario.json"),
      JSON.stringify({ id: "initial", mode: "initial", base }),
    );
    await run(oldInstaller, ["/S", `/D=${installDir}`]);
    await fs.access(executable);
    async function launch(id, mode) {
      await fs.rm(path.join(root, `${id}.json`), { force: true });
      await fs.writeFile(
        path.join(root, "scenario.json"),
        JSON.stringify({ id, mode, base }),
      );
      const exited = run(executable, []);
      const [result] = await Promise.all([
        waitFor(path.join(root, `${id}.json`), (value) =>
          mode === "approved"
            ? value.version === "1.0.1"
            : value.version === "1.0.0",
        ),
        exited,
      ]);
      return result;
    }
    results.push(await launch("initial", "initial"));
    results.push(await launch("ordinary", "ordinary"));
    results.push(await launch("after-ordinary", "initial"));
    results.push(await launch("later", "later"));
    results.push(await launch("after-later", "initial"));
    results.push(await launch("relaunch", "relaunch"));
    results.push(await launch("approved", "approved"));
    assert.ok(
      results.slice(0, -1).every((result) => result.version === "1.0.0"),
    );
    assert.equal(results.at(-1).version, "1.0.1");
    assert.ok(
      results.every((result) => path.resolve(result.executable) === executable),
    );
    assert.equal(results[1].autoInstallOnAppQuit, false);
    assert.equal(results[3].autoInstallOnAppQuit, false);
    const report = {
      host: {
        platform: process.platform,
        arch: process.arch,
        os: require("node:os").release(),
      },
      downloadSafetyChecks: downloadReport.checks,
      results,
      requests,
      signedRelease: release,
      limitations: [
        "No production renderer/window readiness approval tested",
        "SmartScreen policy/manual approval is not exercised by silent CI installation",
      ],
    };
    await fs.writeFile(
      path.join(root, "result.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

(process.versions.electron ? runInstalled() : runLab()).catch(async (error) => {
  console.error(error);
  if (process.versions.electron) {
    const { root } = require("./lab-config.json");
    await fs.writeFile(
      path.join(root, "runtime-error.json"),
      JSON.stringify({ message: error.message, stack: error.stack }),
    );
    require("electron").app.exit(1);
  } else process.exitCode = 1;
});
