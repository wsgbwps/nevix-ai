import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "../..");
const root = join(repository, ".scratch/340-release-feasibility/mac");
const require = createRequire(join(repository, "apps/desktop/package.json"));

if (process.argv[2] === "serve") {
  const server = createServer(async (request, response) => {
    const file = new URL(request.url, "http://127.0.0.1:13400").pathname.slice(
      1,
    );
    if (
      !/^latest-mac\.yml$|^Nevix-Experiment-0\.1\.34[12]-arm64\.zip$/.test(file)
    ) {
      response.writeHead(404).end();
      return;
    }
    try {
      const path = join(root, "feed", file);
      response.writeHead(200, { "Content-Length": (await stat(path)).size });
      createReadStream(path).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.listen(13400, "127.0.0.1", () =>
    console.log("Experimental feed: http://127.0.0.1:13400/"),
  );
} else {
  assert.equal(
    process.argv[2],
    "build",
    "Usage: node mac-build.mjs build|serve",
  );
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  const keychain = process.env.NEVIX_LAB_KEYCHAIN;
  const identity = process.env.NEVIX_LAB_IDENTITY;
  assert.ok(
    keychain && identity,
    "Supply an isolated test keychain and certificate SHA1; no signing fallback.",
  );
  assert.match(identity, /^[A-Fa-f0-9]{40}$/);
  const builderPath = require.resolve("electron-builder");
  const builderRequire = createRequire(builderPath);
  const { signAsync } = builderRequire("@electron/osx-sign");
  const { build, Platform, Arch } = require("electron-builder");
  assert.equal(require("electron-builder/package.json").version, "26.15.3");
  assert.equal(require("electron/package.json").version, "39.8.10");
  await mkdir(root, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await writeFile(
    join(root, "release-public.pem"),
    publicKey.export({ type: "spki", format: "pem" }),
  );
  const original = [
    ...execFileSync("security", ["list-keychains", "-d", "user"], {
      encoding: "utf8",
    }).matchAll(/"([^"]+)"/g),
  ].map((match) => match[1]);
  try {
    // codesign still needs the search list even when --keychain is supplied.
    execFileSync("security", [
      "list-keychains",
      "-d",
      "user",
      "-s",
      ...original,
      keychain,
    ]);
    for (const version of ["0.1.340", "0.1.341"]) {
      const project = join(root, version);
      await mkdir(project, { recursive: true });
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({
          name: "nevix-release-experiment",
          version,
          main: "mac-app.cjs",
          description: "Issue 340 isolated feasibility experiment",
          author: "Nevix",
          dependencies: { "electron-updater": "6.8.9" },
        }),
      );
      await copyFile(
        join(import.meta.dirname, "mac-app.cjs"),
        join(project, "mac-app.cjs"),
      );
      await copyFile(
        join(import.meta.dirname, "release-trust.mjs"),
        join(project, "release-trust.mjs"),
      );
      await writeFile(
        join(project, "lab-config.json"),
        JSON.stringify({ root }),
      );
      execFileSync(
        "npm",
        [
          "install",
          "--omit=dev",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        { cwd: project, stdio: "inherit" },
      );
      const outputs = await build({
        projectDir: project,
        targets: Platform.MAC.createTarget(["dmg", "zip"], Arch.arm64),
        publish: "never",
        config: {
          appId: "com.nevix.ai",
          productName: "Nevix Release Experiment",
          electronVersion: "39.8.10",
          electronDist: join(
            repository,
            "apps/desktop/node_modules/electron/dist",
          ),
          directories: { output: join(project, "dist") },
          npmRebuild: false,
          files: [
            "mac-app.cjs",
            "release-trust.mjs",
            "lab-config.json",
            "package.json",
            "node_modules/**/*",
          ],
          mac: {
            identity: null,
            notarize: false,
            artifactName: "Nevix-Experiment-${version}-arm64.${ext}",
          },
          publish: { provider: "generic", url: "http://127.0.0.1:13400/" },
          afterPack: async ({ appOutDir }) => {
            const appPath = join(appOutDir, "Nevix Release Experiment.app");
            const updaterCacheDirName = relative(
              join(homedir(), "Library", "Caches"),
              join(root, "cache"),
            );
            assert.equal(
              resolve(homedir(), "Library", "Caches", updaterCacheDirName),
              join(root, "cache"),
            );
            await writeFile(
              join(appPath, "Contents/Resources/app-update.yml"),
              JSON.stringify({
                provider: "generic",
                url: "http://127.0.0.1:13400/",
                updaterCacheDirName,
              }),
            );
            await signAsync({
              app: appPath,
              identity,
              keychain,
              identityValidation: false,
              preAutoEntitlements: false,
              optionsForFile: () => ({
                entitlements: join(
                  repository,
                  "apps/desktop/build/entitlements.mac.plist",
                ),
                hardenedRuntime: true,
                timestamp: "none",
              }),
            });
            execFileSync(
              "codesign",
              ["--verify", "--deep", "--strict", "--verbose=2", appPath],
              { stdio: "inherit" },
            );
          },
        },
      });
      console.log(JSON.stringify({ version, outputs }));
    }
  } finally {
    execFileSync("security", [
      "list-keychains",
      "-d",
      "user",
      "-s",
      ...original,
    ]);
  }
  await mkdir(join(root, "feed"), { recursive: true });
  const filename = "Nevix-Experiment-0.1.341-arm64.zip";
  await copyFile(
    join(root, "0.1.341/dist", filename),
    join(root, "feed", filename),
  );
  const bytes = await readFile(join(root, "feed", filename));
  const payload = {
    version: "0.1.341",
    channel: "stable",
    platform: "darwin",
    arch: "arm64",
    min_server_version: "1.0.0",
    min_desktop_version: "0.1.0",
    url: "http://127.0.0.1:13400/" + filename,
    size: bytes.length,
    sha512: createHash("sha512").update(bytes).digest("base64"),
  };
  const exact = Buffer.from(JSON.stringify(payload));
  await writeFile(
    join(root, "release.json"),
    JSON.stringify(
      {
        format: "nevix-release-v1",
        payload: exact.toString("base64"),
        signature: sign(null, exact, privateKey).toString("base64"),
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(root, "feed/latest-mac.yml"),
    JSON.stringify({
      version: payload.version,
      files: [{ url: payload.url, size: payload.size, sha512: payload.sha512 }],
    }),
  );
  assert.ok(
    (await readdir(join(root, "0.1.340/dist"))).some((file) =>
      file.endsWith(".dmg"),
    ),
  );
  console.log(
    "Signed DMG+ZIP built; release.json binds the exact new ZIP. Install the old DMG into an isolated directory, then start serve.",
  );
}
