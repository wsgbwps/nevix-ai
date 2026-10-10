import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";

export const feedURL =
  "https://cnb.cool/nevix.ai/nevix-releases/-/git/raw/main/stable/darwin-arm64.json";
export const packagedMainURLPattern =
  /app\.asar[\\/]out[\\/]main[\\/]index\.js$/;
export function urlMap(artifactURL, origin, target = "darwin-arm64") {
  assert.ok(
    ["darwin-arm64", "win32-x64"].includes(target),
    "Unsupported installed acceptance target",
  );
  const artifact = new URL(artifactURL),
    fixture = new URL(origin);
  assert.equal(artifact.protocol, "https:");
  assert.equal(artifact.username + artifact.password + artifact.hash, "");
  assert.equal(fixture.protocol, "http:");
  assert.equal(fixture.hostname, "127.0.0.1");
  assert.equal(
    fixture.username + fixture.password + fixture.search + fixture.hash,
    "",
  );
  assert.ok(fixture.port);
  return [
    [feedURL.replace("darwin-arm64", target), `${fixture.origin}/manifest`],
    [artifactURL, `${fixture.origin}/artifact`],
  ];
}

// Only transport and the human dialog response are automated; production code is unchanged.
export function mainSetup(mapping, profile) {
  return `(() => {
    const electron = require('electron');
    if (electron.app.isReady()) throw Error('Missed pre-main injection boundary');
    if (electron.app.getPath('userData') !== ${JSON.stringify(profile)}) throw Error('Unexpected default profile');
    globalThis.__349Electron = electron;
    globalThis.__349Require = require;
    const originalFetch = globalThis.fetch.bind(globalThis);
    const originalDialog = electron.dialog.showMessageBox.bind(electron.dialog);
    const mapping = new Map(${JSON.stringify(mapping)});
    globalThis.__349Probe = {offers:0,messages:[],mapped:[],resolve:null};
    globalThis.fetch = (input, options) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const target = mapping.get(url);
      if (!target) return originalFetch(input, options);
      if (input instanceof Request) throw Error('Unexpected mapped Request input');
      globalThis.__349Probe.mapped.push(url);
      return originalFetch(target, options);
    };
    electron.dialog.showMessageBox = async (...args) => {
      const options = args.at(-1), probe = globalThis.__349Probe;
      probe.messages.push(options.message || '');
      if (['Nevix AI Updates','Nevix AI 更新'].includes(options.title) &&
          (JSON.stringify(options.buttons) === JSON.stringify(['Install and Restart','Later']) || JSON.stringify(options.buttons) === JSON.stringify(['安装并重启','稍后']))) {
        if(probe.resolve) throw Error('Concurrent native offer');
        probe.offers++;
        return new Promise(resolve => {probe.resolve = resolve});
      }
      if (['Nevix AI Updates','Nevix AI 更新'].includes(options.title) && options.buttons?.length === 1)
        return {response:0,checkboxChecked:false};
      return originalDialog(...args);
    };
    return {version:electron.app.getVersion(),profile:electron.app.getPath('userData'),packaged:electron.app.isPackaged,executable:process.execPath,pid:process.pid};
  })()`;
}

export class Inspector {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.scripts = new Map();
    this.closed = false;
    socket.addEventListener("message", ({ data }) => {
      const value = JSON.parse(data);
      if (value.id) {
        const request = this.pending.get(value.id);
        if (!request) return;
        this.pending.delete(value.id);
        clearTimeout(request.timer);
        if (value.error)
          request.reject(
            new Error(`Inspector command failed: ${value.error.message}`),
          );
        else request.resolve(value.result);
      } else {
        if (value.method === "Debugger.scriptParsed")
          this.scripts.set(value.params.scriptId, value.params.url);
        this.events.push(value);
      }
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Inspector closed"));
      }
      this.pending.clear();
    });
  }
  async send(method, params = {}) {
    assert.equal(this.closed, false, "Inspector already closed");
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Inspector timeout: ${method}`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async event(method, timeout = 20_000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const index = this.events.findIndex((value) => value.method === method);
      if (index !== -1) return this.events.splice(index, 1)[0].params;
      assert.equal(
        this.closed,
        false,
        "Inspector closed before expected event",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Inspector event timeout: ${method}`);
  }
  async evaluate(expression) {
    return evaluated(
      await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }),
    );
  }
  close() {
    this.socket.close();
  }
}
function evaluated(value) {
  assert.equal(
    value.exceptionDetails,
    undefined,
    "Injected Main evaluation failed",
  );
  return value.result.value;
}

