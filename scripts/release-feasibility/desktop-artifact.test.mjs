import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assertPublicDesktopArchive } from "./desktop-artifact.mjs";

const desktopRequire = createRequire(resolve("apps/desktop/package.json"));
const builderRequire = createRequire(
  desktopRequire.resolve("electron-builder"),
);
const { createPackage } = builderRequire("@electron/asar");

test("actual Desktop archive accepts compiled files and refuses internal source, maps and keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "nevix-artifact-review-"));
  try {
    const app = join(root, "app");
    await mkdir(join(app, "out/main"), { recursive: true });
    await writeFile(join(app, "out/main/index.js"), "console.log('compiled')");
    await writeFile(
      join(app, "out/main/map-parser.js"),
      'const pattern = /^[@#]\\s+sourceMappingURL=data:(?:application|text)\\/json/;\nconst prefix = "//# sourceMappingURL=data:application/json;base64,";',
    );
    await writeFile(join(app, "package.json"), '{"version":"0.1.0"}');
    const archive = join(root, "app.asar");
    await createPackage(app, archive);
    assertPublicDesktopArchive(archive);

    for (const [file, bytes] of [
      ["AGENTS.md", "internal instructions"],
      ["out/main/index.js.map", "{}"],
      ["out/main/source.ts", "const source = true"],
      ["out/.env", "TOKEN=not-a-real-token"],
      ["out/cert.key", "fixture"],
      [
        "out/main/inline.js",
        "//# sourceMappingURL=data:application/json;base64,e30=",
      ],
      [
        "out/main/inline-css.js",
        "/*# sourceMappingURL=data:application/json;base64,e30= */",
      ],
      [
        "out/main/trailing.js",
        "console.log('compiled'); //# sourceMappingURL=data:application/json;base64,e30=",
      ],
      [
        "out/main/percent.js",
        "//# sourceMappingURL=data:application/json,%7B%22version%22%3A3%7D",
      ],
      [
        "out/main/raw-map.js",
        '//# sourceMappingURL=data:application/json,{"version":3}',
      ],
      [
        "out/main/leak.js",
        "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----",
      ],
    ]) {
      await writeFile(join(app, file), bytes);
      await createPackage(app, archive);
      assert.throws(() => assertPublicDesktopArchive(archive));
      await rm(join(app, file));
    }
    if (process.platform !== "win32") {
      await symlink("index.js", join(app, "out/main/linked.js"));
      await createPackage(app, archive);
      assert.throws(() => assertPublicDesktopArchive(archive), /artifact link/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
