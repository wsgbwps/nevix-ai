import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node executes this CLI directly without a TypeScript runtime. */

export const DEFAULT_MAX_BYTES = 256 * 1024

const REDACTED = '[REDACTED]'
const SENSITIVE_NAME =
  /(?:authorization|cookie|credential|database_url|db_url|jwt|key|passwd|password|secret|session|smtp_pass|token)/i
const SKIPPED_ENV_DIRECTORIES = new Set(['.git', '.codex', 'node_modules', 'out', 'test-results'])

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function environmentSecrets(environment) {
  return Object.entries(environment)
    .filter(([name, value]) => SENSITIVE_NAME.test(name) && typeof value === 'string')
    .map(([, value]) => value)
}

function parseEnvironmentFile(contents) {
  const secrets = []
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match) continue

    let value = match[2].trim()
    const quotedValue = value.match(/^(["'])(.*)\1(?:\s+#.*)?$/)
    if (quotedValue) {
      value = quotedValue[2]
    } else {
      value = value.replace(/\s+#.*$/, '')
    }
    secrets.push(value)
  }
  return secrets
}

async function environmentFilesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files = []

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_ENV_DIRECTORIES.has(entry.name)) {
        files.push(...(await environmentFilesBelow(join(directory, entry.name))))
      }
    } else if (entry.isFile() && (entry.name === '.env' || entry.name.startsWith('.env.'))) {
      files.push(join(directory, entry.name))
    }
  }
  return files
}

async function environmentFileSecrets(repoRoot) {
  const secrets = []
  for (const path of await environmentFilesBelow(repoRoot)) {
    const contents = await readFile(path, 'utf8').catch(() => '')
    secrets.push(...parseEnvironmentFile(contents))
  }
  return secrets
}

function redactStructuredSecrets(log) {
  const sensitiveField =
    '(?:access[_-]?token|api[_-]?key|authorization|cookie|credential|database[_-]?url|db[_-]?url|id[_-]?token|jwt|passwd|password|proxy-authorization|refresh[_-]?token|secret|service[_-]?role[_-]?key|session[_-]?token|set-cookie|smtp[_-]?(?:pass|password))'

  return log
    .replace(
      /-----BEGIN [^-\r\n]+ PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]+ PRIVATE KEY-----/gi,
      REDACTED
    )
    .replace(
      /(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/gi,
      `$1${REDACTED}`
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(
      new RegExp(`((?:["']?${sensitiveField}["']?)\\s*[:=]\\s*")([^"]*)"`, 'gi'),
      `$1${REDACTED}"`
    )
    .replace(
      new RegExp(`((?:["']?${sensitiveField}["']?)\\s*[:=]\\s*')([^']*)'`, 'gi'),
      `$1${REDACTED}'`
    )
    .replace(
      new RegExp(`((?:["']?${sensitiveField}["']?)\\s*[:=]\\s*)([^\\s,;}\\]]+)`, 'gi'),
      `$1${REDACTED}`
    )
    .replace(new RegExp(`([?&]${sensitiveField}=)[^&#\\s]+`, 'gi'), `$1${REDACTED}`)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\bsb_(?:secret|service_role)_[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED)
}

async function sanitizeLog(log, repoRoot, environment) {
  let sanitized = redactStructuredSecrets(log)
  const exactSecrets = [
    ...environmentSecrets(environment),
    ...(await environmentFileSecrets(repoRoot))
  ]
    .filter((value) => value.length >= 4)
    .sort((left, right) => right.length - left.length)

  for (const secret of new Set(exactSecrets)) {
    sanitized = sanitized.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED)
  }
  return sanitized
}

function limitToNewestBytes(contents, maxBytes) {
  const buffer = Buffer.from(contents, 'utf8')
  if (buffer.byteLength <= maxBytes) return buffer

  const marker = Buffer.from(`[identity server log truncated to the newest ${maxBytes} bytes]\n`)
  if (marker.byteLength >= maxBytes) return marker.subarray(0, maxBytes)
  return Buffer.concat([
    marker,
    buffer.subarray(buffer.byteLength - (maxBytes - marker.byteLength))
  ])
}

/**
 * Retain a bounded, sanitized identity server log only after a failed E2E run. The temporary raw
 * log is removed on every path, including sanitizer failures.
 */
export async function finalizeE2EServerLog({
  sourcePath,
  destinationPath,
  repoRoot,
  exitStatus,
  maxBytes = DEFAULT_MAX_BYTES,
  environment = process.env
}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer')
  }

  const temporaryDestination = `${destinationPath}.tmp-${process.pid}`
  await rm(temporaryDestination, { force: true })

  try {
    if (exitStatus === 0) {
      await rm(destinationPath, { force: true })
      return { archived: false, path: destinationPath }
    }

    const rawLog = await readFile(sourcePath, 'utf8')
    const sanitizedLog = await sanitizeLog(rawLog, repoRoot, environment)
    const retainedLog = limitToNewestBytes(sanitizedLog, maxBytes)
    await mkdir(dirname(destinationPath), { recursive: true })
    await writeFile(temporaryDestination, retainedLog, { mode: 0o600 })
    await rename(temporaryDestination, destinationPath)
    return { archived: true, path: destinationPath, bytes: retainedLog.byteLength }
  } finally {
    await rm(temporaryDestination, { force: true })
    await rm(sourcePath, { force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sourcePath, destinationPath, repoRoot, exitStatusValue] = process.argv.slice(2)
  if (!sourcePath || !destinationPath || !repoRoot || !exitStatusValue) {
    console.error(
      'usage: finalize-e2e-server-log.mjs <source> <destination> <repo-root> <exit-status>'
    )
    process.exitCode = 2
  } else {
    const exitStatus = Number.parseInt(exitStatusValue, 10)
    await finalizeE2EServerLog({ sourcePath, destinationPath, repoRoot, exitStatus })
  }
}
