import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyRelease } from "./release-trust.mjs";

const vector = JSON.parse(
  readFileSync(new URL("./vectors.json", import.meta.url)),
);
const context = {
  platform: "win32",
  arch: "x64",
  currentVersion: "1.0.0",
  serverVersion: "1.0.0",
  serverMinDesktopVersion: "1.0.0",
};

test("a signed compatible stable release is trusted, altered signed bytes are refused", () => {
  assert.deepEqual(
    verifyRelease(vector.envelope, vector.publicKey, context),
    vector.release,
  );
  const altered = {
    ...vector.envelope,
    payload: Buffer.from(
      JSON.stringify({ ...vector.release, size: 1 }),
    ).toString("base64"),
  };
  assert.throws(
    () => verifyRelease(altered, vector.publicKey, context),
    /signature/,
  );
});

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
function signed(payload) {
  const bytes = Buffer.from(
    typeof payload === "string" ? payload : JSON.stringify(payload),
  );
  return {
    format: "nevix-release-v1",
    payload: bytes.toString("base64"),
    signature: sign(null, bytes, keys.privateKey).toString("base64"),
  };
}

test("unknown formats, ambiguous encodings, missing or unknown fields are refused", () => {
  for (const envelope of [
    { ...vector.envelope, format: "v2" },
    { ...vector.envelope, extra: true },
    { ...vector.envelope, payload: vector.envelope.payload + "\n" },
    { ...vector.envelope, signature: vector.envelope.signature.slice(0, -4) },
    null,
  ])
    assert.throws(() => verifyRelease(envelope, vector.publicKey, context));
  const { size, ...missing } = vector.release;
  for (const payload of [
    missing,
    { ...vector.release, extra: true },
    JSON.stringify(vector.release).replace("{", '{\"version\":\"2.0.0\",'),
    " " + JSON.stringify(vector.release),
  ]) {
    assert.throws(() => verifyRelease(signed(payload), publicKey, context));
  }
});

test("wrong platform, channel, old version and incompatible or unknown Server cannot authorize downloading", () => {
  for (const changes of [
    { platform: "darwin" },
    { arch: "arm64" },
    { channel: "beta" },
    { version: "1.0.0" },
    { version: "0.9.9" },
    { version: "01.0.1" },
    { min_server_version: "2.0.0" },
    { min_desktop_version: "unknown" },
    { size: 0 },
    { size: 1.5 },
    { sha512: "wrong" },
    { url: "http://example.invalid/file.exe" },
    { url: "https://user:password@example.invalid/file.exe" },
  ])
    assert.throws(() =>
      verifyRelease(
        signed({ ...vector.release, ...changes }),
        publicKey,
        context,
      ),
    );
  for (const changes of [
    { serverVersion: undefined },
    { serverMinDesktopVersion: undefined },
    { serverVersion: "unknown" },
    { serverMinDesktopVersion: "2.0.0" },
  ])
    assert.throws(() =>
      verifyRelease(vector.envelope, vector.publicKey, {
        ...context,
        ...changes,
      }),
    );
});

test("updater must use exactly the signed version and single artifact description", async () => {
  const { assertUpdaterDescription } = await import("./release-trust.mjs");
  const info = { version: vector.release.version };
  const files = [
    {
      url: new URL(vector.release.url),
      info: { size: vector.release.size, sha512: vector.release.sha512 },
    },
  ];
  assertUpdaterDescription(vector.release, info, files);
  assert.throws(() =>
    assertUpdaterDescription(
      vector.release,
      { ...info, packages: { x64: { path: "unsigned.7z" } } },
      files,
    ),
  );
  assert.throws(() =>
    assertUpdaterDescription(vector.release, { version: "1.0.2" }, files),
  );
  assert.throws(() =>
    assertUpdaterDescription(vector.release, info, [...files, ...files]),
  );
  for (const changes of [{ size: 10 }, { sha512: "wrong" }]) {
    assert.throws(() =>
      assertUpdaterDescription(vector.release, info, [
        { ...files[0], info: { ...files[0].info, ...changes } },
      ]),
    );
  }
  assert.throws(() =>
    assertUpdaterDescription(vector.release, info, [
      { ...files[0], url: new URL("https://example.invalid/replaced.exe") },
    ]),
  );
  assert.throws(() =>
    assertUpdaterDescription(vector.release, info, [
      { ...files[0], packageInfo: { path: "web-package.7z" } },
    ]),
  );
});

test("real cached bytes are verified again before installation, even at the same path", async () => {
  const { verifyArtifact } = await import("./release-trust.mjs");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "nevix-trust-"));
  const file = join(dir, "update.exe");
  try {
    await writeFile(file, Buffer.from(vector.artifactBase64, "base64"));
    await verifyArtifact(vector.release, file);
    await writeFile(file, Buffer.alloc(vector.release.size, "X"));
    await assert.rejects(verifyArtifact(vector.release, file), /bytes/);
    await writeFile(file, "truncated");
    await assert.rejects(verifyArtifact(vector.release, file), /bytes/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Desktop compatibility checks the Server requirement without inventing an old Desktop upgrade floor", () => {
  const payload = { ...vector.release, min_desktop_version: "2.0.0" };
  assert.deepEqual(verifyRelease(signed(payload), publicKey, context), payload);
});
