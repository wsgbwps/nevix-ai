import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAuditLogE2EOutputPath } from '../../src/main/organization/ipc/audit-log-export-path.ts'

const e2eOutputPath = '/tmp/organization-audit-log.csv'

const cases = [
  {
    name: 'an unpackaged E2E application uses the configured Audit Log output path',
    input: { e2eMode: '1', isPackaged: false, configuredOutputPath: e2eOutputPath },
    expected: e2eOutputPath
  },
  {
    name: 'a packaged application ignores the configured Audit Log E2E output path',
    input: { e2eMode: '1', isPackaged: true, configuredOutputPath: e2eOutputPath },
    expected: undefined
  },
  {
    name: 'an unpackaged non-E2E application ignores the configured output path',
    input: { e2eMode: undefined, isPackaged: false, configuredOutputPath: e2eOutputPath },
    expected: undefined
  },
  {
    name: 'an unpackaged E2E application without an output path uses the native dialog',
    input: { e2eMode: '1', isPackaged: false, configuredOutputPath: undefined },
    expected: undefined
  }
] as const

for (const testCase of cases) {
  test(testCase.name, () => {
    assert.equal(resolveAuditLogE2EOutputPath(testCase.input), testCase.expected)
  })
}
