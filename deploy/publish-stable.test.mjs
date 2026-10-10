import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  prepareStable,
  publishStable,
  GitChannel,
  targets,
} from "./publish-stable.mjs";

const git = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "nevix-publish-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote = join(dir, "remote.git"),
    channelDir = join(dir, "channel");
  git(dir, ["init", "--bare", "--initial-branch=main", remote]);
  git(dir, ["clone", remote, channelDir]);
  git(channelDir, ["config", "user.email", "test@example.invalid"]);
  git(channelDir, ["config", "user.name", "Release test"]);
  await writeFile(
    join(channelDir, "README.md"),
    "Public release assets only\n",
  );
  git(channelDir, ["add", "."]);
  git(channelDir, ["commit", "-m", "Initialize"]);
  git(channelDir, ["push", "origin", "main"]);
  const old = git(remote, ["rev-parse", "main"]);
  const key = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  const artifacts = [];
  for (const [name, platform, arch, suffix] of targets) {
    const path = join(dir, `Nevix-1.2.3${suffix}`),
      bytes = Buffer.from(`actual ${name} artifact`);
    await writeFile(path, bytes);
    const payload = {
      version: "1.2.3",
      channel: "stable",
      platform,
      arch,
      min_server_version: platform === "linux" ? "0.1.0" : "1.0.0",
      min_desktop_version: "1.0.0",
      url: `https://cnb.cool/nevix.ai/nevix-releases/-/releases/download/v1.2.3/${path.split("/").at(-1)}`,
      size: bytes.length,
      sha512: createHash("sha512").update(bytes).digest("base64"),
    };
    const data = Buffer.from(JSON.stringify(payload));
    artifacts.push({
      name,
      path,
      envelope: JSON.stringify({
        format: "nevix-release-v1",
        payload: data.toString("base64"),
        signature: sign(null, data, key.privateKey).toString("base64"),
      }),
    });
  }
  const plan = {
    version: "1.2.3",
    artifacts,
    attestation: {
      version: "1.2.3",
      sha512: Object.fromEntries(
        artifacts.map((x) => [
          x.name,
          JSON.parse(Buffer.from(JSON.parse(x.envelope).payload, "base64"))
            .sha512,
        ]),
      ),
      checked_at: new Date().toISOString(),
      no_paid_binding: true,
      github_zero_cost_stop: true,
      offline_key_restore_verified: true,
      local_artifacts_retained: true,
      final_platform_acceptance: true,
      three_carriers_verified: true,
      bridge_verified: true,
      evidence: "reviewed release record",
    },
  };
  const calls = [],
    uploaded = [],
    releases = {};
  let failAt = "",
    beforeAnonymous;
  const transport = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const body =
      options.body && typeof options.body === "string"
        ? JSON.parse(options.body)
        : undefined;
    calls.push({ url, method, body, headers: options.headers });
    const path = new URL(url).pathname;
    if (failAt && `${method} ${path}`.includes(failAt))
      throw new Error("Injected transport failure");
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), { status });
    if (path.endsWith("/charge/quota"))
      return json({
        object_in_byte: { free: 100000, total: 999999 },
        git_in_byte: { free: 100000, total: 999999 },
      });
    if (path.endsWith("/charge/volume"))
      return json({ object_in_byte: 0, git_in_byte: 0 });
    if (
      (path.includes("/git/tags/") && !releases.id) ||
      path.includes("/releases/tags/")
    )
      return json({}, 404);
    if (method === "POST" && path.endsWith("/releases")) {
      Object.assign(releases, {
        id: "r1",
        tag_name: "v1.2.3",
        tag_commitish: old,
        draft: true,
        prerelease: false,
        is_latest: false,
        assets: [],
      });
      assert.equal(body.target_commitish, old);
      assert.equal(body.make_latest, "false");
      return json(releases, 201);
    }
    if (path.includes("/git/tags/"))
      return json({ name: "v1.2.3", commit: { sha: old } });
    if (path.endsWith("/asset-upload-url")) {
      assert.equal(body.overwrite, false);
      assert.equal(body.ttl, 0);
      return json(
        {
          upload_url: `https://asset.cnb.cool/${body.asset_name}`,
          verify_url: `https://api.cnb.cool/nevix.ai/nevix-releases/-/releases/r1/asset-upload-confirmation/token/${body.asset_name}`,
          expires_in_sec: 60,
        },
        201,
      );
    }
    if (method === "PUT") {
      assert.equal(options.headers.Authorization, undefined);
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      uploaded.push({ name: path.slice(1), bytes: Buffer.concat(chunks) });
      return new Response("", { status: 200 });
    }
    if (path.includes("/asset-upload-confirmation/")) {
      assert.equal(new URL(url).searchParams.get("ttl"), "0");
      const file = uploaded.at(-1);
      releases.assets.push({
        id: `a${uploaded.length}`,
        name: file.name,
        size: file.bytes.length,
        hash_algo: "sha256",
        hash_value: createHash("sha256").update(file.bytes).digest("hex"),
        browser_download_url: `https://cnb.cool/nevix.ai/nevix-releases/-/releases/download/v1.2.3/${file.name}`,
      });
      return new Response("", { status: 200 });
    }
    if (method === "PATCH") {
      assert.equal(body.make_latest, "false");
      releases.draft = false;
      return json({});
    }
    if (
      url.startsWith("https://cnb.cool/") &&
      path.includes("/releases/download/")
    ) {
      beforeAnonymous?.();
      beforeAnonymous = undefined;
      assert.equal(releases.draft, false);
      const file = uploaded.find((x) => x.name === path.split("/").at(-1));
      if (method === "HEAD")
        return new Response(null, {
          headers: { "content-length": String(file.bytes.length) },
        });
      if (options.headers?.Range)
        return new Response(file.bytes.subarray(0, 1), {
          status: 206,
          headers: { "content-range": `bytes 0-0/${file.bytes.length}` },
        });
      return new Response(file.bytes, { status: 200 });
    }
    if (path.includes("/git/raw/")) {
      const match = path.match(/\/git\/raw\/([^/]+)\/(.*)$/);
      return new Response(
        execFileSync("git", ["show", `${match[1]}:${match[2]}`], {
          cwd: remote,
        }),
      );
    }
    if (path.endsWith("/releases/r1")) return json(releases);
    throw new Error(`Unexpected test request ${method} ${path}`);
  };
  const channel = new GitChannel(channelDir);
  return {
    plan,
    publicKey,
    signingKey: key.privateKey,
    transport,
    channel,
    calls,
    remote,
    old,
    channelDir,
    dir,
    setFail: (value) => {
      failAt = value;
    },
    setRace: (value) => {
      beforeAnonymous = value;
    },
  };
}

