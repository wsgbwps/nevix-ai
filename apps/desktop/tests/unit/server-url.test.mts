import assert from 'node:assert/strict'
import test from 'node:test'
import { isAllowedPrivateHttpHostname, parseServerUrl } from '../../src/shared/config/server-url.ts'

test('plain-http hostname policy accepts only loopback and RFC1918 address ranges', () => {
  for (const hostname of [
    'localhost',
    '127.0.0.1',
    '[::1]',
    '10.0.0.1',
    '10.255.255.254',
    '172.16.0.0',
    '172.31.255.255',
    '192.168.1.50'
  ]) {
    assert.equal(isAllowedPrivateHttpHostname(hostname), true, hostname)
  }

  for (const hostname of [
    'example.local',
    'server.internal',
    '8.8.8.8',
    '172.15.255.255',
    '172.32.0.1',
    '192.167.255.255',
    '192.169.0.1',
    'nevix.example'
  ]) {
    assert.equal(isAllowedPrivateHttpHostname(hostname), false, hostname)
  }
})

test('parseServerUrl accepts https anywhere and http only on private hosts', () => {
  assert.equal(parseServerUrl('https://api.nevix.example:8443'), 'https://api.nevix.example:8443')
  assert.equal(parseServerUrl('https://10.0.0.5'), 'https://10.0.0.5')
  assert.equal(parseServerUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
  assert.equal(parseServerUrl('http://192.168.1.50:8000'), 'http://192.168.1.50:8000')
  assert.equal(parseServerUrl('http://10.0.0.7'), 'http://10.0.0.7')
})

test('parseServerUrl rejects public http, credentials, and non-origin URLs', () => {
  for (const url of [
    'http://8.8.8.8:8080',
    'http://nevix.example',
    'http://example.internal:8080',
    'https://api.nevix.example/identity',
    'https://api.nevix.example/identity/',
    'https://user:password@api.nevix.example',
    'https://api.nevix.example?debug=true',
    'https://api.nevix.example#fragment',
    'ftp://api.nevix.example',
    'not a url',
    ''
  ]) {
    assert.equal(parseServerUrl(url), undefined, url)
  }
})
