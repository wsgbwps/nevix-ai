// Desktop architecture verifier: deterministic Domain-first rules over a source
// file map. It automates only facts derivable from the filesystem, syntax, and
// the import graph; responsibility placement, interface depth, deletion tests,
// and migration scope stay deliberate review decisions.
// This verifier must run directly in Node without a TypeScript runtime.
/* eslint-disable @typescript-eslint/explicit-function-return-type */

const MAIN = 'src/main'
const PRELOAD = 'src/preload'
const FEATURES = 'src/renderer/src/features'
const SHARED_IPC = 'src/shared/ipc'

const PLATFORM_OWNERS = new Set(['window', 'updater', 'tray'])
const LEGACY_DOMAIN_NAMES = new Set(['settings', 'i18n'])
const FORBIDDEN_SEGMENTS = new Set(['components', 'hooks', 'store', 'types'])
const CANONICAL_DISCOVERY_GLOB = './*/ipc/index.ts'
const PRELOAD_ALLOWED_IMPORTS = new Set(['electron', '@ipc/channels'])
const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/
const CHANNEL_KEY = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/
const CHANNEL_LITERAL = /'([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)'/g

const RULE_IDS = [
  'main/adapter-first-ipc',
  'main/platform-owner-ipc',
  'main/legacy-domain-name',
  'main/registration-discovery',
  'main/registration-module-shape',
  'main/handler-nesting',
  'main/implementation-ipc-independence',
  'main/cross-domain-deep-import',
  'main/domain-cycle',
  'shared/legacy-domain-name',
  'shared/channels-base',
  'shared/channel-declaration-placement',
  'channels/seam-name-agreement',
  'channels/domain-prefix',
  'channels/legacy-language-prefix',
  'preload/generic-bridge',
  'renderer/legacy-feature-name',
  'renderer/feature-root-source',
  'renderer/public-index-shape',
  'renderer/feature-deep-import',
  'renderer/feature-self-import',
  'renderer/peer-feature-import',
  'renderer/segment-vocabulary'
]

// When a file already violates one of these ownership rules, its content-level
// findings are suppressed so each debt path yields one clear diagnostic and one
// exact-path allowlist entry.
const OWNERSHIP_RULES = new Set([
  'main/adapter-first-ipc',
  'main/legacy-domain-name',
  'shared/legacy-domain-name',
  'renderer/legacy-feature-name'
])

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
}

function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

function posixResolve(fromDirectory, spec) {
  const segments = fromDirectory.split('/')
  for (const part of spec.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return segments.join('/')
}

function directoryOf(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

/** Extract static, dynamic, and bare import specifiers with line numbers. */
function importsOf(text) {
  const stripped = stripComments(text)
  const imports = []
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
  ]
  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) {
      imports.push({
        spec: match[1],
        line: lineAt(stripped, match.index ?? 0),
        statement: match[0]
      })
    }
  }
  return imports
}

