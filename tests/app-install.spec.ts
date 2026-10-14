import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FALLBACK_APP_VERSION,
  FALLBACK_CN_APP_VERSION,
  forgetInstalledIdentity,
  installedIdentityNow,
  readBundledCliVersion,
  readBundledProductJson,
  readBundleVersion,
  rememberInstalledVersion,
  resolveInstalledVersion,
  validVersion,
} from '../src/app-install.ts'
import { AI_VARIANT, CN_VARIANT } from '../src/variants.ts'

/**
 * Reading each installed app's version from the machine it runs on.
 *
 * Why this matters enough to test carefully: the upstream decides which model
 * roster to return by reading the User-Agent, and the official apps identify
 * themselves with their own installed version. A hardcoded version drifts the
 * moment the user updates the app.
 *
 * Everything here is injected, so no test touches a real install or spawns a
 * registry read. The *real* discovery is exercised by `user-agent.spec.ts`'s
 * live matrix and by the machine-level verification recorded in the commit.
 */

const CLEANUP: (() => void)[] = []

afterEach(() => {
  for (const clean of CLEANUP.splice(0)) clean()
  forgetInstalledIdentity()
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  CLEANUP.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Materialize a fake install tree carrying the two JSON files. */
function fakeInstall(product: unknown, cliPackage?: unknown): string {
  const root = tempDir('wb-install-')
  const cliDir = join(root, 'resources', 'app.asar.unpacked', 'cli')
  mkdirSync(cliDir, { recursive: true })
  if (product !== undefined) writeFileSync(join(cliDir, 'product.json'), JSON.stringify(product), 'utf8')
  if (cliPackage !== undefined) writeFileSync(join(cliDir, 'package.json'), JSON.stringify(cliPackage), 'utf8')
  return root
}

describe('validVersion', () => {
  it('accepts dotted numerics, with or without a prerelease suffix', () => {
    expect(validVersion('5.7.6')).toBe(true)
    expect(validVersion('5.5.4.1')).toBe(true)
    expect(validVersion('2.156.0-rc.1')).toBe(true)
  })

  it('refuses anything that could not go in a header', () => {
    expect(validVersion('unknown')).toBe(false)
    expect(validVersion('')).toBe(false)
    expect(validVersion(undefined)).toBe(false)
    expect(validVersion(5.7)).toBe(false)
    expect(validVersion('5.7.6\r\nX: 1')).toBe(false)
  })
})

describe('readBundledProductJson', () => {
  it('reads genieVersion and productName from the app\'s own file', () => {
    const root = fakeInstall({ genieVersion: '5.7.6', productName: 'WorkBuddy AI' })
    expect(readBundledProductJson(root)).toEqual({ version: '5.7.6', productName: 'WorkBuddy AI' })
  })

  it('falls back through the alternative name fields', () => {
    // A build that renames the token still identifies itself.
    expect(readBundledProductJson(fakeInstall({ genieVersion: '1.0.0', productNameEn: 'WorkBuddy AI' })))
      .toEqual({ version: '1.0.0', productName: 'WorkBuddy AI' })
    expect(readBundledProductJson(fakeInstall({ genieVersion: '1.0.0', applicationName: 'workbuddy-ai' })))
      .toEqual({ version: '1.0.0', productName: 'workbuddy-ai' })
  })

  it('yields undefined for a missing, malformed, or versionless file', () => {
    expect(readBundledProductJson(join(tempDir('wb-none-'), 'absent'))).toBeUndefined()
    expect(readBundledProductJson(fakeInstall({ genieVersion: 'not-a-version' }))).toBeUndefined()
    expect(readBundledProductJson(fakeInstall({ productName: 'WorkBuddy' }))).toBeUndefined()
  })
})

describe('readBundledCliVersion', () => {
  it('prefers a real version and otherwise reads the custom-package one', () => {
    // The shipped file carries a `0.0.0` placeholder with the real value under
    // publishConfig.customPackage — verified on this machine at 2.137.1 and
    // 2.156.0.
    expect(readBundledCliVersion(fakeInstall({}, { version: '2.156.0' }))).toBe('2.156.0')
    expect(readBundledCliVersion(fakeInstall({}, {
      version: '0.0.0',
      publishConfig: { customPackage: { version: '2.137.1' } },
    }))).toBe('2.137.1')
  })

  it('yields undefined rather than guessing', () => {
    expect(readBundledCliVersion(join(tempDir('wb-none-'), 'absent'))).toBeUndefined()
    expect(readBundledCliVersion(fakeInstall({}, { version: '0.0.0' }))).toBeUndefined()
    expect(readBundledCliVersion(fakeInstall({}, { version: 'oops' }))).toBeUndefined()
  })
})

describe('readBundleVersion', () => {
  it('reads the keyed value, not the first <string> in the plist', () => {
    const dir = tempDir('wb-plist-')
    const plist = join(dir, 'Info.plist')
    writeFileSync(plist, [
      '<plist><dict>',
      '<key>CFBundleName</key><string>WorkBuddy AI</string>',
      '<key>CFBundleShortVersionString</key><string>5.7.6</string>',
      '</dict></plist>',
    ].join('\n'), 'utf8')
    expect(readBundleVersion(plist)).toBe('5.7.6')
  })

  it('yields undefined for a missing or binary plist', () => {
    expect(readBundleVersion('/nonexistent/Info.plist')).toBeUndefined()
    const binary = join(tempDir('wb-bin-'), 'Info.plist')
    writeFileSync(binary, Buffer.from([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x00]))
    expect(readBundleVersion(binary)).toBeUndefined()
  })
})

describe('resolveInstalledVersion', () => {
  const roots = (dirs: string[]) => () => dirs

  it('prefers the app\'s own product.json', () => {
    const root = fakeInstall({ genieVersion: '5.7.6', productName: 'WorkBuddy AI' })
    const info = resolveInstalledVersion(AI_VARIANT, { installRoots: roots([root]) })
    expect(info).toMatchObject({ version: '5.7.6', source: 'product-json', productName: 'WorkBuddy AI' })
  })

  it('falls through to the registry when product.json is unreadable', () => {
    // Issue #105: a product installed anywhere but the documented default is
    // only findable through its uninstall record — this machine's CN app lives
    // in `C:\Program Files`, exactly that case.
    const root = tempDir('wb-empty-')
    const exe = join(root, 'WorkBuddy.exe')
    writeFileSync(exe, '', 'utf8')
    const info = resolveInstalledVersion(CN_VARIANT, {
      installRoots: roots([root]),
      registryVersions: new Map([[exe.toLowerCase(), '5.5.4']]),
    })
    expect(info).toMatchObject({ version: '5.5.4', source: 'registry', installRoot: root })
  })

  it('falls through to the saved value when the app is gone', () => {
    const dir = tempDir('wb-saved-')
    const savedPath = join(dir, 'versions.json')
    writeFileSync(savedPath, JSON.stringify({
      version: 1,
      products: {
        'workbuddy-ai': { version: '5.7.6', productName: 'WorkBuddy AI', observedAtMs: 1 },
      },
    }), 'utf8')
    const info = resolveInstalledVersion(AI_VARIANT, { installRoots: roots([]), savedPath })
    expect(info).toMatchObject({ version: '5.7.6', source: 'saved', productName: 'WorkBuddy AI' })
  })

  it('falls through to the compiled-in constant on a machine with no app', () => {
    // A shape requirement, not a currency claim: this is what keeps a request
    // well-formed when nothing is installed. The upstream does not validate the
    // number inside an App-shaped UA (measured).
    const savedPath = join(tempDir('wb-none-'), 'absent.json')
    expect(resolveInstalledVersion(CN_VARIANT, { installRoots: roots([]), savedPath }))
      .toMatchObject({ version: FALLBACK_CN_APP_VERSION, source: 'fallback' })
    expect(resolveInstalledVersion(AI_VARIANT, { installRoots: roots([]), savedPath }))
      .toMatchObject({ version: FALLBACK_APP_VERSION, source: 'fallback' })
  })

  it('never returns an unusable version, whatever the sources say', () => {
    // Every candidate is validated before acceptance, so a malformed file
    // degrades to the next source rather than reaching a header.
    const bad = fakeInstall({ genieVersion: 'v-next' })
    const info = resolveInstalledVersion(AI_VARIANT, {
      installRoots: roots([bad]),
      savedPath: join(tempDir('wb-none-'), 'absent.json'),
    })
    expect(validVersion(info.version)).toBe(true)
    expect(info.source).toBe('fallback')
  })

  it('keeps the two products independent', () => {
    // The two apps are separate installs at separate versions; mixing them
    // would label one product's request with the other's release.
    const cn = fakeInstall({ genieVersion: '5.5.4', productName: 'WorkBuddy' })
    const intl = fakeInstall({ genieVersion: '5.7.6', productName: 'WorkBuddy AI' })
    expect(resolveInstalledVersion(CN_VARIANT, { installRoots: roots([cn]) }))
      .toMatchObject({ version: '5.5.4', productName: 'WorkBuddy' })
    expect(resolveInstalledVersion(AI_VARIANT, { installRoots: roots([intl]) }))
      .toMatchObject({ version: '5.7.6', productName: 'WorkBuddy AI' })
  })
})

describe('rememberInstalledVersion', () => {
  it('persists what it read, and a later read survives the app going away', () => {
    const dir = tempDir('wb-rem-')
    const savedPath = join(dir, 'versions.json')
    rememberInstalledVersion('workbuddy-ai', {
      version: '5.7.6',
      source: 'product-json',
      productName: 'WorkBuddy AI',
      installRoot: '/gone',
    }, savedPath)
    const document = JSON.parse(readFileSync(savedPath, 'utf8')) as { products: Record<string, { version: string }> }
    expect(document.products['workbuddy-ai']!.version).toBe('5.7.6')
    expect(resolveInstalledVersion(AI_VARIANT, { installRoots: () => [], savedPath }))
      .toMatchObject({ version: '5.7.6', source: 'saved' })
  })

  it('does not write a fallback or a saved value back to the file', () => {
    // `fallback` and `saved` are what the cache already held (or less); writing
    // them would only churn the file.
    const dir = tempDir('wb-rem2-')
    const savedPath = join(dir, 'versions.json')
    rememberInstalledVersion('workbuddy', { version: '5.5.6', source: 'fallback' }, savedPath)
    rememberInstalledVersion('workbuddy', { version: '9.9.9', source: 'saved' }, savedPath)
    expect(() => readFileSync(savedPath, 'utf8')).toThrow()
  })
})

describe('installedIdentityNow', () => {
  it('answers nothing before a resolution lands, so no request waits for one', () => {
    // The whole reason this seam exists: on Windows the resolution may spawn
    // `reg.exe`, which takes seconds. A chat message must never wait for that,
    // so the request path reads only what already landed.
    forgetInstalledIdentity()
    expect(installedIdentityNow(AI_VARIANT)).toBeUndefined()
    expect(installedIdentityNow(CN_VARIANT)).toBeUndefined()
  })
})
