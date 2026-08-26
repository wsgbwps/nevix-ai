import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allowsPlainHttpServerUrl,
  isLoopbackHostname,
  parseServerUrl
} from '../../src/shared/config/server-url.ts'

test('loopback hostnames are exactly localhost and the loopback IPs', () => {
  for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(isLoopbackHostname(hostname), true, hostname)
  }

  for (const hostname of [
    '10.0.0.1',
    '192.168.1.50',
    '172.16.0.0',
    'example.local',
    'server.internal',
    '8.8.8.8',
    'nevix.example'
  ]) {
    assert.equal(isLoopbackHostname(hostname), false, hostname)
  }
})

test('plain http is a loopback-only exception and only in development mode', () => {
  // RFC1918 is no customer exception in any mode (#153).
  assert.equal(allowsPlainHttpServerUrl('127.0.0.1', true), true)
  assert.equal(allowsPlainHttpServerUrl('localhost', true), true)
  assert.equal(allowsPlainHttpServerUrl('[::1]', true), true)
  assert.equal(allowsPlainHttpServerUrl('127.0.0.1', false), false)
  assert.equal(allowsPlainHttpServerUrl('10.0.0.7', true), false)
  assert.equal(allowsPlainHttpServerUrl('192.168.1.50', true), false)
  assert.equal(allowsPlainHttpServerUrl('172.16.0.1', true), false)
  assert.equal(allowsPlainHttpServerUrl('nevix.example', true), false)
})

test('parseServerUrl structurally accepts https and http origins of any host', () => {
  assert.equal(parseServerUrl('https://api.nevix.example:8443'), 'https://api.nevix.example:8443')
  assert.equal(parseServerUrl('https://10.0.0.5'), 'https://10.0.0.5')
  assert.equal(parseServerUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
  assert.equal(parseServerUrl('http://192.168.1.50:8000'), 'http://192.168.1.50:8000')
  assert.equal(parseServerUrl('http://8.8.8.8:8080'), 'http://8.8.8.8:8080')
})

test('parseServerUrl rejects non-http(s) schemes, credentials, and non-origin URLs', () => {
  for (const url of [
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