test("publisher accepts independent Linux source minimum and advances stable only after permanent anonymous acceptance", async (t) => {
  const f = await fixture(t);
  const result = await publishStable(f.plan, {
    publicKey: f.publicKey,
    transport: f.transport,
    channel: f.channel,
    token: "vendor-only",
  });
  assert.equal(git(f.remote, ["rev-list", "--count", "main"]), "2");
  assert.equal(git(f.remote, ["rev-parse", "main^"]), f.old);
  assert.equal(result.commit, git(f.remote, ["rev-parse", "main"]));
  for (const artifact of f.plan.artifacts)
    assert.equal(
      git(f.remote, ["show", `main:stable/${artifact.name}.json`]),
      artifact.envelope,
    );
  assert.equal(f.calls.filter((x) => x.method === "PUT").length, 4);
});

for (const [target, field, expected] of [
  ["linux-amd64", "min_desktop_version", /minimum Desktop/],
  ["darwin-arm64-dmg", "min_desktop_version", /minimum Desktop/],
  ["darwin-arm64", "min_server_version", /minimum Server/],
]) {
  test(`inconsistent ${target} ${field} stops before external writes`, async (t) => {
    const f = await fixture(t);
    const artifact = f.plan.artifacts.find((x) => x.name === target);
    const value = JSON.parse(artifact.envelope);
    const payload = JSON.parse(Buffer.from(value.payload, "base64"));
    payload[field] = "0.2.0";
    const bytes = Buffer.from(JSON.stringify(payload));
    artifact.envelope = JSON.stringify({
      format: value.format,
      payload: bytes.toString("base64"),
      signature: sign(null, bytes, f.signingKey).toString("base64"),
    });
    await assert.rejects(
      publishStable(f.plan, {
        publicKey: f.publicKey,
        transport: f.transport,
        channel: f.channel,
        token: "vendor",
      }),
      expected,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(git(f.remote, ["rev-parse", "main"]), f.old);
  });
}

test("prepare signs independent Linux source minimum and rejects missing or invalid source before writes", async (t) => {
  const f = await fixture(t);
  const passphrase = "ephemeral fixture password";
  const privateKeyFile = join(f.dir, "fixture.pem"),
    output = join(f.dir, "signed");
  await writeFile(
    privateKeyFile,
    f.signingKey.export({
      format: "pem",
      type: "pkcs8",
      cipher: "aes-256-cbc",
      passphrase,
    }),
    { mode: 0o600 },
  );
  const input = {
    version: "1.2.3",
    min_server_version: "1.0.0",
    min_source_server_version: "0.1.0",
    min_desktop_version: "1.0.0",
    private_key_file: privateKeyFile,
    artifacts: Object.fromEntries(
      f.plan.artifacts.map((x) => [x.name, x.path]),
    ),
    output_directory: output,
  };
  for (const minimum of [
    undefined,
    "development",
    "01.0.0",
    "2147483648.0.0",
  ]) {
    await assert.rejects(
      prepareStable(
        { ...input, min_source_server_version: minimum },
        { publicKey: f.publicKey, passphrase },
      ),
      /Unknown stable version|Invalid stable version/,
    );
    await assert.rejects(readFile(join(output, "plan.json")), {
      code: "ENOENT",
    });
  }
  await prepareStable(input, { publicKey: f.publicKey, passphrase });
  const plan = JSON.parse(await readFile(join(output, "plan.json"), "utf8"));
  for (const artifact of plan.artifacts) {
    assert.equal(
      artifact.envelope,
      f.plan.artifacts.find((x) => x.name === artifact.name).envelope,
    );
    assert.equal(
      await readFile(join(output, `${artifact.name}.json`), "utf8"),
      artifact.envelope,
    );
  }
  plan.attestation = f.plan.attestation;
  await publishStable(plan, {
    publicKey: f.publicKey,
    transport: f.transport,
    channel: f.channel,
    token: "vendor",
  });
});

test("owner-approved offline restore skip is recorded without claiming verification", async (t) => {
  const f = await fixture(t);
  f.plan.attestation.offline_key_restore_verified = false;
  f.plan.attestation.offline_key_restore_skipped_by_owner = true;
  const result = await publishStable(f.plan, {
    publicKey: f.publicKey,
    transport: f.transport,
    channel: f.channel,
    token: "vendor-only",
  });
  assert.equal(result.commit, git(f.remote, ["rev-parse", "main"]));
  assert.equal(f.plan.attestation.offline_key_restore_verified, false);
});

test("missing, malformed or contradictory restore decisions stop before external writes", async (t) => {
  const f = await fixture(t);
  for (const [verified, skipped] of [
    [false, undefined],
    [undefined, true],
    ["true", undefined],
    [false, "true"],
    [true, true],
    [true, "false"],
  ]) {
    f.plan.attestation.offline_key_restore_verified = verified;
    f.plan.attestation.offline_key_restore_skipped_by_owner = skipped;
    await assert.rejects(
      publishStable(f.plan, {
        publicKey: f.publicKey,
        transport: f.transport,
        channel: f.channel,
        token: "vendor-only",
      }),
      /Offline key restore/,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(git(f.remote, ["rev-parse", "main"]), f.old);
  }
});

test("post-publication raw redirects are refused and require exact commit reconciliation", async (t) => {
  const f = await fixture(t);
  const transport = async (url, options) =>
    url.includes("/git/raw/")
      ? new Response(null, {
          status: 302,
          headers: { location: "https://cnb.cool/unreviewed" },
        })
      : f.transport(url, options);
  await assert.rejects(
    publishStable(f.plan, {
      publicKey: f.publicKey,
      transport,
      channel: f.channel,
      token: "vendor",
    }),
    /Redirect refused/,
  );
});

for (const point of [
  "GET /nevix.ai/-/charge/quota",
  "POST /nevix.ai/nevix-releases/-/releases",
  "asset-upload-url",
  "PUT /Nevix",
  "asset-upload-confirmation",
  "PATCH /nevix.ai/nevix-releases/-/releases/r1",
  "HEAD /nevix.ai/nevix-releases/-/releases/download/",
]) {
  test(`failure at ${point} preserves old customer channel`, async (t) => {
    const f = await fixture(t);
    f.setFail(point);
    await assert.rejects(
      publishStable(f.plan, {
        publicKey: f.publicKey,
        transport: f.transport,
        channel: f.channel,
        token: "vendor",
      }),
    );
    assert.equal(git(f.remote, ["rev-parse", "main"]), f.old);
  });
}
test("an older concurrent job cannot replace a newer sibling channel", async (t) => {
  const f = await fixture(t),
    other = join(f.dir, "other");
  git(f.dir, ["clone", f.remote, other]);
  git(other, ["config", "user.name", "Newer job"]);
  git(other, ["config", "user.email", "other@example.invalid"]);
  let newer;
  f.setRace(() => {
    execFileSync(
      "git",
      ["commit", "--allow-empty", "-m", "Newer published release"],
      { cwd: other, stdio: "pipe" },
    );
    git(other, ["push", "origin", "main"]);
    newer = git(f.remote, ["rev-parse", "main"]);
  });
  await assert.rejects(
    publishStable(f.plan, {
      publicKey: f.publicKey,
      transport: f.transport,
      channel: f.channel,
      token: "vendor",
    }),
    /changed main/,
  );
  assert.equal(git(f.remote, ["rev-parse", "main"]), newer);
});
test("same version replay and malformed prior signed channel stop before draft creation", async (t) => {
  const f = await fixture(t);
  await publishStable(f.plan, {
    publicKey: f.publicKey,
    transport: f.transport,
    channel: f.channel,
    token: "vendor",
  });
  const current = git(f.remote, ["rev-parse", "main"]);
  f.calls.length = 0;
  await assert.rejects(
    publishStable(f.plan, {
      publicKey: f.publicKey,
      transport: f.transport,
      channel: f.channel,
      token: "vendor",
    }),
    /Older or equal/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(git(f.remote, ["rev-parse", "main"]), current);
  await writeFile(join(f.channelDir, "stable/win32-x64.json"), "untrusted");
  git(f.channelDir, ["add", "."]);
  git(f.channelDir, ["commit", "-m", "Corrupt channel"]);
  git(f.channelDir, ["push", "origin", "HEAD:main"]);
  f.plan.version = "1.2.4";
  await assert.rejects(
    publishStable(f.plan, {
      publicKey: f.publicKey,
      transport: f.transport,
      channel: f.channel,
      token: "vendor",
    }),
  );
  assert.equal(f.calls.length, 0);
});
test("whole organization promotional total cannot replace insufficient FREE quota", async (t) => {
  const f = await fixture(t);
  const transport = async (url, options) =>
    url.endsWith("/charge/quota")
      ? new Response(
          JSON.stringify({
            object_in_byte: { free: 1, total: 999999 },
            git_in_byte: { free: 100000, total: 999999 },
          }),
        )
      : f.transport(url, options);
  await assert.rejects(
    publishStable(f.plan, {
      publicKey: f.publicKey,
      transport,
      channel: f.channel,
      token: "vendor",
    }),
    /FREE quota/,
  );
  assert.equal(git(f.remote, ["rev-parse", "main"]), f.old);
  assert.equal(f.calls.filter((x) => x.method === "POST").length, 0);
});
test("anonymous altered bytes after formalization never move stable", async (t) => {
  const f = await fixture(t);
  const transport = async (url, options) =>
    url.includes("/releases/download/") &&
    (options?.method ?? "GET") === "GET" &&
    !options.headers?.Range
      ? new Response("tampered")
      : f.transport(url, options);
  await assert.rejects(
    publishStable(f.plan, {
      publicKey: f.publicKey,
      transport,
      channel: f.channel,
      token: "vendor",
    }),
    /hash mismatch|size|equal/,
  );
  assert.equal(git(f.remote, ["rev-parse", "main"]), f.old);
});
test("missing formal anchor, wrong signed platform, missing gates and unreviewed public files stop without API writes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    publishStable(f.plan, {
      publicKey: "",
      transport: f.transport,
      channel: f.channel,
      token: "vendor",
    }),
    /trust/,
  );
  const original = f.plan.attestation;
  f.plan.attestation = { ...original, no_paid_binding: false };
  await assert.rejects(
    publishStable(f.plan, {
      publicKey: f.publicKey,
      transport: f.transport,
      channel: f.channel,
      token: "vendor",
    }),
    /attestation/,
  );
  f.plan.attestation = original;
  const item = f.plan.artifacts[0],
    originalEnvelope = item.envelope;
  item.envelope = f.plan.artifacts[1].envelope;
  await assert.rejects(
    publishStable(f.plan, {
      publicKey: f.publicKey,
      transport: f.transport,
      channel: f.channel,
      token: "vendor",
    }),
    /target/,
  );
  item.envelope = originalEnvelope;
  await writeFile(join(f.channelDir, "source.go"), "never distribute source");
  git(f.channelDir, ["add", "."]);
  git(f.channelDir, ["commit", "-m", "Unreviewed source"]);
  git(f.channelDir, ["push", "origin", "main"]);
  await assert.rejects(
    publishStable(f.plan, {
      publicKey: f.publicKey,
      transport: f.transport,
      channel: f.channel,
      token: "vendor",
    }),
    /unreviewed/,
  );
  assert.equal(f.calls.length, 0);
});

