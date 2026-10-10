#!/usr/bin/env node
// Vendor-only publisher; the sole customer-visible write is the last fast-forward channel commit.
import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  compareVersions,
  verifyRelease,
} from "../apps/desktop/src/main/updater/release-trust.ts";
import { RELEASE_PUBLIC_KEY_PEM } from "../apps/desktop/src/main/updater/official-source.ts";

export const targets = Object.freeze([
  ["win32-x64", "win32", "x64", ".exe"],
  ["darwin-arm64", "darwin", "arm64", ".zip"],
  ["darwin-arm64-dmg", "darwin", "arm64", ".dmg"],
  ["linux-amd64", "linux", "amd64", ".tar.gz"],
]);
const repo = "nevix.ai/nevix-releases",
  api = `https://api.cnb.cool/${repo}/-`,
  web = `https://cnb.cool/${repo}/-`;
const fields = [
  "version",
  "channel",
  "platform",
  "arch",
  "min_server_version",
  "min_desktop_version",
  "url",
  "size",
  "sha512",
];
const attested = [
  "no_paid_binding",
  "github_zero_cost_stop",
  "offline_key_restore_verified",
  "local_artifacts_retained",
  "final_platform_acceptance",
  "three_carriers_verified",
  "bridge_verified",
];
function checkAttestation(value) {
  assert.ok(
    value && attested.every((name) => value[name] === true),
    "Release prerequisites require explicit owner attestation",
  );
  const age = Date.now() - Date.parse(value.checked_at);
  assert.ok(
    Number.isFinite(age) &&
      age >= 0 &&
      age <= 24 * 60 * 60 * 1000 &&
      typeof value.evidence === "string" &&
      value.evidence.trim(),
    "Release attestation must reference fresh reviewed evidence (24 hours)",
  );
}
function envelope(bytes, key, platform, arch) {
  assert.ok(bytes.length <= 65536, "Oversized envelope");
  const value = JSON.parse(bytes);
  assert.equal(
    bytes.trim(),
    JSON.stringify({
      format: value.format,
      payload: value.payload,
      signature: value.signature,
    }),
    "Noncanonical envelope",
  );
  return verifyRelease(value, key, platform, arch);
}
async function hashFile(path) {
  const info = await lstat(path);
  assert.ok(
    info.isFile() && !info.isSymbolicLink(),
    "Artifact must be a regular file",
  );
  const h512 = createHash("sha512"),
    h256 = createHash("sha256");
  let size = 0;
  for await (const bytes of createReadStream(path)) {
    size += bytes.length;
    h512.update(bytes);
    h256.update(bytes);
  }
  assert.ok(size > 0 && Number.isSafeInteger(size), "Invalid artifact size");
  return { size, sha512: h512.digest("base64"), sha256: h256.digest("hex") };
}
async function artifacts(plan, publicKey) {
  compareVersions(plan.version, "0.0.0");
  assert.ok(publicKey, "Production release trust is not configured");
  assert.ok(
    Array.isArray(plan.artifacts) && plan.artifacts.length === 4,
    "Exactly four artifacts required",
  );
  const result = [];
  for (const [name, platform, arch, suffix] of targets) {
    const matches = plan.artifacts.filter((x) => x.name === name);
    assert.equal(matches.length, 1, "Incomplete release matrix");
    const item = matches[0],
      file = basename(item.path);
    assert.match(file, /^[A-Za-z0-9._-]+$/, "Unsafe artifact name");
    assert.ok(file.endsWith(suffix), "Wrong artifact suffix");
    const description = envelope(item.envelope, publicKey, platform, arch);
    const hashes = await hashFile(item.path);
    assert.equal(description.version, plan.version);
    assert.equal(
      description.url,
      `${web}/releases/download/v${plan.version}/${file}`,
    );
    assert.equal(description.size, hashes.size);
    assert.equal(description.sha512, hashes.sha512);
    result.push({ ...item, file, description, ...hashes });
  }
  assert.equal(
    new Set(result.map((x) => x.file)).size,
    4,
    "Duplicate asset names",
  );
  assert.equal(
    new Set(
      result.map(
        (x) =>
          `${x.description.min_server_version}/${x.description.min_desktop_version}`,
      ),
    ).size,
    1,
    "Release compatibility declarations disagree",
  );
  return result;
}

