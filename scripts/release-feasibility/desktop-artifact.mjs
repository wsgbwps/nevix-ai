import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repository = resolve(import.meta.dirname, "../..");
const desktop = join(repository, "apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const builderRequire = createRequire(require.resolve("electron-builder"));
const asar = builderRequire("@electron/asar");

export function assertPublicDesktopArchive(archive) {
  asar.uncache(archive);
  const files = asar.listPackage(archive);
  assert.ok(files.length > 0, "Empty Desktop archive");
  for (const entry of files) {
    const nativeFile = entry.replace(/^[/\\]/, "");
    const file = nativeFile.replaceAll("\\", "/");
    assert.ok(
      /^(?:out|node_modules)(?:\/|$)/.test(file) ||
        ["package.json", "resources", "resources/icon.png"].includes(file),
      `Unexpected app-owned path: ${file}`,
    );
    assert.ok(
      !/\.(?:map|tsx?|mts|cts|p12|pfx|pem|key)$/i.test(file) &&
        !/(?:^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$))/.test(file),
      `Non-public artifact path: ${file}`,
    );
    const info = asar.statFile(archive, nativeFile, false);
    assert.ok(!info.link, `Unexpected artifact link: ${file}`);
    if (info.files) continue;
    const bytes = asar.extractFile(archive, nativeFile);
    assert.ok(
      !/sourceMappingURL=\s*data:/.test(bytes.toString("utf8")),
      `Inline source map in artifact: ${file}`,
    );
    assert.ok(
      !/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z]+ )*PRIVATE KEY-----/.test(
        bytes.toString("utf8"),
      ),
      `Private key in artifact: ${file}`,
    );
  }
  return files.length;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(require("electron-builder/package.json").version, "26.15.3");
  assert.equal(require("electron/package.json").version, "39.8.10");
  const { build, Platform, Arch } = require("electron-builder");
  await build({
    projectDir: desktop,
    targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
    publish: "never",
    config: {
      extends: join(desktop, "electron-builder.yml"),
      files: [
        "out/**/*",
        "package.json",
        "resources/icon.png",
        "!**/*.{map,ts,tsx,mts,cts,p12,pfx,pem,key}",
        "!**/.env*",
        "!**/.git/**",
      ],
      afterPack: ({ appOutDir }) => {
        const files = assertPublicDesktopArchive(
          join(appOutDir, "resources/app.asar"),
        );
        console.log(`Public Desktop archive checked: ${files} entries`);
      },
    },
  });
}