test("approval from another release cannot authorize reviewed artifacts", async (t) => {
  const f = await fixture(t);
  f.plan.attestation.version = "9.9.9";
  await assert.rejects(
    publishStable(f.plan, {
      publicKey: f.publicKey,
      transport: f.transport,
      channel: f.channel,
      token: "vendor",
    }),
    /Approval version/,
  );
  assert.equal(f.calls.length, 0);
});

test("an isolated trusted bridge keeps the old entry usable while a migrated client reads the new source", async (t) => {
  const { verifyRelease } =
    await import("../apps/desktop/src/main/updater/release-trust.ts");
  const f = await fixture(t),
    bridge = f.plan.artifacts[0];
  const oldSource = new Map([["stable/win32-x64.json", bridge.envelope]]);
  const privateKey = generateKeyPairSync("ed25519");
  // Each source must carry a release signed by the client's compiled key; source movement grants no trust.
  const oldRead = verifyRelease(
    JSON.parse(oldSource.get("stable/win32-x64.json")),
    f.publicKey,
    "win32",
    "x64",
  );
  assert.equal(oldRead.version, "1.2.3");
  const payload = {
    ...oldRead,
    version: "1.2.4",
    url: "https://new-source.example.invalid/Nevix-1.2.4.exe",
  };
  const data = Buffer.from(JSON.stringify(payload));
  const newSource = new Map([
    [
      "stable/win32-x64.json",
      JSON.stringify({
        format: "nevix-release-v1",
        payload: data.toString("base64"),
        signature: sign(null, data, f.signingKey).toString("base64"),
      }),
    ],
  ]);
  assert.equal(
    verifyRelease(
      JSON.parse(newSource.get("stable/win32-x64.json")),
      f.publicKey,
      "win32",
      "x64",
    ).version,
    "1.2.4",
  );
  const bad = {
    format: "nevix-release-v1",
    payload: data.toString("base64"),
    signature: sign(null, data, privateKey.privateKey).toString("base64"),
  };
  await assert.rejects(
    async () => verifyRelease(bad, f.publicKey, "win32", "x64"),
    /signature/,
  );
  assert.equal(
    verifyRelease(
      JSON.parse(oldSource.get("stable/win32-x64.json")),
      f.publicKey,
      "win32",
      "x64",
    ).version,
    "1.2.3",
  );
});