export class GitChannel {
  constructor(directory, environment = process.env) {
    this.directory = directory;
    this.environment = environment;
  }
  git(args) {
    try {
      return execFileSync("git", args, {
        cwd: this.directory,
        env: this.environment,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1024 * 1024,
      }).trim();
    } catch {
      throw new Error(
        "Release-only Git operation failed; reconcile remote main before retrying",
      );
    }
  }
  snapshot() {
    assert.equal(
      this.git(["status", "--porcelain"]),
      "",
      "Release-only checkout is dirty",
    );
    this.git(["fetch", "--no-tags", "origin", "main"]);
    const old = this.git(["rev-parse", "origin/main"]);
    this.git(["checkout", "--detach", old]);
    const tree = this.git(["ls-tree", "-r", old]);
    for (const line of tree.split("\n")) {
      const [metadata, path] = line.split("\t");
      assert.match(
        metadata,
        /^100644 blob [a-f0-9]+$/,
        "Release-only tree contains nonregular files",
      );
      assert.ok(
        path === "README.md" ||
          /^stable\/(win32-x64|darwin-arm64|darwin-arm64-dmg|linux-amd64)\.json$/.test(
            path,
          ) ||
          /^versions\/\d+\.\d+\.\d+\/(win32-x64|darwin-arm64|darwin-arm64-dmg|linux-amd64)\.json$/.test(
            path,
          ),
        "Release-only tree contains unreviewed files",
      );
    }
    const paths = new Set(tree.split("\n").map((line) => line.split("\t")[1]));
    return {
      old,
      read: (path) =>
        paths.has(path) ? this.git(["show", `${old}:${path}`]) : undefined,
    };
  }
  async advance(old, items, version, beforePush = async () => {}) {
    for (const prefix of ["stable", `versions/${version}`]) {
      await mkdir(join(this.directory, prefix), { recursive: true });
      for (const item of items) {
        const path = join(this.directory, prefix, `${item.name}.json`);
        if (prefix !== "stable") {
          assert.equal(
            await lstat(path).catch(() => undefined),
            undefined,
            "Immutable version envelope already exists",
          );
        }
        await writeFile(path, item.envelope, {
          flag: prefix === "stable" ? "w" : "wx",
        });
      }
    }
    this.git(["add", "--", "stable", `versions/${version}`]);
    this.git([
      "-c",
      "user.name=Nevix Release",
      "-c",
      "user.email=release@nevix.invalid",
      "commit",
      "-m",
      `Release v${version}`,
    ]);
    const commit = this.git(["rev-parse", "HEAD"]);
    assert.equal(
      this.git(["rev-parse", "HEAD^"]),
      old,
      "Channel commit must have exactly captured parent",
    );
    assert.equal(
      this.git(["rev-list", "--parents", "-n", "1", "HEAD"]),
      `${commit} ${old}`,
    );
    const allowed = new Set(
      items.flatMap((x) => [
        `stable/${x.name}.json`,
        `versions/${version}/${x.name}.json`,
      ]),
    );
    for (const path of this.git(["diff", "--name-only", old, commit]).split(
      "\n",
    ))
      assert.ok(allowed.has(path), "Unexpected channel change");
    await beforePush({ commit, parent: old });
    try {
      this.git(["push", "origin", `${commit}:refs/heads/main`]);
    } catch {
      const actual = this.git(["ls-remote", "origin", "refs/heads/main"]).split(
        /\s/,
      )[0];
      assert.equal(
        actual,
        commit,
        "Stable was not advanced; changed main requires a fresh complete release review",
      );
    }
    return commit;
  }
}

