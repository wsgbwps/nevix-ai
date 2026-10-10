import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import {
  feedURL,
  urlMap,
  mainSetup,
  Inspector,
  resumeVerifiedBoot,
  packagedMainURLPattern,
} from "./installed-desktop-controller.mjs";

const artifact =
  "https://cnb.cool/nevix.ai/nevix-releases/-/releases/download/v1.0.1/Nevix-AI-1.0.1-arm64.zip";
assert.ok(
  packagedMainURLPattern.test(
    "file:///Applications/Nevix AI.app/Contents/Resources/app.asar/out/main/index.js",
  ),
);
assert.ok(
  packagedMainURLPattern.test(
    "C:\\installed\\resources\\app.asar\\out\\main\\index.js",
  ),
);
assert.ok(
  !packagedMainURLPattern.test("file:///app.asar/out/main/not-index.js"),
);
const mapping = urlMap(artifact, "http://127.0.0.1:23456");
assert.equal(
  urlMap(artifact, "http://127.0.0.1:23456", "win32-x64")[0][0],
  feedURL.replace("darwin-arm64", "win32-x64"),
);
assert.throws(() => urlMap(artifact, "http://127.0.0.1:23456", "linux-amd64"));
assert.throws(() => urlMap(artifact, "http://example.com:23456"));
assert.throws(() => urlMap(artifact, "https://127.0.0.1:23456"));
assert.throws(() =>
  urlMap("http://cnb.cool/file.zip", "http://127.0.0.1:23456"),
);
assert.throws(() =>
  urlMap("https://user:password@cnb.cool/file.zip", "http://127.0.0.1:23456"),
);
const forwarded = [];
const electron = {
  app: {
    isReady: () => false,
    getPath: () => "/reviewed/profile",
    getVersion: () => "0.1.0",
    isPackaged: true,
  },
  dialog: { showMessageBox: async () => "original dialog" },
};
const sandbox = {
  require: () => electron,
  URL,
  Request,
  process: { execPath: "/reviewed/app", pid: 123 },
  fetch: async (...args) => {
    forwarded.push(args);
    return "original transport";
  },
};
const boot = runInNewContext(mainSetup(mapping, "/reviewed/profile"), sandbox);
assert.equal(boot.version, "0.1.0");
const options = { redirect: "error", headers: { Accept: "application/json" } };
for (const url of [
  feedURL,
  artifact,
  `${feedURL}?extra=1`,
  `${artifact}?extra=1`,
  "https://customer.example.test/release/version",
  "http://127.0.0.1:56789/squirrel.json",
]) {
  assert.equal(await sandbox.fetch(url, options), "original transport");
}
assert.deepEqual(
  forwarded.map(([url]) => url),
  [
    mapping[0][1],
    mapping[1][1],
    `${feedURL}?extra=1`,
    `${artifact}?extra=1`,
    "https://customer.example.test/release/version",
    "http://127.0.0.1:56789/squirrel.json",
  ],
);
assert.ok(forwarded.every(([, value]) => value === options));
assert.equal(
  await electron.dialog.showMessageBox({
    title: "Trust unrelated certificate",
    buttons: ["Trust", "Cancel"],
  }),
  "original dialog",
);
assert.equal(
  await electron.dialog.showMessageBox({
    title: "Unrelated dialog",
    buttons: ["Install and Restart", "Later"],
  }),
  "original dialog",
);
const heldConfirmation = electron.dialog.showMessageBox({
  title: "Nevix AI Updates",
  buttons: ["Install and Restart", "Later"],
});
assert.equal(sandbox.__349Probe.offers, 1);
sandbox.__349Probe.resolve({ response: 1, checkboxChecked: false });
assert.equal((await heldConfirmation).response, 1);
assert.throws(
  () => sandbox.fetch(new Request(artifact)),
  /Unexpected mapped Request/,
);
electron.app.isReady = () => true;
assert.throws(
  () => runInNewContext(mainSetup(mapping, "/reviewed/profile"), sandbox),
  /Missed pre-main/,
);
electron.app.isReady = () => false;
assert.throws(
  () => runInNewContext(mainSetup(mapping, "/wrong/profile"), sandbox),
  /Unexpected default profile/,
);

class FakeSocket extends EventTarget {
  send(bytes) {
    const { id } = JSON.parse(bytes);
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ id, result: { acknowledged: true } }),
      }),
    );
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
}
const socket = new FakeSocket(),
  inspector = new Inspector(socket);
// Paused can arrive before the send acknowledgement or before a waiter attaches.
socket.dispatchEvent(
  new MessageEvent("message", {
    data: JSON.stringify({
      method: "Debugger.paused",
      params: { reason: "already buffered" },
    }),
  }),
);
assert.deepEqual(await inspector.send("Debugger.enable"), {
  acknowledged: true,
});
assert.deepEqual(await inspector.event("Debugger.paused"), {
  reason: "already buffered",
});
await assert.rejects(inspector.event("Debugger.paused", 1), /event timeout/);
socket.close();
await assert.rejects(inspector.send("Debugger.resume"), /already closed/);
await assert.rejects(
  inspector.event("Debugger.paused"),
  /closed before expected/,
);
const order = [],
  guardedInspector = {
    send: async (method) => {
      order.push(method);
    },
  };
const verified = {
  packaged: true,
  executable: "/reviewed/app",
  profile: "/reviewed/profile",
};
for (const mismatch of [
  { ...verified, profile: "/unreviewed/profile" },
  { ...verified, packaged: false },
  { ...verified, executable: "/unreviewed/app" },
]) {
  await assert.rejects(
    resumeVerifiedBoot(
      guardedInspector,
      mismatch,
      "/reviewed/app",
      "/reviewed/profile",
      async () => {
        order.push("must not seed");
      },
    ),
  );
  assert.deepEqual(order, []);
}
await assert.rejects(
  resumeVerifiedBoot(
    guardedInspector,
    verified,
    "/reviewed/app",
    "/reviewed/profile",
    async () => {
      throw Error("seed failed");
    },
  ),
  /seed failed/,
);
assert.deepEqual(order, []);
await resumeVerifiedBoot(
  guardedInspector,
  verified,
  "/reviewed/app",
  "/reviewed/profile",
  async () => {
    order.push("seed started");
    await Promise.resolve();
    order.push("seed completed");
  },
);
assert.deepEqual(order, [
  "seed started",
  "seed completed",
  "Debugger.setBreakpointsActive",
  "Debugger.resume",
]);
console.log(
  "Exact URL allowlist, preserved options, pre-main/profile fail-closed, buffered CDP event and closed-session checks passed. No app/services started.",
);
