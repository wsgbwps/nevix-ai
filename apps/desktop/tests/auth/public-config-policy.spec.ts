import { expect, test } from '@playwright/test'
import {
  isAllowedPrivateHttpHostname,
  parseSupabasePublicConfig,
  supabasePublicConfigPolicyForMode
} from '../../src/shared/config/supabase-public-config'

const VALID_PUBLISHABLE_KEY = `sb_publishable_${'x'.repeat(20)}`

function parseUrl(
  url: string,
  mode: string = 'production',
  key = VALID_PUBLISHABLE_KEY
): ReturnType<typeof parseSupabasePublicConfig> {
  return parseSupabasePublicConfig({
    url,
    publishableKey: key,
    policy: supabasePublicConfigPolicyForMode(mode)
  })
}

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
    'supabase.internal',
    '8.8.8.8',
    '172.15.255.255',
    '172.32.0.1',
    '192.167.255.255',
    '192.169.0.1'
  ]) {
    expect(isAllowedPrivateHttpHostname(hostname), hostname).toBe(false)
  }
})

test('build mode selects the private HTTP policy without an environment switch', () => {
  expect(supabasePublicConfigPolicyForMode('development')).toBe('private-network-http')
  expect(supabasePublicConfigPolicyForMode('test')).toBe('private-network-http')
  expect(supabasePublicConfigPolicyForMode('production')).toBe('https-only')
  expect(supabasePublicConfigPolicyForMode('preview')).toBe('https-only')
})

test('development and test accept loopback and RFC1918 HTTP origins', () => {
  for (const mode of ['development', 'test']) {
    for (const url of [
      'http://localhost:8000',
      'http://127.0.0.1:8000',
      'http://[::1]:8000',
      'http://10.20.30.40:8000',
      'http://172.16.0.0:8000',
      'http://172.31.255.255:8000',
      'http://192.168.1.50:8000'
    ]) {
      expect(parseUrl(url, mode)?.url, `${mode}: ${url}`).toBe(new URL(url).origin)
    }
  }
})

test('production and non-private HTTP origins are rejected', () => {
  for (const url of [
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'http://[::1]:8000',
    'http://10.20.30.40:8000',
    'http://172.16.0.0:8000',
    'http://172.31.255.255:8000',
    'http://192.168.1.50:8000'
  ]) {
    expect(parseUrl(url, 'production'), url).toBeUndefined()
  }

  for (const url of [
    'http://172.15.255.255:8000',
    'http://172.32.0.1:8000',
    'http://8.8.8.8:8000',
    'http://supabase.example.com:8000',
    'http://supabase.local:8000'
  ]) {
    expect(parseUrl(url, 'test'), url).toBeUndefined()
  }
})

test('HTTPS remains valid in production while unsafe URL shapes and keys are rejected', () => {
  expect(parseUrl('https://supabase.example.com:8443')?.url).toBe(
    'https://supabase.example.com:8443'
  )

  for (const url of [
    'https://user:password@supabase.example.com',
    'https://supabase.example.com/auth',
    'https://supabase.example.com?tenant=nevix',
    'https://supabase.example.com#auth'
  ]) {
    expect(parseUrl(url), url).toBeUndefined()
  }

  expect(parseUrl('https://supabase.example.com', 'production', 'sb_publishable_invalid')).toBe(
    undefined
  )
})
