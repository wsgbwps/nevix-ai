import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveAuditLogE2ECancelDelay,
  resolveAuditLogE2EOutputPath
} from '../../src/main/organization/ipc/audit-log-export-path.ts'

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

test('an unpackaged E2E application can hold then cancel the Audit Log save dialog', () => {
  assert.equal(
    resolveAuditLogE2ECancelDelay({
      e2eMode: '1',
      isPackaged: false,
      configuredDelayMs: '750'
    }),
    750
  )
})

test('production and invalid Audit Log cancel controls cannot bypass the native dialog', () => {
  for (const input of [
    { e2eMode: undefined, isPackaged: false, configuredDelayMs: '750' },
    { e2eMode: '1', isPackaged: true, configuredDelayMs: '750' },
    { e2eMode: '1', isPackaged: false, configuredDelayMs: '0' },
    { e2eMode: '1', isPackaged: false, configuredDelayMs: '10001' },
    { e2eMode: '1', isPackaged: false, configuredDelayMs: 'not-a-number' }
  ]) {
    assert.equal(resolveAuditLogE2ECancelDelay(input), undefined)
  }
})
