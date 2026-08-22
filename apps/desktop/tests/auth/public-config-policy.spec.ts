import { expect, test } from '@playwright/test'
import {
  isAllowedPrivateHttpHostname,
  parseServerPublicConfig,
  serverPublicConfigPolicyForMode
} from '../../src/shared/config/server-public-config'

test('private HTTP hostname policy accepts only loopback and RFC1918 address ranges', () => {
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
    expect(isAllowedPrivateHttpHostname(hostname), hostname).toBe(true)
  }

  for (const hostname of [
    'example.local',
    'server.internal',
    '8.8.8.8',
    '172.15.255.255',
    '172.32.0.1',
    '192.167.255.255',
    '192.169.0.1'
  ]) {
    expect(isAllowedPrivateHttpHostname(hostname), hostname).toBe(false)
  }
})

test('server public config accepts only an exact HTTPS or development private-network origin', () => {
  expect(serverPublicConfigPolicyForMode('development')).toBe('private-network-http')
  expect(serverPublicConfigPolicyForMode('test')).toBe('private-network-http')
  expect(serverPublicConfigPolicyForMode('production')).toBe('https-only')

  expect(
    parseServerPublicConfig({
      url: 'https://api.nevix.example:8443',
      policy: serverPublicConfigPolicyForMode('production')
    })
  ).toEqual({ url: 'https://api.nevix.example:8443' })
  expect(
    parseServerPublicConfig({
      url: 'http://127.0.0.1:8080',
      policy: serverPublicConfigPolicyForMode('test')
    })
  ).toEqual({ url: 'http://127.0.0.1:8080' })

  for (const url of [
    undefined,
    'http://127.0.0.1:8080',
    'https://api.nevix.example/identity',
    'https://user:password@api.nevix.example',
    'https://api.nevix.example?debug=true'
  ]) {
    expect(
      parseServerPublicConfig({
        url,
        policy: serverPublicConfigPolicyForMode('production')
      }),
      String(url)
    ).toBeUndefined()
  }
})