async function bounded(response, limit = 1024 * 1024) {
  assert.ok(response.body, "Missing response body");
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      assert.ok(size <= limit, "Oversized response");
      chunks.push(chunk);
    }
  } catch (error) {
    await response.body.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks);
}
async function checkedFetch(transport, url, options = {}, redirects = 0) {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "https:", "HTTPS required");
  assert.ok(!parsed.username && !parsed.password && !parsed.hash, "Unsafe URL");
  let response;
  try {
    response = await transport(url, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(
        options.method === "PUT" || options.artifact
          ? 30 * 60 * 1000
          : options.manifest
            ? 10000
            : 30000,
      ),
    });
  } catch {
    throw new Error(
      "Release transport failed (temporary URLs and credentials redacted)",
    );
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    assert.ok(
      !options.manifest &&
        !options.headers?.Authorization &&
        ["GET", "HEAD"].includes(options.method ?? "GET") &&
        redirects < 5,
      "Redirect refused",
    );
    const next = new URL(response.headers.get("location"), url);
    await response.body?.cancel();
    return checkedFetch(transport, next.href, options, redirects + 1);
  }
  return response;
}
export async function publishStable(
  plan,
  { publicKey, transport = fetch, channel, token, onReceipt = async () => {} },
) {
  checkAttestation(plan.attestation);
  const items = await artifacts(plan, publicKey);
  assert.equal(
    plan.attestation.version,
    plan.version,
    "Approval version does not match release",
  );
  for (const item of items)
    assert.equal(
      plan.attestation.sha512?.[item.name],
      item.sha512,
      "Approval artifact digest does not match",
    );
  assert.ok(
    typeof token === "string" && token && !/[\r\n]/.test(token),
    "Valid controlled vendor token required",
  );
  const snapshot = channel.snapshot();
  const prior = targets.map(([name, platform, arch]) => {
    const bytes = snapshot.read(`stable/${name}.json`);
    return bytes === undefined
      ? undefined
      : envelope(bytes, publicKey, platform, arch);
  });
  assert.ok(
    prior.every((x) => x === undefined) || prior.every(Boolean),
    "Incomplete prior stable channel",
  );
  if (prior[0]) {
    assert.equal(
      new Set(prior.map((x) => x.version)).size,
      1,
      "Prior stable versions disagree",
    );
    for (let i = 0; i < prior.length; i++) {
      assert.ok(
        compareVersions(plan.version, prior[i].version) > 0,
        "Older or equal job cannot advance stable",
      );
      assert.ok(
        new URL(prior[i].url).pathname.endsWith(targets[i][3]),
        "Wrong prior artifact",
      );
    }
  }
  const request = async (path, method = "GET", body, expected = 200) => {
    const response = await checkedFetch(
      transport,
      path.startsWith("https://") ? path : `${api}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.cnb.api+json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    assert.equal(response.status, expected, "CNB operation failed");
    return response;
  };
  const quota = JSON.parse(
    await bounded(
      await request("https://api.cnb.cool/nevix.ai/-/charge/quota"),
    ),
  );
  const volume = JSON.parse(
    await bounded(
      await request("https://api.cnb.cool/nevix.ai/-/charge/volume"),
    ),
  );
  const gitBytes =
    items.reduce((n, x) => n + Buffer.byteLength(x.envelope) * 2, 0) + 65536;
  for (const [kind, added] of [
    ["object_in_byte", items.reduce((n, x) => n + x.size, 0)],
    ["git_in_byte", gitBytes],
  ]) {
    assert.ok(
      Number.isSafeInteger(quota[kind]?.free) &&
        quota[kind].free >= 0 &&
        Number.isSafeInteger(volume[kind]) &&
        volume[kind] >= 0 &&
        volume[kind] + added <= quota[kind].free,
      "Whole-organization FREE quota exceeded or unknown",
    );
  }
  const tag = `v${plan.version}`;
  await request(`/git/tags/${tag}`, "GET", undefined, 404);
  await request(`/releases/tags/${tag}`, "GET", undefined, 404);
  const created = JSON.parse(
    await bounded(
      await request(
        "/releases",
        "POST",
        {
          tag_name: tag,
          target_commitish: snapshot.old,
          name: tag,
          body: `Nevix ${tag}; four reviewed binaries. Vendor source remains separate.`,
          draft: true,
          prerelease: false,
          make_latest: "false",
        },
        201,
      ),
    ),
  );
  assert.match(created.id ?? "", /^[A-Za-z0-9_-]+$/, "Invalid release ID");
  const id = created.id;
  const inspect = async (draft, complete) => {
    const value = JSON.parse(await bounded(await request(`/releases/${id}`)));
    assert.equal(value.id, id);
    assert.equal(value.tag_name, tag);
    assert.equal(value.tag_commitish, snapshot.old);
    assert.equal(value.draft, draft);
    assert.equal(value.prerelease, false);
    assert.equal(value.is_latest, false);
    assert.ok(Array.isArray(value.assets));
    assert.equal(value.assets.length, complete ? 4 : 0, "Unexpected assets");
    if (complete)
      for (const item of items) {
        const matches = value.assets.filter((x) => x.name === item.file);
        assert.equal(matches.length, 1, "Incomplete assets");
        const asset = matches[0];
        assert.equal(asset.size, item.size);
        assert.equal(asset.hash_algo.toLowerCase(), "sha256");
        assert.equal(asset.hash_value.toLowerCase(), item.sha256);
        assert.equal(
          asset.browser_download_url ?? asset.brower_download_url,
          item.description.url,
        );
      }
  };
  await inspect(true, false);
  const resolved = JSON.parse(await bounded(await request(`/git/tags/${tag}`)));
  assert.equal(resolved.name, tag);
  assert.equal(
    resolved.commit?.sha,
    snapshot.old,
    "Release tag target changed",
  );
  const receipts = [];
  for (const item of items) {
    const fresh = await hashFile(item.path);
    assert.deepEqual(
      fresh,
      { size: item.size, sha512: item.sha512, sha256: item.sha256 },
      "Artifact changed before upload",
    );
    const upload = JSON.parse(
      await bounded(
        await request(
          `/releases/${id}/asset-upload-url`,
          "POST",
          { asset_name: item.file, size: item.size, overwrite: false, ttl: 0 },
          201,
        ),
      ),
    );
    const confirmation = new URL(upload.verify_url);
    assert.equal(confirmation.origin, "https://api.cnb.cool");
    const prefix = `/${repo}/-/releases/${id}/asset-upload-confirmation/`;
    assert.ok(
      confirmation.pathname.startsWith(prefix) &&
        confirmation.pathname.slice(prefix.length).split("/").length === 2 &&
        decodeURIComponent(confirmation.pathname.split("/").at(-1)) ===
          item.file,
      "Cross-scope confirmation refused",
    );
    assert.ok(
      !confirmation.username && !confirmation.password && !confirmation.hash,
      "Unsafe confirmation URL",
    );
    assert.ok(
      Number.isFinite(upload.expires_in_sec) && upload.expires_in_sec > 0,
      "Expired upload URL",
    );
    confirmation.searchParams.set("ttl", "0");
    const response = await checkedFetch(transport, upload.upload_url, {
      method: "PUT",
      headers: {
        "Content-Length": String(item.size),
        "Content-Type": "application/octet-stream",
      },
      body: createReadStream(item.path),
      duplex: "half",
    });
    assert.ok([200, 201, 204].includes(response.status), "Asset upload failed");
    await response.body?.cancel();
    await request(confirmation.href, "POST");
    receipts.push({
      release: id,
      asset: item.file,
      size: item.size,
      sha512: item.sha512,
      ttl: 0,
      confirmation_status: 200,
    });
    await onReceipt({
      version: plan.version,
      release: id,
      stage: "permanent-confirmation",
      receipts: [...receipts],
    });
  }
  await inspect(true, true);
  checkAttestation(plan.attestation);
  await request(`/releases/${id}`, "PATCH", {
    draft: false,
    prerelease: false,
    make_latest: "false",
  });
  await inspect(false, true);
  for (const item of items) {
    const head = await checkedFetch(transport, item.description.url, {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(item.size));
    await head.body?.cancel();
    // Retry the permanent entry, never persist/reuse its temporary redirect URL.
    for (let read = 0; read < 2; read++) {
      for (let retry = 0; ; retry++) {
        try {
          const response = await checkedFetch(transport, item.description.url, {
            artifact: true,
          });
          assert.equal(response.status, 200);
          const hash = createHash("sha512");
          let size = 0;
          assert.ok(response.body);
          for await (const bytes of response.body) {
            size += bytes.length;
            assert.ok(size <= item.size, "Anonymous artifact oversized");
            hash.update(bytes);
          }
          assert.equal(size, item.size);
          assert.equal(
            hash.digest("base64"),
            item.sha512,
            "Anonymous artifact hash mismatch",
          );
          break;
        } catch (error) {
          if (error instanceof assert.AssertionError || retry === 1)
            throw error;
        }
      }
    }
    const range = await checkedFetch(transport, item.description.url, {
      headers: { Range: "bytes=0-0" },
    });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), `bytes 0-0/${item.size}`);
    assert.equal((await bounded(range, 1)).length, 1);
  }
  const finalQuota = JSON.parse(
    await bounded(
      await request("https://api.cnb.cool/nevix.ai/-/charge/quota"),
    ),
  );
  const finalVolume = JSON.parse(
    await bounded(
      await request("https://api.cnb.cool/nevix.ai/-/charge/volume"),
    ),
  );
  for (const kind of ["object_in_byte", "git_in_byte"])
    assert.ok(
      Number.isSafeInteger(finalQuota[kind]?.free) &&
        finalQuota[kind].free >= 0 &&
        Number.isSafeInteger(finalVolume[kind]) &&
        finalVolume[kind] >= 0 &&
        finalVolume[kind] + (kind === "git_in_byte" ? gitBytes : 0) <=
          finalQuota[kind].free,
      "Whole-organization FREE quota exceeded before channel publication",
    );
  checkAttestation(plan.attestation);
  // A normal FF push from captured main rejects a newer sibling publication without rewriting history.
  await onReceipt({
    version: plan.version,
    release: id,
    stage: "anonymous-artifacts-accepted",
    expected_parent: snapshot.old,
    receipts,
  });
  const commit = await channel.advance(
    snapshot.old,
    items,
    plan.version,
    async ({ commit, parent }) => {
      await onReceipt({
        version: plan.version,
        release: id,
        stage: "channel-prepared",
        commit,
        expected_parent: parent,
        receipts,
      });
    },
  );
  await onReceipt({
    version: plan.version,
    release: id,
    stage: "channel-advanced",
    commit,
    receipts,
  });
  for (const ref of [commit, "main"])
    for (const item of items) {
      const response = await checkedFetch(
        transport,
        `${web}/git/raw/${ref}/stable/${item.name}.json`,
        { headers: { Accept: "application/json" }, manifest: true },
      );
      assert.equal(response.status, 200);
      assert.equal(
        (await bounded(response, 65536)).toString(),
        item.envelope,
        "Published anonymous channel differs",
      );
    }
  return { version: plan.version, commit, receipts };
}

async function productionKey() {
  assert.ok(
    RELEASE_PUBLIC_KEY_PEM,
    "Production Ed25519 anchor is not provisioned; never use an experiment key",
  );
  const go = await readFile(
    new URL("../server/internal/release/version.go", import.meta.url),
    "utf8",
  );
  const match = go.match(/const PublicKeyPEM = (`[\s\S]*?`|"(?:[^"\\]|\\.)*")/);
  assert.ok(match, "Missing Go anchor");
  const goKey = match[1].startsWith("`")
    ? match[1].slice(1, -1)
    : JSON.parse(match[1]);
  assert.equal(
    goKey.trim(),
    RELEASE_PUBLIC_KEY_PEM.trim(),
    "Desktop/Go/operator anchors disagree",
  );
  return RELEASE_PUBLIC_KEY_PEM;
}
async function privateInput(path) {
  const info = await lstat(path);
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0,
    "Secret input must be a private regular file",
  );
  assert.ok(info.size <= 65536, "Oversized secret input");
  return readFile(path, "utf8");
}
async function main() {
  const [command, path] = process.argv.slice(2);
  assert.ok(
    ["identity", "prepare", "publish"].includes(command) &&
      path &&
      process.argv.length === 4,
    "usage: publish-stable.mjs identity|prepare|publish PRIVATE-INPUT.json",
  );
  const input = JSON.parse(await privateInput(resolve(path)));
  const publicKey = await productionKey();
  if (command === "identity") {
    const desktop = JSON.parse(
      await readFile(
        new URL("../apps/desktop/package.json", import.meta.url),
        "utf8",
      ),
    );
    compareVersions(input.version, "0.0.0");
    assert.equal(
      desktop.version,
      input.version,
      "Tag and Desktop version disagree",
    );
    assert.equal(
      process.env.GITHUB_REF,
      `refs/tags/v${input.version}`,
      "Only an exact stable tag may build a release",
    );
    console.log("Stable identity and compiled anchors verified.");
    return;
  }
  if (command === "prepare") {
    compareVersions(input.version, "0.0.0");
    compareVersions(input.min_server_version, "0.0.0");
    compareVersions(input.min_desktop_version, "0.0.0");
    const encryptedKey = await privateInput(input.private_key_file);
    assert.ok(
      encryptedKey.startsWith("-----BEGIN ENCRYPTED PRIVATE KEY-----"),
      "Use encrypted PKCS#8 signing material",
    );
    const key = createPrivateKey({
      key: encryptedKey,
      passphrase: process.env.NEVIX_RELEASE_KEY_PASSPHRASE,
    });
    assert.equal(key.asymmetricKeyType, "ed25519");
    assert.equal(
      createPublicKey(key)
        .export({ type: "spki", format: "pem" })
        .toString()
        .trim(),
      publicKey.trim(),
      "Private key does not match compiled trust",
    );
    const plan = {
      version: input.version,
      artifacts: [],
      attestation: input.attestation,
    };
    for (const [name, platform, arch] of targets) {
      const artifactPath = input.artifacts[name],
        hashes = await hashFile(artifactPath);
      const payload = {
        version: input.version,
        channel: "stable",
        platform,
        arch,
        min_server_version: input.min_server_version,
        min_desktop_version: input.min_desktop_version,
        url: `${web}/releases/download/v${input.version}/${basename(artifactPath)}`,
        size: hashes.size,
        sha512: hashes.sha512,
      };
      assert.deepEqual(Object.keys(payload), fields);
      const bytes = Buffer.from(JSON.stringify(payload));
      plan.artifacts.push({
        name,
        path: artifactPath,
        envelope: JSON.stringify({
          format: "nevix-release-v1",
          payload: bytes.toString("base64"),
          signature: sign(null, bytes, key).toString("base64"),
        }),
      });
    }
    await artifacts(plan, publicKey);
    await mkdir(input.output_directory, { mode: 0o700 });
    await writeFile(
      join(input.output_directory, "plan.json"),
      JSON.stringify(plan),
      { flag: "wx", mode: 0o600 },
    );
    for (const item of plan.artifacts)
      await writeFile(
        join(input.output_directory, `${item.name}.json`),
        item.envelope,
        { flag: "wx", mode: 0o600 },
      );
    console.log(
      "Prepared four signed envelopes; no remote writes. Retain exact local artifacts and plan.",
    );
    return;
  }
  checkAttestation(input.attestation);
  const token = process.env.NEVIX_CNB_TOKEN;
  assert.ok(token, "Missing controlled vendor CNB token");
  const directory = await mkdtemp(join(tmpdir(), "nevix-release-only-"));
  const checkout = join(directory, "channel");
  try {
    const askpass = join(directory, "askpass.cjs");
    await writeFile(
      askpass,
      '#!/usr/bin/env node\nprocess.stdout.write(process.argv[2]?.includes("Username") ? "cnb\\n" : process.env.NEVIX_CNB_TOKEN+"\\n")\n',
      { mode: 0o700 },
    );
    const environment = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !name.startsWith("GIT_"),
        ),
      ),
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TRACE: "0",
      GIT_TRACE_CURL: "0",
      GIT_CURL_VERBOSE: "0",
    };
    try {
      execFileSync(
        "git",
        [
          "clone",
          "--single-branch",
          "--branch",
          "main",
          "--no-tags",
          `https://cnb.cool/${repo}.git`,
          checkout,
        ],
        { env: environment, stdio: "pipe" },
      );
    } catch {
      throw new Error("Release-only clone failed (credentials redacted)");
    }
    const journal = resolve(path) + ".journal.jsonl";
    const handle = await (
      await import("node:fs/promises")
    ).open(journal, "wx", 0o600);
    let result;
    try {
      result = await publishStable(input, {
        publicKey,
        channel: new GitChannel(checkout, environment),
        token,
        onReceipt: async (value) => {
          await handle.write(JSON.stringify(value) + "\n");
          await handle.sync();
        },
      });
    } finally {
      await handle.close();
    }
    await writeFile(
      resolve(path) + ".receipt.json",
      JSON.stringify(result, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      `Published ${result.version} at ${result.commit}; redacted receipt retained beside plan.`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main().catch(() => {
    console.error(
      !RELEASE_PUBLIC_KEY_PEM
        ? "Release trust is not provisioned. Configure reviewed identical Desktop/Go/operator Ed25519 public anchors before any formal release."
        : "Release stopped. Stable is unchanged before final push; after an ambiguous push, reconcile exact remote commit and redacted receipts before retrying. Never overwrite or delete to recover.",
    );
    process.exitCode = 1;
  });
