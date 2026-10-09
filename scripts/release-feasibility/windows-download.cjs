// Run only through Electron; no installer is ever executed by this experiment.
const assert = require("node:assert/strict");
const { app } = require("electron");
const { createHash, generateKeyPairSync, sign } = require("node:crypto");
const { createServer } = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "../..");
const scratch = path.join(root, ".scratch/340-release-feasibility");
const runtime = path.join(scratch, "windows-runtime");
app.setPath("userData", path.join(runtime, "userData"));

async function main() {
  const { verifyRelease, assertUpdaterDescription, verifyArtifact } =
    await import(pathToFileURL(path.join(__dirname, "release-trust.mjs")));
  const { NsisUpdater } = require(
    path.join(scratch, "lab/node_modules/electron-updater"),
  );
  const updaterVersion = require(
    path.join(scratch, "lab/node_modules/electron-updater/package.json"),
  ).version;
  assert.equal(updaterVersion, "6.8.9");
  assert.equal(process.versions.electron, "39.8.10");
  assert.equal(
    app.getVersion(),
    "1.0.0",
    "launch the scratch package with version 1.0.0",
  );
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const bytesA = Buffer.from("UNSIGNED INERT NSIS DOWNLOAD FIXTURE A\n");
  const bytesB = Buffer.from("UNSIGNED INERT NSIS DOWNLOAD FIXTURE B\n");
  let metadata,
    servedBytes = bytesA,
    redirect = false;
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push(url.pathname);
    if (url.pathname.endsWith(".yml")) {
      res.setHeader("Content-Type", "text/yaml");
      res.end(JSON.stringify(metadata));
    } else if (url.pathname === "/nevix-1.0.1.exe" && redirect) {
      res.writeHead(302, { Location: "/redirected.exe" });
      res.end();
    } else if (
      ["/nevix-1.0.1.exe", "/nevix-1.0.2.exe", "/redirected.exe"].includes(
        url.pathname,
      )
    ) {
      res.setHeader("Content-Length", servedBytes.length);
      res.end(servedBytes);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const context = {
    platform: "win32",
    arch: "x64",
    currentVersion: "1.0.0",
    serverVersion: "1.0.0",
    serverMinDesktopVersion: "1.0.0",
    allowLoopbackHttp: true,
  };
  const releaseA = {
    version: "1.0.1",
    channel: "stable",
    platform: "win32",
    arch: "x64",
    min_server_version: "1.0.0",
    min_desktop_version: "1.0.0",
    url: base + "nevix-1.0.1.exe",
    size: bytesA.length,
    sha512: createHash("sha512").update(bytesA).digest("base64"),
  };
  const releaseB = {
    ...releaseA,
    version: "1.0.2",
    url: base + "nevix-1.0.2.exe",
    sha512: createHash("sha512").update(bytesB).digest("base64"),
  };
  function envelope(release) {
    const bytes = Buffer.from(JSON.stringify(release));
    return {
      format: "nevix-release-v1",
      payload: bytes.toString("base64"),
      signature: sign(null, bytes, privateKey).toString("base64"),
    };
  }
  function describe(release) {
    return {
      version: release.version,
      files: [{ url: release.url, size: release.size, sha512: release.sha512 }],
    };
  }
  function bind(release, result) {
    assert.equal(result.isUpdateAvailable, true);
    assert.equal(result.downloadPromise, null);
    assertUpdaterDescription(
      release,
      result.updateInfo,
      result.updateInfo.files.map((info) => ({ url: new URL(info.url), info })),
    );
  }
  const cache = path.join(runtime, "cache");
  await fs.mkdir(runtime, { recursive: true });
  await fs.rm(cache, { recursive: true, force: true });
  await fs.writeFile(
    path.join(runtime, "dev-app-update.yml"),
    JSON.stringify({
      updaterCacheDirName: path.relative(
        path.join(os.homedir(), "Library/Caches"),
        cache,
      ),
    }),
  );
  function newUpdater() {
    const updater = new NsisUpdater({ provider: "generic", url: base });
    updater.forceDevUpdateConfig = true;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.disableDifferentialDownload = true;
    updater.disableWebInstaller = true;
    updater.allowDowngrade = false;
    updater.logger = null;
    return updater;
  }
  async function check(updater, signed) {
    const release = verifyRelease(signed, publicKeyPem, context);
    const result = await updater.checkForUpdates();
    bind(release, result);
    return release;
  }
  const checks = [];
  try {
    metadata = describe(releaseA);
    const updater = newUpdater();
    const bad = {
      ...envelope(releaseA),
      signature: Buffer.alloc(64).toString("base64"),
    };
    await assert.rejects(check(updater, bad), /signature/);
    assert.deepEqual(requests, []);
    checks.push("bad signature: no feed or artifact request");

    const trusted = await check(updater, envelope(releaseA));
    assert.equal(requests.filter((p) => p.endsWith(".exe")).length, 0);
    metadata = describe(releaseB);
    const [file] = await updater.downloadUpdate();
    await verifyArtifact(trusted, file);
    assert.deepEqual(
      requests.filter((p) => p.endsWith(".exe")),
      ["/nevix-1.0.1.exe"],
    );
    checks.push(
      "feed switches A to B after check: download remains signed A; actual URL and bytes verified",
    );

    const changed = await updater.checkForUpdates();
    assert.throws(() => bind(trusted, changed), /description/);
    assert.equal(requests.filter((p) => p.endsWith(".exe")).length, 1);
    checks.push("later check adopts B: rebind rejects B before download");

    metadata = describe(releaseA);
    for (const alteration of [
      { version: "1.0.2" },
      { files: [{ ...metadata.files[0], url: releaseB.url }] },
      { files: [{ ...metadata.files[0], size: 999 }] },
      { files: [{ ...metadata.files[0], sha512: releaseB.sha512 }] },
    ]) {
      metadata = { ...describe(releaseA), ...alteration };
      await assert.rejects(
        check(newUpdater(), envelope(releaseA)),
        /description/,
      );
    }
    assert.equal(requests.filter((p) => p.endsWith(".exe")).length, 1);
    checks.push(
      "unsigned metadata version/URL/size/digest substitutions: refused before download",
    );

    metadata = describe(releaseA);
    const cached = newUpdater();
    const cachedRelease = await check(cached, envelope(releaseA));
    const [cachedFile] = await cached.downloadUpdate();
    assert.equal(requests.filter((p) => p.endsWith(".exe")).length, 1);
    await verifyArtifact(cachedRelease, cachedFile);
    checks.push(
      "fresh updater reuses previously downloaded cache; outer byte verification still passes",
    );

    await fs.writeFile(cachedFile, bytesB);
    const [mutatedInMemoryFile] = await cached.downloadUpdate();
    assert.equal(requests.filter((p) => p.endsWith(".exe")).length, 1);
    await assert.rejects(
      verifyArtifact(cachedRelease, mutatedInMemoryFile),
      /bytes/,
    );
    checks.push(
      "same-process updater returns changed cache without rehash: outer pre-install verification refuses it",
    );

    const fresh = newUpdater();
    await check(fresh, envelope(releaseA));
    const [repairedFile] = await fresh.downloadUpdate();
    assert.equal(requests.filter((p) => p.endsWith(".exe")).length, 2);
    await verifyArtifact(trusted, repairedFile);
    checks.push(
      "fresh updater rejects replaced old cache and redownloads signed A",
    );

    await fs.rm(cache, { recursive: true, force: true });
    servedBytes = bytesB;
    const replaced = newUpdater();
    await check(replaced, envelope(releaseA));
    await assert.rejects(replaced.downloadUpdate(), /checksum/i);
    checks.push(
      "server replaces payload at signed URL: updater digest rejects download",
    );

    servedBytes = bytesA;
    redirect = true;
    const redirected = newUpdater();
    await check(redirected, envelope(releaseA));
    const [redirectFile] = await redirected.downloadUpdate();
    await verifyArtifact(trusted, redirectFile);
    assert.ok(requests.includes("/redirected.exe"));
    checks.push(
      "302 redirect serves identical signed bytes: accepted only after digest and size verification",
    );
    await fs.writeFile(redirectFile, Buffer.from("truncated"));
    await assert.rejects(verifyArtifact(trusted, redirectFile), /bytes/);
    checks.push(
      "pre-install bytes replaced/truncated: outer verification refuses installation eligibility",
    );
    assert.equal(redirected.autoInstallOnAppQuit, false);
    assert.equal(redirected.autoDownload, false);
    const report = {
      host: {
        platform: process.platform,
        arch: process.arch,
        os: os.release(),
        electron: process.versions.electron,
        updater: updaterVersion,
      },
      fixture:
        "inert unsigned .exe bytes; no NSIS executable or install action",
      checks,
      requests,
      actualDownloaded: {
        version: trusted.version,
        url: trusted.url,
        size: trusted.size,
        sha512: trusted.sha512,
      },
      windowsInstallation:
        "NOT TESTED: no Windows host; quitAndInstall/install never called",
      ordinaryQuit:
        "autoInstallOnAppQuit=false on every updater; app exits normally without an install action",
    };
    await fs.writeFile(
      path.join(runtime, "result.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

app
  .whenReady()
  .then(main)
  .then(
    () => app.quit(),
    (error) => {
      console.error(error);
      app.exit(1);
    },
  );
