#!/usr/bin/env node
/**
 * Production Readiness probe runner (spec #150, ticket #158).
 *
 * 手动 release-gate 工具：以注入的凭据对固定国内 Kapon 路由执行 checklist
 * slot 的真实调用，并把通过的证据记录进 evidence 文档 —— 供 Server 激活
 * Capability Manifest。它永远不在普通 CI 中运行：
 *
 *   - 凭据只来自环境变量 KAPON_API_KEY；缺失即拒绝执行。
 *   - 本脚本不读取、不落盘、不打印该凭据。
 *   - 只访问审核过的固定路由 https://models.kapon.cloud（无 fallback、
 *     无按部署可配置的 Endpoint）。
 *   - 只有真实执行且通过的 slot 才会追加 evidence entry；本切片（#158）
 *     的生成/探测类 slot 执行实现归 T16（#166），未实现的 slot 会响亮
 *     失败且绝不伪造证据。
 *
 * 用法：
 *   node scripts/production-readiness/probe.mjs --list
 *   node scripts/production-readiness/probe.mjs --check-credential
 *   node scripts/production-readiness/probe.mjs --slot image.resolution.2k \
 *        [--slot video.duration.5s ...] [--evidence-out evidence.json]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHECKLIST_PATH = join(
  REPOSITORY,
  "server/internal/creation/domain/readiness-checklist.json",
);
const REVIEWED_BASE_URL = "https://models.kapon.cloud";

function fail(message) {
  console.error(`production-readiness: ${message}`);
  process.exit(1);
}

function loadChecklist() {
  let document;
  try {
    document = JSON.parse(readFileSync(CHECKLIST_PATH, "utf8"));
  } catch (error) {
    fail(`embedded checklist unreadable at ${CHECKLIST_PATH}: ${error.message}`);
  }
  if (document.schema_version !== 1 || !Array.isArray(document.slots)) {
    fail(`embedded checklist at ${CHECKLIST_PATH} has an unsupported shape`);
  }
  return document.slots;
}

function requireApiKey() {
  const key = process.env.KAPON_API_KEY;
  if (!key || key.trim() === "") {
    fail(
      "KAPON_API_KEY is not set; refusing to run. Inject the production " +
        "credential through the environment (CI must never hold it).",
    );
  }
  return key.trim();
}

/** sanity: one real GET /v1/models with the injected key; recorded nowhere. */
async function checkCredential(baseUrl, key) {
  let response;
  try {
    response = await fetch(new URL("/v1/models", baseUrl), {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    fail(`catalog check could not reach ${baseUrl}: ${error.message}`);
  }
  if (response.status === 401 || response.status === 403) {
    fail("catalog check rejected the injected credential (401/403).");
  }
  if (!response.ok) {
    fail(`catalog check got HTTP ${response.status}; try again later.`);
  }
  let catalog;
  try {
    catalog = await response.json();
  } catch {
    fail("catalog check got a non-JSON answer.");
  }
  const models = (catalog?.data ?? []).map((entry) => entry?.id).filter(Boolean);
  console.log(
    `catalog check ok: ${models.length} models visible ` +
      `(image=${models.includes("doubao-seedream-5.0-lite")}, video=${models.includes("doubao-seedance-2-5")})`,
  );
}

/**
 * 一个 slot 的真实调用。本切片只交付机制（凭据注入、checklist 枚举、
 * 证据记录）；生成与探测类探针的执行实现归 T16（#166），它会在对应
 * Generation adapter 落地后按 slot 的 media/dimension/value 逐个补齐。
 * 在此之前任何 slot 执行都必须响亮失败 —— 绝不写入未经真实执行的证据。
 */
async function runSlot(slot) {
  throw new Error(
    `probe execution for slot "${slot.id}" lands with T16 (#166): ` +
      `media=${slot.media} dimension=${slot.dimension} value=${slot.value} — ${slot.detail}`,
  );
}

function readEvidence(path) {
  if (!existsSync(path)) {
    return { schema_version: 1, generated_at: null, entries: [] };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.entries)) {
    fail(`existing evidence at ${path} has an unsupported shape`);
  }
  return parsed;
}

function appendEvidence(evidence, slot, evidenceRef) {
  evidence.entries = evidence.entries.filter((entry) => entry.slot_id !== slot.id);
  evidence.entries.push({
    slot_id: slot.id,
    status: "passed",
    checked_at: new Date().toISOString(),
    evidence_ref: evidenceRef,
  });
  evidence.generated_at = new Date().toISOString();
}

function parseArguments(argv) {
  const parsed = { slots: [], list: false, checkCredential: false, evidenceOut: "production-readiness.evidence.json" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--list") {
      parsed.list = true;
    } else if (flag === "--check-credential") {
      parsed.checkCredential = true;
    } else if (flag === "--slot") {
      index += 1;
      if (argv[index] === undefined) fail("--slot needs a slot id (see --list)");
      parsed.slots.push(argv[index]);
    } else if (flag === "--evidence-out") {
      index += 1;
      if (argv[index] === undefined) fail("--evidence-out needs a path");
      parsed.evidenceOut = argv[index];
    } else {
      fail(`unknown flag ${flag}`);
    }
  }
  return parsed;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const slots = loadChecklist();

  if (options.list) {
    for (const slot of slots) {
      console.log(`${slot.id}\t[${slot.kind}]\t${slot.title}`);
    }
    return;
  }

  if (options.slots.length === 0 && !options.checkCredential) {
    fail(
      "nothing to do: pass --slot <id> to execute slots, --check-credential " +
        "for the catalog sanity probe, or --list to enumerate the checklist.",
    );
  }

  const key = requireApiKey();
  if (options.checkCredential) {
    await checkCredential(REVIEWED_BASE_URL, key);
  }

  let evidence = null;
  for (const slotID of options.slots) {
    const slot = slots.find((candidate) => candidate.id === slotID);
    if (slot === undefined) {
      fail(`unknown slot "${slotID}" — the checklist is the single source of truth (--list).`);
    }
    try {
      const evidenceRef = await runSlot(slot);
      if (typeof evidenceRef !== "string" || evidenceRef === "") {
        fail(`slot "${slot.id}" passed without an evidence reference; refusing to record it.`);
      }
      evidence ??= readEvidence(options.evidenceOut);
      appendEvidence(evidence, slot, evidenceRef);
      console.log(`slot ${slot.id}: passed (evidence: ${evidenceRef})`);
    } catch (error) {
      fail(`slot ${slot.id} did not pass; no evidence recorded. ${error.message}`);
    }
  }

  if (evidence !== null) {
    writeFileSync(options.evidenceOut, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(`evidence written to ${options.evidenceOut} (${evidence.entries.length} entries).`);
  }
}

main();
