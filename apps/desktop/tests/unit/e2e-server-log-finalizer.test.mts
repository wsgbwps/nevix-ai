import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { finalizeE2EServerLog } from '../../scripts/finalize-e2e-server-log.mjs'

const testRoots: string[] = []

afterEach(async () => {
  await Promise.all(testRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

async function createFixture(): Promise<{
  readonly root: string
  readonly source: string
  readonly destination: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'nevix-e2e-server-log-'))
  testRoots.push(root)
  const source = join(root, 'temporary', 'identity-server.log')
  const destination = join(root, 'test-results', 'identity-server.log')
  await mkdir(join(root, 'temporary'), { recursive: true })
  return { root, source, destination }
}

test('failed E2E runs retain a redacted identity server log and remove the temporary source', async () => {
  const fixture = await createFixture()
  const environmentSecret = 'environment-only-secret-67890'
  const dotenvSecret = 'dotenv-only-secret-12345'
  const dotenvPublicValue = 'dotenv-public-value-54321'
  await writeFile(
    join(fixture.root, '.env.local'),
    `LOCAL_TEST_SECRET="${dotenvSecret}" # local only\nPUBLIC_LABEL=${dotenvPublicValue}\n`
  )
  await writeFile(
    fixture.source,
    [
      'identity server started',
      'Authorization: Bearer bearer-token-1234567890',
      'request Cookie: session=cookie-value-1234567890; refresh=cookie-refresh-1234567890',
      'Set-Cookie: session=set-cookie-value-1234567890; HttpOnly',
      'DATABASE_URL=postgresql://identity:database-password@127.0.0.1:54322/postgres',
      'password: plaintext-password-1234567890',
      'access_token="access-token-1234567890"',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-1234567890',
      'sb_secret_abcdefghijklmnopqrstuvwxyz',
      `unstructured inherited value ${environmentSecret}`,
      `unstructured dotenv value ${dotenvSecret}`,
      `unstructured public dotenv value ${dotenvPublicValue}`,
      'final actionable server failure'
    ].join('\n')
  )

  const result = await finalizeE2EServerLog({
    sourcePath: fixture.source,
    destinationPath: fixture.destination,
    repoRoot: fixture.root,
    exitStatus: 1,
    maxBytes: 16 * 1024,
    environment: { NEVIX_TEST_API_TOKEN: environmentSecret }
  })

  assert.equal(result.archived, true)
  await assert.rejects(stat(fixture.source), { code: 'ENOENT' })

  const retained = await readFile(fixture.destination, 'utf8')
  assert.match(retained, /identity server started/)
  assert.match(retained, /final actionable server failure/)
  assert.match(retained, /\[REDACTED\]/)
  for (const secret of [
    'bearer-token-1234567890',
    'cookie-value-1234567890',
    'cookie-refresh-1234567890',
    'set-cookie-value-1234567890',
    'database-password',
    'plaintext-password-1234567890',
    'access-token-1234567890',
    'eyJhbGciOiJIUzI1NiJ9',
    'sb_secret_abcdefghijklmnopqrstuvwxyz',
    environmentSecret,
    dotenvSecret,
    dotenvPublicValue
  ]) {
    assert.doesNotMatch(retained, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('retained server logs keep the newest diagnostics within the byte limit', async () => {
  const fixture = await createFixture()
  const maxBytes = 512
  await writeFile(
    fixture.source,
    `${'old diagnostic line\n'.repeat(200)}newest actionable diagnostic\n`
  )

  await finalizeE2EServerLog({
    sourcePath: fixture.source,
    destinationPath: fixture.destination,
    repoRoot: fixture.root,
    exitStatus: 1,
    maxBytes,
    environment: {}
  })

  const retained = await readFile(fixture.destination)
  assert.ok(retained.byteLength <= maxBytes)
  assert.match(retained.toString('utf8'), /log truncated to the newest 512 bytes/)
  assert.match(retained.toString('utf8'), /newest actionable diagnostic/)
})

test('successful E2E runs remove temporary and previously retained server logs', async () => {
  const fixture = await createFixture()
  await mkdir(join(fixture.root, 'test-results'), { recursive: true })
  await writeFile(fixture.source, 'successful run')
  await writeFile(fixture.destination, 'stale failed-run artifact')

  const result = await finalizeE2EServerLog({
    sourcePath: fixture.source,
    destinationPath: fixture.destination,
    repoRoot: fixture.root,
    exitStatus: 0,
    maxBytes: 1024,
    environment: {}
  })

  assert.equal(result.archived, false)
  await assert.rejects(stat(fixture.source), { code: 'ENOENT' })
  await assert.rejects(stat(fixture.destination), { code: 'ENOENT' })
})
