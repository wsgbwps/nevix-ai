import assert from 'node:assert/strict'
import test from 'node:test'

import { applicationMenuTemplate, nativeEditItems } from '../../src/main/window/application-menu.ts'

const labels = {
  editMenu: '编辑',
  undo: '撤销',
  cut: '剪切',
  copy: '复制',
  paste: '粘贴',
  delete: '删除',
  selectAll: '全选'
}

test('macOS app menu keeps a visible Edit submenu so role accelerators register', () => {
  const template = applicationMenuTemplate('darwin', labels)
  assert.equal(template[0]?.role, 'appMenu')

  const editMenu = template[1]
  assert.equal(editMenu?.label, '编辑')
  const submenu = editMenu?.submenu ?? []
  const roles = submenu.map((item) => item.role)
  for (const role of ['undo', 'cut', 'copy', 'paste', 'delete', 'selectAll']) {
    assert.ok(roles.includes(role), `missing role: ${role}`)
  }

  // 回归：macOS 的键等价匹配跳过隐藏菜单项，visible:false 的 role 项不会注册
  // Cmd+C/V 等快捷键——粘贴曾因此在全应用失效。
  for (const item of submenu) {
    assert.notEqual(item.visible, false)
  }
})

test('non-macOS platforms omit the app menu but keep the Edit menu', () => {
  const template = applicationMenuTemplate('linux', labels)
  assert.equal(template.length, 1)
  assert.equal(template[0]?.label, '编辑')
})

test('context-menu edit items follow the caller editFlags', () => {
  const items = nativeEditItems({ canPaste: false }, labels)
  const paste = items.find((item) => item.role === 'paste')
  assert.equal(paste?.enabled, false)

  const unconditional = nativeEditItems(undefined, labels)
  assert.equal(unconditional.find((item) => item.role === 'paste')?.enabled, true)
})
