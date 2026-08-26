import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isDesktopSource = context.parentURL?.includes('/apps/desktop/src/') === true
    const resolvedSpecifier =
      isDesktopSource && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)
        ? `${specifier}.ts`
        : specifier
    return nextResolve(resolvedSpecifier, context)
  }
})

const { AUDIT_ACTION_KEYS } =
  await import('../../src/renderer/src/features/user-management/lib/audit-actions.ts')
const { userManagementResources } =
  await import('../../src/renderer/src/features/user-management/i18n/resources.ts')

function actionsFor(language: 'zh-CN' | 'en'): Record<string, unknown> {
  const audit = (
    userManagementResources[language] as {
      userManagement: { audit: { actions: Record<string, unknown> } }
    }
  ).userManagement.audit
  return audit.actions
}

test('every presented audit action has a label in both supported languages', () => {
  for (const language of ['zh-CN', 'en'] as const) {
    const actions = actionsFor(language)
    for (const key of AUDIT_ACTION_KEYS) {
      const label = actions[key]
      assert.equal(
        typeof label,
        'string',
        `${language} audit.actions.${key} must be a translated label`
      )
      assert.ok((label as string).length > 0, `${language} audit.actions.${key} is empty`)
    }
  }
})

test('the reauth proof actions are presented with localized labels', () => {
  assert.equal(AUDIT_ACTION_KEYS.includes('reauth_proof_issued' as never), true)
  assert.equal(AUDIT_ACTION_KEYS.includes('reauth_proof_consumed' as never), true)
  assert.equal(actionsFor('zh-CN')['reauth_proof_issued'], '签发重验证授权')
  assert.equal(actionsFor('en')['reauth_proof_consumed'], 'Reauthentication proof consumed')
})
