import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";

function exactFields(value, fields) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...fields].sort().join(",")
  ) {
    throw new Error("Invalid release fields");
  }
}

function base64(value, length) {
  if (typeof value !== "string") throw new Error("Invalid base64");
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.toString("base64") !== value ||
    (length !== undefined && bytes.length !== length)
  ) {
    throw new Error("Invalid base64");
  }
  return bytes;
}

function compareVersion(left, right) {
  const parse = (value) => {
    if (
      typeof value !== "string" ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value)
    ) {
      throw new Error("Invalid stable version");
    }
    return value.split(".").map(BigInt);
  };
  const a = parse(left),
    b = parse(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function verifyRelease(envelope, publicKeyPem, context) {
  exactFields(envelope, ["format", "payload", "signature"]);
  if (envelope.format !== "nevix-release-v1")
    throw new Error("Unknown release format");
  const bytes = base64(envelope.payload);
  const publicKey = createPublicKey(publicKeyPem);
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    !verify(null, bytes, publicKey, base64(envelope.signature, 64))
  ) {
    throw new Error("Invalid release signature");
  }
  const payload = JSON.parse(bytes.toString("utf8"));
  if (!Buffer.from(JSON.stringify(payload)).equals(bytes))
    throw new Error("Ambiguous release JSON");
  exactFields(payload, [
    "version",
    "channel",
    "platform",
    "arch",
    "min_server_version",
    "min_desktop_version",
    "url",
    "size",
    "sha512",
  ]);
  if (
    payload.channel !== "stable" ||
    !["win32/x64", "darwin/arm64"].includes(
      `${payload.platform}/${payload.arch}`,
    ) ||
    payload.platform !== context.platform ||
    payload.arch !== context.arch
  ) {
    throw new Error("Wrong release platform, architecture or channel");
  }
  if (compareVersion(payload.version, context.currentVersion) <= 0)
    throw new Error("Release is not newer");
  if (
    compareVersion(context.serverVersion, payload.min_server_version) < 0 ||
    compareVersion(payload.version, context.serverMinDesktopVersion) < 0
  ) {
    throw new Error("Incompatible release");
  }
  compareVersion(payload.min_desktop_version, "0.0.0");
  const url = new URL(payload.url);
  const loopback =
    context.allowLoopbackHttp === true &&
    url.protocol === "http:" &&
    ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !loopback) ||
    url.username ||
    url.password ||
    url.hash ||
    !Number.isSafeInteger(payload.size) ||
    payload.size <= 0
  )
    throw new Error("Invalid artifact description");
  base64(payload.sha512, 64);
  return Object.freeze(payload);
}

export function assertUpdaterDescription(release, updateInfo, resolvedFiles) {
  const file = resolvedFiles[0];
  if (
    updateInfo.version !== release.version ||
    updateInfo.packages != null ||
    resolvedFiles.length !== 1 ||
    !file ||
    file.packageInfo ||
    file.url.href !== release.url ||
    file.info.size !== release.size ||
    file.info.sha512 !== release.sha512
  ) {
    throw new Error("Updater description differs from signed release");
  }
}

export async function verifyArtifact(release, filePath) {
  const hash = createHash("sha512");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    size += chunk.length;
    hash.update(chunk);
  }
  if (size !== release.size || hash.digest("base64") !== release.sha512) {
    throw new Error("Cached artifact bytes differ from signed release");
  }
}