/** Remove import/export-from statements so channel-literal scans skip specifiers. */
function withoutImportStatements(text) {
  return stripComments(text)
    .replace(/(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"][^'"]+['"]/g, '\n')
    .replace(/import\s*\(\s*['"][^'"]+['"]\s*\)/g, '')
    .replace(/(?:^|\n)\s*import\s*['"][^'"]+['"]/g, '\n')
}

function createResolver(files) {
  const complete = (path) => {
    for (const candidate of [
      path,
      `${path}.ts`,
      `${path}.tsx`,
      `${path}.mts`,
      `${path}/index.ts`,
      `${path}/index.tsx`
    ]) {
      if (files.has(candidate)) return candidate
    }
    return path
  }

  return (fromPath, rawSpec) => {
    const spec = rawSpec.split('?')[0]
    if (spec === '@ipc/channels') return `${SHARED_IPC}/channels.ts`
    if (spec.startsWith('@renderer/')) return complete(`src/renderer/src/${spec.slice(10)}`)
    if (spec.startsWith('@/')) return complete(`src/renderer/src/${spec.slice(2)}`)
    if (spec.startsWith('./') || spec.startsWith('../')) {
      return complete(posixResolve(directoryOf(fromPath), spec))
    }
    return null
  }
}

function findMatchingBrace(text, openIndex) {
  let depth = 0
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return text.length - 1
}

class Collector {
  constructor() {
    this.violations = []
  }

  report(rule, path, message, expected, line) {
    this.violations.push({ rule, path, message, expected, ...(line ? { line } : {}) })
  }
}

function childDirectories(files, parent) {
  const names = new Set()
  const prefix = `${parent}/`
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    if (rest.includes('/')) names.add(rest.slice(0, rest.indexOf('/')))
  }
  return [...names].sort()
}

function sourceFilesUnder(files, parent) {
  const prefix = `${parent}/`
  return [...files.keys()].filter((path) => path.startsWith(prefix) && SOURCE_FILE.test(path))
}

function mainDomainDirectories(files) {
  return childDirectories(files, MAIN).filter(
    (name) => !PLATFORM_OWNERS.has(name) && name !== 'ipc'
  )
}

function mainOwnerOf(path) {
  if (!path.startsWith(`${MAIN}/`)) return null
  const rest = path.slice(MAIN.length + 1)
  return rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : null
}

function featureOf(path) {
  if (!path.startsWith(`${FEATURES}/`)) return null
  const rest = path.slice(FEATURES.length + 1)
  return rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : null
}

function checkMainOwnership(files, collector) {
  for (const path of sourceFilesUnder(files, `${MAIN}/ipc`)) {
    collector.report(
      'main/adapter-first-ipc',
      path,
      'Adapter-first Main IPC ownership is forbidden.',
      'Domain-owned IPC adapters live in src/main/<domain>/ipc/.'
    )
  }
  for (const owner of PLATFORM_OWNERS) {
    for (const path of sourceFilesUnder(files, `${MAIN}/${owner}/ipc`)) {
      collector.report(
        'main/platform-owner-ipc',
        path,
        `Platform owner "${owner}" carries an IPC adapter.`,
        'window/, updater/, and tray/ stay non-Domain owners; only src/main/<domain>/ipc/ registers Channels.'
      )
    }
  }
  for (const domain of mainDomainDirectories(files)) {
    if (!LEGACY_DOMAIN_NAMES.has(domain)) continue
    for (const path of sourceFilesUnder(files, `${MAIN}/${domain}`)) {
      collector.report(
        'main/legacy-domain-name',
        path,
        `Legacy Main Domain name "${domain}" is not canonical.`,
        'Language Mode and Interface Language belong to the canonical `language` Domain.'
      )
    }
  }
}

function checkRegistrationDiscovery(files, collector) {
  const path = `${MAIN}/index.ts`
  const text = files.get(path)
  if (text === undefined) return
  const expected = `Composition root eager-loads registration modules with import.meta.glob('${CANONICAL_DISCOVERY_GLOB}', { eager: true }) exactly once.`
  const calls = [
    ...stripComments(text).matchAll(/import\.meta\.glob\(\s*'([^']*)'\s*(?:,\s*(\{[^)]*\}))?\s*\)/g)
  ]
  if (calls.length !== 1) {
    collector.report(
      'main/registration-discovery',
      path,
      `Found ${calls.length} import.meta.glob calls instead of the single canonical discovery pattern.`,
      expected
    )
    return
  }
  const [call] = calls
  if (call[1] !== CANONICAL_DISCOVERY_GLOB || !/eager\s*:\s*true/.test(call[2] ?? '')) {
    collector.report(
      'main/registration-discovery',
      path,
      `Discovery pattern import.meta.glob('${call[1]}', ${call[2] ?? '<no options>'}) is not the canonical Domain-first form.`,
      expected,
      lineAt(stripComments(text), call.index ?? 0)
    )
  }
}

function checkRegistrationModules(files, collector) {
  for (const domain of mainDomainDirectories(files)) {
    const adapterDirectory = `${MAIN}/${domain}/ipc`
    const adapterFiles = sourceFilesUnder(files, adapterDirectory)
    if (adapterFiles.length === 0) continue

    for (const path of adapterFiles) {
      if (path.slice(adapterDirectory.length + 1).includes('/')) {
        collector.report(
          'main/handler-nesting',
          path,
          'Channel Handlers must be directly nested files of the Domain IPC adapter.',
          'Each Channel Handler lives in src/main/<domain>/ipc/<action>.ts with no handlers/ or other wrapper directory.'
        )
      }
    }

    const indexPath = `${adapterDirectory}/index.ts`
    const text = files.get(indexPath)
    const expected =
      'Registration module only exports a synchronous register(): void; loading it has no side effects.'
    if (text === undefined) {
      collector.report(
        'main/registration-module-shape',
        `${adapterDirectory}/`,
        'Domain IPC adapter has no registration module.',
        expected
      )
      continue
    }
    const stripped = stripComments(text)
    const registerMatch = stripped.match(/export function register\(\)\s*:\s*void\s*\{/)
    if (!registerMatch || /export\s+async\s+function\s+register\b/.test(stripped)) {
      collector.report(
        'main/registration-module-shape',
        indexPath,
        'Registration module does not export a synchronous register(): void.',
        expected
      )
      continue
    }
    const bodyEnd = findMatchingBrace(
      stripped,
      (registerMatch.index ?? 0) + registerMatch[0].length - 1
    )
    let rest = stripped.slice(0, registerMatch.index ?? 0) + stripped.slice(bodyEnd + 1)
    rest = rest.replace(/(?:^|\n)\s*import\s[^;'"]*?from\s*['"][^'"]+['"][ \t]*;?/g, '\n')
    if (/import\s*['"]/.test(rest)) {
      collector.report(
        'main/registration-module-shape',
        indexPath,
        'Side-effect import in a registration module runs at load time.',
        expected
      )
      rest = rest.replace(/(?:^|\n)\s*import\s*['"][^'"]+['"][ \t]*;?/g, '\n')
    }
    if (rest.trim() !== '') {
      collector.report(
        'main/registration-module-shape',
        indexPath,
        'Registration module contains top-level statements or extra exports besides imports and register().',
        expected
      )
    }
  }
}

function checkMainImports(files, resolve, collector) {
  const domains = new Set(mainDomainDirectories(files))
  const edges = new Map()

  for (const path of sourceFilesUnder(files, MAIN)) {
    const owner = mainOwnerOf(path)
    const ownDomain = owner !== null && domains.has(owner) ? owner : null
    const insideAdapter = ownDomain !== null && path.startsWith(`${MAIN}/${ownDomain}/ipc/`)
    const imports = importsOf(files.get(path) ?? '')

    for (const { spec, line, statement } of imports) {
      if (
        ownDomain !== null &&
        !insideAdapter &&
        spec === 'electron' &&
        /\bipc(Main|Renderer)\b/.test(statement)
      ) {
        collector.report(
          'main/implementation-ipc-independence',
          path,
          'Domain implementation imports Electron IPC.',
          'Only the Domain IPC adapter in src/main/<domain>/ipc/ touches IPC; implementation stays transport-free.',
          line
        )
      }
      const target = resolve(path, spec)
      if (target === null || !target.startsWith(`${MAIN}/`)) continue
      const targetOwner = mainOwnerOf(target)
      const targetDomain = targetOwner !== null && domains.has(targetOwner) ? targetOwner : null
      if (targetDomain === null) continue

      if (
        ownDomain !== null &&
        !insideAdapter &&
        target.startsWith(`${MAIN}/${targetDomain}/ipc/`)
      ) {
        collector.report(
          'main/implementation-ipc-independence',
          path,
          'Domain implementation depends on an IPC adapter.',
          'Only the Domain IPC adapter in src/main/<domain>/ipc/ touches IPC; implementation stays transport-free.',
          line
        )
      }
      if (targetDomain !== ownDomain) {
        if (ownDomain !== null) {
          if (!edges.has(ownDomain)) edges.set(ownDomain, new Set())
          edges.get(ownDomain).add(targetDomain)
        }
        if (target !== `${MAIN}/${targetDomain}/index.ts`) {
          collector.report(
            'main/cross-domain-deep-import',
            path,
            `Deep import into Main Domain "${targetDomain}".`,
            'Callers outside a Main Domain import only its public interface src/main/<domain>/index.ts.',
            line
          )
        }
      }
    }
  }

  reportDomainCycles(edges, collector)
}

function reportDomainCycles(edges, collector) {
  const visiting = new Set()
  const done = new Set()
  const reported = new Set()

  const visit = (domain, trail) => {
    if (done.has(domain)) return
    if (visiting.has(domain)) {
      const cycle = [...trail.slice(trail.indexOf(domain)), domain]
      const key = [...cycle].sort().join('>')
      if (!reported.has(key)) {
        reported.add(key)
        collector.report(
          'main/domain-cycle',
          `${MAIN}/${[...cycle].sort()[0]}`,
          `Main Domain dependency cycle: ${cycle.join(' -> ')}.`,
          'Cross-Domain dependencies in Main remain acyclic.'
        )
      }
      return
    }
    visiting.add(domain)
    for (const next of [...(edges.get(domain) ?? [])].sort()) visit(next, [...trail, domain])
    visiting.delete(domain)
    done.add(domain)
  }

  for (const domain of [...edges.keys()].sort()) visit(domain, [])
}

function checkSharedIpc(files, collector) {
  const basePath = `${SHARED_IPC}/channels.ts`
  const baseText = files.get(basePath)
  if (baseText !== undefined) {
    const rest = stripComments(baseText)
      .replace(/export interface IpcChannelMap\s*\{\s*\}/, '')
      .replace(/export interface IpcEventMap\s*\{\s*\}/, '')
    if (rest.trim() !== '') {
      collector.report(
        'shared/channels-base',
        basePath,
        'Shared Channel base is not the empty aggregation model.',
        'channels.ts contains only the empty IpcChannelMap and IpcEventMap interfaces; Domains extend them via declaration merging.'
      )
    }
  }

  for (const domain of childDirectories(files, SHARED_IPC)) {
    const typesPath = `${SHARED_IPC}/${domain}/types.ts`
    if (LEGACY_DOMAIN_NAMES.has(domain)) {
      for (const path of sourceFilesUnder(files, `${SHARED_IPC}/${domain}`)) {
        collector.report(
          'shared/legacy-domain-name',
          path,
          `Legacy shared IPC Domain name "${domain}" is not canonical.`,
          'Language Channels belong to the canonical `language` Domain in src/shared/ipc/language/types.ts.'
        )
      }
      continue
    }
    const text = files.get(typesPath)
    if (text === undefined) continue
    const stripped = stripComments(text)
    for (const match of stripped.matchAll(/'([^'\n]+)'\s*:/g)) {
      const key = match[1]
      if (!key.includes(':')) continue
      if (!CHANNEL_KEY.test(key) || !key.startsWith(`${domain}:`)) {
        collector.report(
          'channels/domain-prefix',
          typesPath,
          `Channel "${key}" does not use its owning Domain prefix.`,
          `Channels declared by this Domain are named ${domain}:<action>.`,
          lineAt(stripped, match.index ?? 0)
        )
      }
    }
  }

  for (const [path, text] of files) {
    if (!SOURCE_FILE.test(path)) continue
    if (/declare module\s+'@ipc\/channels'/.test(stripComments(text))) {
      const feature = path.match(/^src\/shared\/ipc\/([^/]+)\/types\.ts$/)
      if (!feature) {
        collector.report(
          'shared/channel-declaration-placement',
          path,
          "Channel map augmentation lives outside a shared IPC Domain's types.ts.",
          "declare module '@ipc/channels' appears only in src/shared/ipc/<domain>/types.ts."
        )
      }
    }
  }
}

function checkSeamNameAgreement(files, collector) {
  for (const domain of childDirectories(files, SHARED_IPC)) {
    if (LEGACY_DOMAIN_NAMES.has(domain)) continue
    if (sourceFilesUnder(files, `${MAIN}/${domain}`).length === 0) {
      collector.report(
        'channels/seam-name-agreement',
        `${SHARED_IPC}/${domain}/types.ts`,
        `Shared IPC Domain "${domain}" has no matching Main Domain.`,
        'The canonical Domain name is reused across every seam the Domain actually needs; Channels declared in src/shared/ipc/<domain>/ are owned by src/main/<domain>/.'
      )
    }
  }
  for (const domain of mainDomainDirectories(files)) {
    if (LEGACY_DOMAIN_NAMES.has(domain)) continue
    if (
      sourceFilesUnder(files, `${MAIN}/${domain}/ipc`).length > 0 &&
      !files.has(`${SHARED_IPC}/${domain}/types.ts`)
    ) {
      collector.report(
        'channels/seam-name-agreement',
        `${MAIN}/${domain}/ipc/index.ts`,
        `Main Domain "${domain}" registers IPC without shared Channel declarations.`,
        'A Domain IPC adapter pairs with declaration merging in src/shared/ipc/<domain>/types.ts under the same canonical Domain name.'
      )
    }
  }
}

function checkMainAdapterChannelPrefixes(files, collector) {
  for (const domain of mainDomainDirectories(files)) {
    for (const path of sourceFilesUnder(files, `${MAIN}/${domain}/ipc`)) {
      const body = withoutImportStatements(files.get(path) ?? '')
      for (const match of body.matchAll(CHANNEL_LITERAL)) {
        if (!match[1].startsWith(`${domain}:`)) {
          collector.report(
            'channels/domain-prefix',
            path,
            `Channel "${match[1]}" does not use its owning Domain prefix.`,
            `Channels handled by this Domain adapter are named ${domain}:<action>.`,
            lineAt(body, match.index ?? 0)
          )
        }
      }
    }
  }
}

function checkLegacyChannelPrefixes(files, collector) {
  for (const [path, text] of files) {
    if (!SOURCE_FILE.test(path)) continue
    const body = withoutImportStatements(text)
    for (const match of body.matchAll(/'((settings|i18n):[a-z0-9-]+)'/g)) {
      collector.report(
        'channels/legacy-language-prefix',
        path,
        `Legacy Language Channel "${match[1]}".`,
        'Language Channels use the canonical `language:<action>` prefix with no settings:/i18n: alias.',
        lineAt(body, match.index ?? 0)
      )
    }
  }
}

function checkPreload(files, collector) {
  for (const path of sourceFilesUnder(files, PRELOAD)) {
    const text = files.get(path) ?? ''
    for (const { spec, line } of importsOf(text)) {
      if (!PRELOAD_ALLOWED_IMPORTS.has(spec)) {
        collector.report(
          'preload/generic-bridge',
          path,
          `Preload imports "${spec}".`,
          'Preload stays a generic typed bridge importing only electron and @ipc/channels; no per-Domain code or registry.',
          line
        )
      }
    }
    const body = withoutImportStatements(text)
    for (const match of body.matchAll(CHANNEL_LITERAL)) {
      collector.report(
        'preload/generic-bridge',
        path,
        `Preload contains the Channel constant "${match[1]}".`,
        'Preload exposes only generic typed invoke/on primitives without Domain Channel constants.',
        lineAt(body, match.index ?? 0)
      )
    }
  }
}

function checkRendererFeatures(files, resolve, collector) {
  const features = childDirectories(files, FEATURES)
  const featureSet = new Set(features)

  for (const feature of features) {
    const root = `${FEATURES}/${feature}`
    if (LEGACY_DOMAIN_NAMES.has(feature)) {
      for (const path of sourceFilesUnder(files, root)) {
        collector.report(
          'renderer/legacy-feature-name',
          path,
          `Legacy renderer Feature name "${feature}" is not canonical.`,
          'Language behavior belongs to the canonical `language` Feature.'
        )
      }
      continue
    }

    for (const path of sourceFilesUnder(files, root)) {
      const rest = path.slice(root.length + 1)
      if (!rest.includes('/') && rest !== 'index.ts') {
        collector.report(
          'renderer/feature-root-source',
          path,
          'Feature root contains a source file besides the public index.',
          'The only TypeScript source at a Feature root is its public index.ts.'
        )
      }
      const segment = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : null
      if (segment !== null && FORBIDDEN_SEGMENTS.has(segment)) {
        collector.report(
          'renderer/segment-vocabulary',
          path,
          `Feature segment "${segment}/" is outside the canonical vocabulary.`,
          'General-purpose Feature segments use ui/, api/, model/, lib/, or config/; responsibility-named segments need review.'
        )
      }
    }

    const indexPath = `${root}/index.ts`
    const indexText = files.get(indexPath)
    if (indexText !== undefined) {
      const stripped = stripComments(indexText)
      if (/export\s*\*/.test(stripped)) {
        collector.report(
          'renderer/public-index-shape',
          indexPath,
          'Feature public index uses a wildcard export.',
          'The public index contains explicit named re-exports only.'
        )
      }
      const rest = stripped
        .replace(/export\s*\*[^;\n]*/g, '')
        .replace(/export\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?/g, '')
      if (rest.trim() !== '') {
        collector.report(
          'renderer/public-index-shape',
          indexPath,
          'Feature public index contains implementation, imports, or side effects.',
          'The public index contains explicit named re-exports only.'
        )
      }
    }
  }

  for (const [path, text] of files) {
    if (!path.startsWith('src/renderer/') || !SOURCE_FILE.test(path)) continue
    const ownFeature = featureOf(path)
    if (ownFeature !== null && LEGACY_DOMAIN_NAMES.has(ownFeature)) continue
    for (const { spec, line } of importsOf(text)) {
      const target = resolve(path, spec)
      if (target === null) continue
      const targetFeature = featureOf(target)
      if (targetFeature === null || !featureSet.has(targetFeature)) continue
      const targetIndex = `${FEATURES}/${targetFeature}/index.ts`

      if (ownFeature === null) {
        if (target !== targetIndex) {
          collector.report(
            'renderer/feature-deep-import',
            path,
            `Deep import into Feature "${targetFeature}".`,
            'Code outside a Feature imports it only through its public index.ts.',
            line
          )
        }
      } else if (targetFeature === ownFeature) {
        if (target === targetIndex && path !== targetIndex) {
          collector.report(
            'renderer/feature-self-import',
            path,
            `Feature "${ownFeature}" imports its own public index.`,
            'Inside a Feature, implementation uses direct relative imports.',
            line
          )
        }
      } else {
        collector.report(
          'renderer/peer-feature-import',
          path,
          `Feature "${ownFeature}" imports peer Feature "${targetFeature}".`,
          'Peer Features never import one another; the app layer composes them.',
          line
        )
      }
    }
  }
}

function validateAllowlist(allowlist, collector) {
  const seen = new Set()
  const knownRules = new Set(RULE_IDS)
  const valid = []
  for (const entry of allowlist) {
    const { rule, path, reason, removalTrigger } = entry ?? {}
    const expected =
      'Allowlist entries carry a known rule, an exact src/ path, a reason, and a verifiable removal trigger.'
    const problems = []
    if (!knownRules.has(rule)) problems.push(`unknown rule "${rule}"`)
    if (typeof path !== 'string' || !path.startsWith('src/') || /[*?]/.test(path)) {
      problems.push('path must be an exact src/ path without wildcards')
    }
    if (typeof reason !== 'string' || reason.trim() === '') problems.push('missing reason')
    if (typeof removalTrigger !== 'string' || removalTrigger.trim() === '') {
      problems.push('missing removal trigger')
    }
    const key = `${rule}\u0000${path}`
    if (problems.length === 0 && seen.has(key)) problems.push('duplicate entry')
    if (problems.length > 0) {
      collector.report(
        'allowlist/invalid-entry',
        typeof path === 'string' ? path : '<allowlist>',
        `Invalid migration-debt allowlist entry: ${problems.join('; ')}.`,
        expected
      )
      continue
    }
    seen.add(key)
    valid.push(entry)
  }
  return valid
}

function toFileMap(files) {
  return files instanceof Map ? files : new Map(Object.entries(files))
}

/**
 * Run every deterministic Desktop architecture rule.
 *
 * @param {Map<string, string> | Record<string, string>} input source paths
 *   relative to apps/desktop (for example `src/main/index.ts`) mapped to content
 * @param {Array<{ rule: string, path: string, reason: string, removalTrigger: string }>} allowlist
 * @returns {{ ok: boolean, violations: Array<object> }}
 */
export function verifyDesktopArchitecture(input, allowlist = []) {
  const files = toFileMap(input)
  const resolve = createResolver(files)
  const collector = new Collector()
  const allowCollector = new Collector()
  const validEntries = validateAllowlist(allowlist, allowCollector)

  checkMainOwnership(files, collector)
  checkRegistrationDiscovery(files, collector)
  checkRegistrationModules(files, collector)
  checkMainImports(files, resolve, collector)
  checkSharedIpc(files, collector)
  checkSeamNameAgreement(files, collector)
  checkMainAdapterChannelPrefixes(files, collector)
  checkLegacyChannelPrefixes(files, collector)
  checkPreload(files, collector)
  checkRendererFeatures(files, resolve, collector)

  const ownershipFlagged = new Set(
    collector.violations.filter((v) => OWNERSHIP_RULES.has(v.rule)).map((v) => v.path)
  )
  const deduplicated = collector.violations.filter(
    (v) => OWNERSHIP_RULES.has(v.rule) || !ownershipFlagged.has(v.path)
  )

  const usedEntries = new Set()
  const remaining = deduplicated.filter((violation) => {
    const entry = validEntries.find(
      (candidate) => candidate.rule === violation.rule && candidate.path === violation.path
    )
    if (entry === undefined) return true
    usedEntries.add(entry)
    return false
  })

  for (const entry of validEntries) {
    if (!usedEntries.has(entry)) {
      allowCollector.report(
        'allowlist/unused-entry',
        entry.path,
        `Allowlist entry for rule "${entry.rule}" matches no violation.`,
        'The migration-debt allowlist only shrinks; remove entries once their debt is gone.'
      )
    }
  }

  const violations = [...remaining, ...allowCollector.violations].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.rule.localeCompare(b.rule) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.message.localeCompare(b.message)
  )
  return { ok: violations.length === 0, violations }
}

/** @param {Array<object>} violations */
export function formatViolations(violations) {
  return violations.map(
    (v) => `${v.rule}  ${v.path}${v.line ? `:${v.line}` : ''}\n  ${v.message} ${v.expected}`
  )
}
