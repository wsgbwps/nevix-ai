import assert from 'node:assert/strict'
import test from 'node:test'
import type { ActiveMembership } from '../../src/renderer/src/features/organization/api/memberships.ts'
import { resolveStartupBranch } from '../../src/renderer/src/features/organization/model/startup-resolution.ts'

const alpha: ActiveMembership = {
  organizationId: 'organization-alpha',
  organizationName: 'Alpha',
  role: 'owner'
}
const beta: ActiveMembership = {
  organizationId: 'organization-beta',
  organizationName: 'Beta',
  role: 'member'
}

test('startup verification enters the active Membership remembered by this device', () => {
  assert.deepEqual(resolveStartupBranch([alpha, beta], alpha.organizationId), {
    kind: 'enter',
    membership: alpha
  })
})

test('startup verification sends a stale remembered Membership to the Organization picker', () => {
  assert.deepEqual(resolveStartupBranch([alpha], 'former-membership-organization'), {
    kind: 'picker'
  })
})

test('startup verification enters the sole Membership without a device memory', () => {
  assert.deepEqual(resolveStartupBranch([alpha], undefined), {
    kind: 'enter',
    membership: alpha
  })
})

test('startup verification sends multiple Memberships without a device memory to the picker', () => {
  assert.deepEqual(resolveStartupBranch([alpha, beta], undefined), {
    kind: 'picker'
  })
})

test('startup verification begins Organization onboarding without Memberships', () => {
  assert.deepEqual(resolveStartupBranch([], undefined), {
    kind: 'onboarding'
  })
})

test('startup verification sends a pending invitee to the Organization picker', () => {
  assert.deepEqual(resolveStartupBranch([], undefined, true), {
    kind: 'picker'
  })
})

test('a pending invitation overrides remembered and sole-Membership auto-entry', () => {
  assert.deepEqual(resolveStartupBranch([alpha], alpha.organizationId, true), {
    kind: 'picker'
  })
})