test("public-source delivery builds stable tags but cannot automatically publish or access publication secrets", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/stable-release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /push:\s*tags: \[["']v\*["']\]/);
  assert.doesNotMatch(
    workflow,
    /workflow_dispatch|branches:|self-hosted|secrets\.|NEVIX_MAC_SIGNING|NEVIX_RELEASE_PRIVATE_KEY|NEVIX_RELEASE_KEY_PASSPHRASE|NEVIX_CNB_TOKEN|publish-stable\.mjs (?:prepare|publish)|environment:|\n  (?:mac|sign|publish):/,
  );
  for (const job of ["windows", "server"]) {
    const section = workflow
      .split(`\n  ${job}:\n`)[1]
      ?.split(/\n  [a-z-]+:\n/)[0];
    assert.ok(section, `Missing ${job} job`);
    assert.match(section, /runs-on: (?:windows|ubuntu)-latest/);
    const needs =
      section
        .match(/needs:\s*\[([^\]]+)\]/)?.[1]
        .split(",")
        .map((x) => x.trim()) ?? [];
    for (const gate of [
      "identity",
      "harness",
      "desktop-checks",
      "server-checks",
    ]) {
      assert.ok(
        needs.includes(gate),
        `${job} must await ${gate} at the release SHA`,
      );
    }
  }
  assert.match(workflow, /uses: \.\/\.github\/workflows\/desktop-ci\.yml/);
  assert.match(workflow, /windows_native: true/);
  assert.match(workflow, /macos_native: true/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/server-ci\.yml/);
  assert.match(workflow, /run: make harness-test/);
  assert.match(workflow, /docker-29\.4\.0\.tgz/);
  assert.match(workflow, /containerd-snapshotter.*true/);
  const checkouts = workflow.match(/uses: actions\/checkout@v6/g) ?? [];
  assert.equal(
    (workflow.match(/ref: \$\{\{ github\.sha \}\}/g) ?? []).length,
    checkouts.length,
  );
  assert.match(workflow, /electron-builder --win nsis --x64 --publish never/);
  assert.match(
    workflow,
    /MIN_SOURCE_SERVER_VERSION:.*vars\.NEVIX_MIN_SOURCE_SERVER_VERSION/,
  );
  assert.match(
    workflow,
    /build-bundle\.sh "\$VERSION" "\$MIN_DESKTOP_VERSION" "\$MIN_SOURCE_SERVER_VERSION"/,
  );
  assert.doesNotMatch(
    workflow,
    /path:.*(?:signing-key|private_key|signing-input)/,
  );
});

