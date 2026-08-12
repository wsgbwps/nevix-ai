import assert from 'node:assert/strict'
import test from 'node:test'
import type { ActiveMembership } from '../../src/renderer/src/features/organization/api/memberships.ts'
import {
  reconcileStartupBranch,
  resolveStartupBranch
} from '../../src/renderer/src/features/organization/model/startup-resolution.ts'

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

test('reconciliation begins onboarding after the final pending Invitation is removed', () => {
  let beganOnboarding = false
  let enteredMembership: ActiveMembership | undefined

  reconcileStartupBranch([], undefined, false, {
    beginOnboarding: () => {
      beganOnboarding = true
    },
    enterOrganization: (membership) => {
      enteredMembership = membership
    }
  })

  assert.equal(beganOnboarding, true)
  assert.equal(enteredMembership, undefined)
})

test('reconciliation enters an eligible Membership without beginning onboarding', () => {
  let beganOnboarding = false
  let enteredMembership: ActiveMembership | undefined

  reconcileStartupBranch([alpha], undefined, false, {
    beginOnboarding: () => {
      beganOnboarding = true
    },
    enterOrganization: (membership) => {
      enteredMembership = membership
    }
  })

  assert.equal(beganOnboarding, false)
  assert.equal(enteredMembership, alpha)
})

test('reconciliation keeps the picker open while another Invitation remains pending', () => {
  let actionCount = 0

  reconcileStartupBranch([], undefined, true, {
    beginOnboarding: () => {
      actionCount += 1
    },
    enterOrganization: () => {
      actionCount += 1
    }
  })

  assert.equal(actionCount, 0)
})