export async function serveBytes(envelope, artifact) {
  const bytes = await readFile(envelope),
    size = (await stat(artifact)).size;
  const server = createServer((request, response) => {
    if (request.method !== "GET") return response.writeHead(405).end();
    if (request.url === "/manifest") {
      response
        .writeHead(200, {
          "content-type": "application/json",
          "content-length": bytes.length,
        })
        .end(bytes);
    } else if (request.url === "/artifact") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": size,
      });
      createReadStream(artifact)
        .on("error", () => response.destroy())
        .pipe(response);
    } else response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

export async function resumeVerifiedBoot(
  inspector,
  boot,
  executable,
  profile,
  beforeResume,
) {
  assert.equal(boot.packaged, true);
  assert.equal(boot.executable, executable);
  assert.equal(boot.profile, profile);
  await beforeResume(boot);
  await inspector.send("Debugger.setBreakpointsActive", { active: false });
  await inspector.send("Debugger.resume");
}

export async function launchInstalled(
  executable,
  mapping,
  profile,
  beforeResume,
) {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "USER",
    "LOGNAME",
    "SHELL",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SYSTEMROOT",
    "WINDIR",
    "SYSTEMDRIVE",
    "TEMP",
    "TMP",
  ];
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      allowed.includes(key.toUpperCase()),
    ),
  );
  const child = spawn(
    executable,
    ["--inspect-brk=0", "--remote-debugging-port=0"],
    {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "",
    spawnError;
  child.stderr.on("data", (data) => {
    stderr += data;
    stderr = stderr.slice(-32_768);
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  const deadline = Date.now() + 30_000;
  let inspector,
    resumed = false;
  try {
    while (
      !stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)
    ) {
      if (spawnError) throw spawnError;
      assert.equal(
        child.exitCode,
        null,
        "Installed application exited before inspector attached",
      );
      assert.ok(Date.now() < deadline, "No Node inspector endpoint");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const socket = new WebSocket(
      stderr.match(
        /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/,
      )[1],
    );
    await once(socket, "open");
    inspector = new Inspector(socket);
    await inspector.send("Debugger.enable");
    await inspector.send("Debugger.setBreakpointByUrl", {
      lineNumber: 0,
      urlRegex: packagedMainURLPattern.source,
    });
    await inspector.send("Runtime.runIfWaitingForDebugger");
    let boot;
    for (let count = 0; count < 8; count++) {
      const paused = await inspector.event("Debugger.paused");
      const frame = paused.callFrames[0];
      if (
        packagedMainURLPattern.test(
          frame.url || inspector.scripts.get(frame.location.scriptId) || "",
        )
      ) {
        boot = evaluated(
          await inspector.send("Debugger.evaluateOnCallFrame", {
            callFrameId: frame.callFrameId,
            expression: mainSetup(mapping, profile),
            returnByValue: true,
          }),
        );
        break;
      }
      await inspector.send("Debugger.resume");
    }
    assert.ok(
      boot,
      "No packaged Main first-line breakpoint; refusing uninjected continuation",
    );
    await resumeVerifiedBoot(
      inspector,
      boot,
      executable,
      profile,
      beforeResume,
    );
    resumed = true;
    return {
      child,
      inspector,
      boot,
      async rendererEndpoint() {
        const until = Date.now() + 30_000;
        while (Date.now() < until) {
          const match = stderr.match(
            /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/,
          );
          if (match) return match[1];
          assert.equal(
            child.exitCode,
            null,
            "Installed application exited before renderer attached",
          );
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("No renderer debugging endpoint");
      },
    };
  } catch (error) {
    inspector?.close();
    // A missed injection must never continue into a real production update check.
    if (!resumed && child.exitCode === null) child.kill("SIGTERM");
    throw error;
  }
}