test("public-source stable identity accepts a matching tag but refuses branches and version mismatches", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nevix-public-identity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const desktop = JSON.parse(
    await readFile(
      new URL("../apps/desktop/package.json", import.meta.url),
      "utf8",
    ),
  );
  const input = join(dir, "identity.json");
  await writeFile(input, JSON.stringify({ version: desktop.version }), {
    mode: 0o600,
  });
  const args = [
    "--experimental-strip-types",
    fileURLToPath(new URL("./publish-stable.mjs", import.meta.url)),
    "identity",
    input,
  ];
  const env = {
    ...process.env,
    GITHUB_REF: `refs/tags/v${desktop.version}`,
    GITHUB_REPOSITORY_PRIVATE: "false",
  };
  assert.match(
    execFileSync(process.execPath, args, {
      env,
      encoding: "utf8",
      stdio: "pipe",
    }),
    /Stable identity and compiled anchors verified/,
  );
  assert.throws(() =>
    execFileSync(process.execPath, args, {
      env: { ...env, GITHUB_REF: "refs/heads/main" },
      stdio: "pipe",
    }),
  );
  await writeFile(input, JSON.stringify({ version: "99.0.0" }));
  assert.throws(() =>
    execFileSync(process.execPath, args, {
      env: { ...env, GITHUB_REF: "refs/tags/v99.0.0" },
      stdio: "pipe",
    }),
  );
  await writeFile(input, JSON.stringify({ version: desktop.version }));
  await chmod(input, 0o644);
  assert.throws(() =>
    execFileSync(process.execPath, args, { env, stdio: "pipe" }),
  );
});

