import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const exportHandlerSource = await readFile(
  join(import.meta.dirname, '../../src/main/organization/ipc/export-audit-log.ts'),
  'utf8'
)

test('the Audit Log E2E output path is disabled in packaged applications', () => {
  const testOutputPath = exportHandlerSource.match(
    /function testOutputPath\(\): string \| undefined \{[\s\S]*?\n\}/
  )?.[0]

  assert.ok(testOutputPath, 'testOutputPath function was not found')
  assert.match(testOutputPath, /process\.env\.NEVIX_E2E !== '1' \|\| app\.isPackaged/)
})