test("a transient anonymous transport failure retries the permanent entry without credentials", async (t) => {
  const f = await fixture(t);
  let interrupted = false,
    retryURL;
  const transport = async (url, options) => {
    if (
      url.includes("/releases/download/") &&
      (options?.method ?? "GET") === "GET" &&
      !options.headers?.Range &&
      !interrupted
    ) {
      interrupted = true;
      retryURL = url;
      throw new Error("Network disconnected");
    }
    if (interrupted && url === retryURL)
      assert.equal(options?.headers?.Authorization, undefined);
    return f.transport(url, options);
  };
  await publishStable(f.plan, {
    publicKey: f.publicKey,
    transport,
    channel: f.channel,
    token: "vendor",
  });
  assert.equal(interrupted, true);
});

for (const mutation of [
  "expired upload",
  "cross-scope confirmation",
  "missing permanent confirmation",
  "unexpected final asset",
  "remote digest mismatch",
]) {
  test(`${mutation} stops before channel publication`, async (t) => {
    const f = await fixture(t);
    const transport = async (url, options) => {
      const response = await f.transport(url, options);
      if (url.endsWith("/asset-upload-url")) {
        const data = await response.json();
        if (mutation === "expired upload") data.expires_in_sec = 0;
        if (mutation === "cross-scope confirmation")
          data.verify_url = data.verify_url.replace(
            "/releases/r1/",
            "/releases/another/",
          );
        return new Response(JSON.stringify(data), { status: 201 });
      }
      if (
        url.includes("/asset-upload-confirmation/") &&
        mutation === "missing permanent confirmation"
      )
        return new Response(null, { status: 500 });
      if (
        url.endsWith("/releases/r1") &&
        (options?.method ?? "GET") === "GET"
      ) {
        const data = await response.json();
        if (data.assets.length === 4 && mutation === "unexpected final asset")
          data.assets.push({ ...data.assets[0], name: "source.tar.gz" });
        if (data.assets.length === 4 && mutation === "remote digest mismatch")
          data.assets[0].hash_value = "00".repeat(32);
        return new Response(JSON.stringify(data));
      }
      return response;
    };
    await assert.rejects(
      publishStable(f.plan, {
        publicKey: f.publicKey,
        transport,
        channel: f.channel,
        token: "vendor",
      }),
    );
    assert.equal(git(f.remote, ["rev-parse", "main"]), f.old);
    assert.equal(
      f.calls.some((x) => x.method === "PATCH"),
      false,
    );
  });
}
