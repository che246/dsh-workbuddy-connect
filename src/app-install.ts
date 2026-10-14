/**
 * The version of each installed WorkBuddy desktop app, read from the machine
 * the plugin is running on, for use in User-Agent strings and `X-IDE-Version`.
 *
 * **Why this module exists.** The upstream decides *which model roster to
 * return* by reading the client's User-Agent (see `ua-template.ts`), and the
 * official apps identify themselves with their own installed version. A
 * hardcoded version therefore drifts the moment the user updates the app — and
 * a drifted identity is exactly the situation that makes a model list look
 * wrong or empty. Reading the real version keeps the plugin's requests shaped
 * like the app's own.
 *
 * **Where the version comes from, in priority order.** Sources 1 and 2 are
 * verified against real installs on this machine (CN 5.5.4, international
 * 5.7.6); the first that answers wins:
 *
 * 1. **The bundled CLI's `product.json`** — `genieVersion`, and the same file
 *    carries `productName`, the token the app uses in its own User-Agent.
 *    Path: `<installRoot>/resources/app.asar.unpacked/cli/product.json`.
 * 2. **The Windows uninstall record's `DisplayVersion`**, matched by the same
 *    DisplayName pattern credential discovery already uses.
 * 3. **A macOS bundle's `Info.plist`** — `CFBundleShortVersionString`.
 * 4. **The last value this plugin successfully read**, cached under `$DSH_HOME`.
 * 5. **A compiled-in constant**, so a machine with no app still sends a
 *    well-formed User-Agent rather than no header.
 *
 * **Nothing here throws.** Every reader is best-effort and degrades to the next
 * source: a version is metadata for a request, never a reason to fail one.
 *
 * @module dsh-workbuddy-connect/app-install
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { FALLBACK_APP_VERSION } from './app-version.ts'
import { FALLBACK_CN_APP_VERSION } from './client-identity.ts'
import {
  parseWindowsRegistryOutput,
  WINDOWS_REGISTRY_ROOTS,
  WORKBUDDY_DISCOVERY_BUDGET_MS,
  workBuddyWindowsDiscoveryTools,
} from './desktop-credential-protection.ts'
import { electronProfileFor } from './variants.ts'
import type { WorkBuddyVariant } from './variants.ts'

/** Where a resolved version came from, for `doctor` and the card. */
export type InstalledVersionSource =
  /** The app's bundled `cli/product.json`. */
  | 'product-json'
  /** A Windows uninstall record's `DisplayVersion`. */
  | 'registry'
  /** A macOS `Info.plist`'s `CFBundleShortVersionString`. */
  | 'bundle'
  /** The last value this plugin successfully read. */
  | 'saved'
  /** The compiled-in constant; no app was found. */
  | 'fallback'

/** One product's installed version plus where it came from. */
export interface InstalledVersion {
  version: string
  source: InstalledVersionSource
  /** The product token the app calls itself, when the source declared one. */
  productName?: string
  /** The install directory the version was read from, when there was one. */
  installRoot?: string
}

/**
 * Versions this module accepts.
 *
 * The same shape the User-Agent validators use: dotted numerics, optionally
 * with a prerelease suffix. Anything else — `unknown`, an empty string, a
 * marketing name — is refused rather than interpolated into a header.
 */
export function validVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/u.test(value)
}

/**
 * Last-resort versions, used only when no app is installed at all.
 *
 * These are *shape* requirements, not currency claims. Measured on the
 * international endpoint: the version inside an App-shaped User-Agent is not
 * validated (`WorkBuddyAI/1.0.0` and `WorkBuddyAI/99.99.99` both return the
 * same 24-model document), so a machine without the app still gets a working
 * request. They are deliberately not used to infer anything about models.
 *
 * Re-exported from the modules that owned them rather than redeclared: two
 * constants meaning the same thing is how one of them drifts.
 */
export { FALLBACK_APP_VERSION } from './app-version.ts'
export { FALLBACK_CN_APP_VERSION } from './client-identity.ts'

/** Basename of the saved per-product version under `$DSH_HOME`. */
export const WORKBUDDY_INSTALLED_VERSION_FILENAME = '.workbuddy-installed-version.json'

/** Plugin-owned cache path inside the Harness home. */
export function installedVersionPath(filename: string = WORKBUDDY_INSTALLED_VERSION_FILENAME): string {
  return join(resolveDshHome(), filename)
}

/** One product's saved entry in the cache document. */
interface SavedVersion {
  version: string
  productName?: string
  installRoot?: string
  observedAtMs: number
}

interface SavedDocument {
  version: 1
  products: Record<string, SavedVersion>
}

/** The `product.json` fields this module reads. */
interface BundledProductJson {
  genieVersion?: unknown
  productName?: unknown
  productNameEn?: unknown
  applicationName?: unknown
}

/**
 * Read `<installRoot>/resources/app.asar.unpacked/cli/product.json`.
 *
 * The app's own statement of its identity: `genieVersion` is the installed
 * version, `productName` the token the app uses in its User-Agent. Verified on
 * this machine for both products — CN gives `5.5.4`/`WorkBuddy`, the
 * international build `5.7.6`/`WorkBuddy AI`.
 */
export function readBundledProductJson(installRoot: string): { version: string, productName?: string } | undefined {
  const path = join(installRoot, 'resources', 'app.asar.unpacked', 'cli', 'product.json')
  let document: BundledProductJson
  try {
    document = JSON.parse(readFileSync(path, 'utf8')) as BundledProductJson
  } catch {
    return undefined
  }
  if (typeof document !== 'object' || document === null) return undefined
  const version = document.genieVersion
  if (!validVersion(version)) return undefined
  // `productName` leads because it is what the app's own User-Agent uses; the
  // other two are fallbacks for a build that renames it.
  const name = [document.productName, document.productNameEn, document.applicationName]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '')
  return { version, ...name === undefined ? {} : { productName: name.trim() } }
}

/**
 * Read the app's bundled agent-CLI version.
 *
 * `cli/package.json` ships a `0.0.0` placeholder with the real version under
 * `publishConfig.customPackage.version`; a valid non-placeholder `version`
 * wins, otherwise the custom-package value applies, and unreadable or invalid
 * metadata yields `undefined` rather than a guess. This is the same rule
 * `client-identity.ts` applies to the same file — kept here as well so the
 * version reader is self-contained, and verified on this machine to give
 * 2.137.1 for CN and 2.156.0 for the international build.
 */
export function readBundledCliVersion(installRoot: string): string | undefined {
  const path = join(installRoot, 'resources', 'app.asar.unpacked', 'cli', 'package.json')
  let document: unknown
  try {
    document = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined
  const pkg = document as Record<string, unknown>
  const declared = pkg['version']
  if (validVersion(declared) && declared !== '0.0.0') return declared
  const custom = pkg['publishConfig']
  if (typeof custom !== 'object' || custom === null || Array.isArray(custom)) return undefined
  const customPackage = (custom as Record<string, unknown>)['customPackage']
  if (typeof customPackage !== 'object' || customPackage === null || Array.isArray(customPackage)) return undefined
  const version = (customPackage as Record<string, unknown>)['version']
  return validVersion(version) ? version : undefined
}

/** Read the `CFBundleShortVersionString` out of a macOS `Info.plist`. */export function readBundleVersion(plistPath: string): string | undefined {
  let text: string
  try {
    text = readFileSync(plistPath, 'utf8')
  } catch {
    return undefined
  }
  // Parsed by key rather than position: the plist holds several `<string>`
  // values, and a regex one key away would return the wrong one. A binary plist
  // has no `<dict>` text and is reported unreadable rather than guessed at.
  const match = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(text)
  const version = match?.[1]?.trim()
  return validVersion(version) ? version : undefined
}

/** macOS App-bundle roots, system-wide first then the user's own install. */
function macAppRoots(): string[] {
  return ['/Applications', join(homedir(), 'Applications')]
}

/** The `.app` bundle name for one product on macOS. */
function macBundleName(variant: Pick<WorkBuddyVariant, 'id'>): string {
  return variant.id === 'workbuddy' ? 'WorkBuddy.app' : 'WorkBuddy AI.app'
}

/**
 * Candidate install directories for one product.
 *
 * Windows: the registry's icon candidates first — that is where the app
 * actually is, even at a non-default path (issue #105) — then the documented
 * default location when one is measured. macOS: the two `/Applications` roots.
 * Linux has no verified discovery, so only an injected root contributes.
 */
export function installRootsFor(
  variant: WorkBuddyVariant,
  windowsIconCandidates: readonly string[] = [],
): string[] {
  const profile = electronProfileFor(variant)
  const roots: string[] = []
  for (const candidate of windowsIconCandidates) {
    // `<install>/WorkBuddy.exe` sits at the install root, so its parent is the
    // directory to probe for `resources/`.
    roots.push(join(candidate, '..'))
  }
  if (process.platform === 'darwin') {
    for (const root of macAppRoots()) roots.push(join(root, macBundleName(variant)))
  }
  if (process.platform === 'win32') {
    const segments = profile.windows.defaultPathSegments
    const localAppData = process.env['LOCALAPPDATA']?.trim()
    if (segments !== undefined && localAppData !== undefined && localAppData !== '') {
      roots.push(join(localAppData, ...segments.slice(0, -1)))
    }
  }
  return [...new Set(roots)]
}

/** Read the saved cache document, tolerating any malformation. */
function readSaved(path: string): Record<string, SavedVersion> {
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const document = parsed as Record<string, unknown>
    if (document['version'] !== 1) return {}
    const products = document['products']
    if (typeof products !== 'object' || products === null || Array.isArray(products)) return {}
    const result: Record<string, SavedVersion> = {}
    for (const [id, value] of Object.entries(products as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const entry = value as Record<string, unknown>
      if (!validVersion(entry['version'])) continue
      result[id] = {
        version: entry['version'],
        ...typeof entry['productName'] === 'string' && entry['productName'] !== ''
          ? { productName: entry['productName'] }
          : {},
        ...typeof entry['installRoot'] === 'string' && entry['installRoot'] !== ''
          ? { installRoot: entry['installRoot'] }
          : {},
        observedAtMs: typeof entry['observedAtMs'] === 'number' ? entry['observedAtMs'] : 0,
      }
    }
    return result
  } catch {
    return {}
  }
}

/** Persist the cache, best-effort: a read-only home is not a failure. */
function writeSaved(path: string, products: Record<string, SavedVersion>): void {
  try {
    const directory = join(path, '..')
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    const document: SavedDocument = { version: 1, products }
    const temporary = `${path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
  } catch {
    // Losing the memory of a version must never fail a request.
  }
}

/**
 * Read each product's `DisplayVersion` and icon path from the Windows
 * uninstall records.
 *
 * Returns the icon candidates (so `installRootsFor` can probe the real install
 * directory, wherever the user put it — issue #105) and the versions keyed by
 * the lower-cased icon path.
 *
 * Reuses `workBuddyWindowsDiscoveryTools()` — the very reader credential
 * discovery uses, including its `reg.exe`-then-PowerShell-5.1 encoding
 * fallback — rather than growing a second one. A second implementation would
 * be one Windows release away from disagreeing about where a product lives.
 *
 * Best-effort by construction: an unreadable root yields nothing rather than a
 * failure, because a version is metadata for a request and the next source in
 * the chain can answer instead.
 */
export async function readWindowsInstallRecords(
  variant: WorkBuddyVariant,
  signal: AbortSignal,
): Promise<{ iconCandidates: string[], versions: Map<string, string>, installRoots: string[] }> {
  const empty = { iconCandidates: [], versions: new Map<string, string>(), installRoots: [] }
  if (process.platform !== 'win32') return empty
  const tools = workBuddyWindowsDiscoveryTools()
  const pattern = electronProfileFor(variant).windows.displayNamePattern
  const versions = new Map<string, string>()
  const icons: string[] = []
  for (const root of WINDOWS_REGISTRY_ROOTS) {
    let output: string
    try {
      output = await tools.queryUninstallRoot(root, signal)
    } catch {
      continue
    }
    const parsed = parseWindowsRegistryOutput(output, pattern)
    icons.push(...parsed.candidates)
    for (const [key, version] of parsed.versions) versions.set(key, version)
  }
  const iconCandidates = [...new Set(icons)]
  return {
    iconCandidates,
    versions,
    installRoots: installRootsFor(variant, iconCandidates),
  }
}

/**
 * Resolve one product's version, reading the Windows registry when it has to.
 *
 * The async sibling of {@link resolveInstalledVersion}, for the case where the
 * registry has not been read yet. `index.ts` uses this once per product; the
 * synchronous version then serves the request path.
 */
export async function resolveInstalledVersionAsync(
  variant: WorkBuddyVariant,
  signal: AbortSignal,
  options: ResolveInstalledVersionOptions = {},
): Promise<InstalledVersion> {
  // A root that answers without the registry — macOS, or a caller that already
  // has candidates — never pays for a subprocess.
  const quick = resolveInstalledVersion(variant, options)
  if (quick.source !== 'fallback' && quick.source !== 'saved') {
    // macOS: the bundle answer is authoritative and needs no registry.
    if (process.platform !== 'win32' || quick.source === 'product-json') return quick
  }
  const records = await readWindowsInstallRecords(variant, signal)
  return resolveInstalledVersion(variant, {
    ...options,
    windowsIconCandidates: records.iconCandidates,
    registryVersions: records.versions,
  })
}

/** The compiled-in fallback for one product. */
export function fallbackVersionFor(variant: Pick<WorkBuddyVariant, 'id'>): string {
  return variant.id === 'workbuddy' ? FALLBACK_CN_APP_VERSION : FALLBACK_APP_VERSION
}

/** Constructor dependencies; every reader injectable so tests touch no real machine. */
export interface ResolveInstalledVersionOptions {
  /** Registry icon candidates, when a Windows discovery already produced them. */
  windowsIconCandidates?: readonly string[]
  /** Registry version by candidate path (lower-cased). */
  registryVersions?: ReadonlyMap<string, string>
  /** Saved-cache path; defaults to `$DSH_HOME/.workbuddy-installed-version.json`. */
  savedPath?: string
  /** Install-root discovery; defaults to {@link installRootsFor}. */
  installRoots?: (variant: WorkBuddyVariant) => readonly string[]
  /** `product.json` reader; defaults to {@link readBundledProductJson}. */
  readProductJson?: (installRoot: string) => { version: string, productName?: string } | undefined
  /** macOS plist reader; defaults to {@link readBundleVersion}. */
  readBundle?: (plistPath: string) => string | undefined
  /** Whether an install root looks like this product's; defaults to a stat of its exe. */
  looksInstalled?: (variant: WorkBuddyVariant, installRoot: string) => boolean
}

/**
 * Resolve one product's installed version, best source first.
 *
 * Never throws, and never returns an unusable version: every candidate is
 * validated before it is accepted, so a malformed `product.json` degrades to
 * the next source rather than reaching a header.
 */
export function resolveInstalledVersion(
  variant: WorkBuddyVariant,
  options: ResolveInstalledVersionOptions = {},
): InstalledVersion {
  const roots = (options.installRoots ?? (v => installRootsFor(v, options.windowsIconCandidates ?? [])))(variant)

  // 1. The app's own `product.json`.
  const readProduct = options.readProductJson ?? readBundledProductJson
  for (const root of roots) {
    const product = readProduct(root)
    if (product !== undefined && validVersion(product.version)) {
      return {
        version: product.version,
        source: 'product-json',
        ...product.productName === undefined ? {} : { productName: product.productName },
        installRoot: root,
      }
    }
  }

  // 2. A Windows uninstall record's DisplayVersion, keyed by the icon path the
  //    credential discovery already matched.
  if (options.registryVersions !== undefined) {
    const exeBasename = electronProfileFor(variant).windows.exeBasename
    for (const root of roots) {
      const version = options.registryVersions.get(join(root, exeBasename).toLowerCase())
      if (validVersion(version)) return { version, source: 'registry', installRoot: root }
    }
  }

  // 3. A macOS bundle's plist — the verified source on that platform.
  if (process.platform === 'darwin') {
    const read = options.readBundle ?? readBundleVersion
    for (const root of macAppRoots()) {
      const bundle = join(root, macBundleName(variant))
      const version = read(join(bundle, 'Contents', 'Info.plist'))
      if (validVersion(version)) return { version, source: 'bundle', installRoot: bundle }
    }
  }

  // 4. What this plugin last read successfully.
  const saved = readSaved(options.savedPath ?? installedVersionPath())[variant.id]
  if (saved !== undefined && validVersion(saved.version)) {
    return {
      version: saved.version,
      source: 'saved',
      ...saved.productName === undefined ? {} : { productName: saved.productName },
      ...saved.installRoot === undefined ? {} : { installRoot: saved.installRoot },
    }
  }

  // 5. The compiled-in value, so a machine with no app still sends a valid UA.
  return { version: fallbackVersionFor(variant), source: 'fallback' }
}

/** Remember a version that was read from the machine, best-effort. */
export function rememberInstalledVersion(variantId: string, info: InstalledVersion, path?: string): void {
  // `saved` and `fallback` are what the cache already held (or less), so
  // writing them back would only churn the file.
  if (info.source === 'saved' || info.source === 'fallback') return
  const file = path ?? installedVersionPath()
  const products = readSaved(file)
  products[variantId] = {
    version: info.version,
    ...info.productName === undefined ? {} : { productName: info.productName },
    ...info.installRoot === undefined ? {} : { installRoot: info.installRoot },
    observedAtMs: Date.now(),
  }
  writeSaved(file, products)
}

/**
 * The process-wide cache, holding the *promise* of each product's identity.
 *
 * Caching the promise rather than the value makes the first call the
 * single-flight one, so concurrent callers share one resolution.
 *
 * **Nothing on a request path may await this lazily.** On Windows the
 * resolution may spawn `reg.exe`, which takes seconds; awaiting that inside a
 * chat or catalog request would put that latency on the user's first message.
 * `index.ts` therefore *starts* the resolution when the provider registers and
 * lets requests read whatever has landed: until it does, {@link installedIdentityNow}
 * answers from the identity chain, which is exactly what the plugin sent before
 * this module existed.
 */
const versionCache = new Map<string, Promise<InstalledVersion>>()
/** The last value that finished resolving, for the synchronous request path. */
const resolvedVersion = new Map<string, InstalledVersion>()

/** Begin resolving one product's identity, without waiting for it. */
export function beginInstalledIdentity(
  variant: WorkBuddyVariant,
  options: ResolveInstalledVersionOptions = {},
): void {
  void installedIdentity(variant, options)
}

/**
 * Read one product's identity, resolving it once per process.
 *
 * Never rejects: a failing reader degrades to the next source inside
 * {@link resolveInstalledVersionAsync}, and this wrapper is the last line of
 * defence so a caller can await it unconditionally.
 */
export function installedIdentity(
  variant: WorkBuddyVariant,
  options: ResolveInstalledVersionOptions = {},
): Promise<InstalledVersion> {
  const cached = versionCache.get(variant.id)
  if (cached !== undefined) return cached
  const pending = (async (): Promise<InstalledVersion> => {
    const controller = new AbortController()
    // Bounded: a Windows registry enumeration that hangs must not hold anything
    // forever. The budget matches credential discovery's, so the two agree on
    // how long "we could not read the machine" may take.
    const timer = setTimeout(() => controller.abort(), WORKBUDDY_DISCOVERY_BUDGET_MS)
    try {
      const info = await resolveInstalledVersionAsync(variant, controller.signal, options)
      rememberInstalledVersion(variant.id, info, options.savedPath)
      resolvedVersion.set(variant.id, info)
      return info
    } catch {
      const info: InstalledVersion = { version: fallbackVersionFor(variant), source: 'fallback' }
      resolvedVersion.set(variant.id, info)
      return info
    } finally {
      clearTimeout(timer)
    }
  })()
  versionCache.set(variant.id, pending)
  return pending
}

/**
 * The identity as it stands *right now*, for a synchronous request path.
 *
 * Returns `undefined` while the first resolution is still in flight, so the
 * caller falls back to the identity chain rather than blocking on a subprocess.
 * Once anything has resolved — including the "no app here" answer — this always
 * answers, so a request never pays for a second read.
 */
export function installedIdentityNow(variant: Pick<WorkBuddyVariant, 'id'>): InstalledVersion | undefined {
  return resolvedVersion.get(variant.id)
}

/** Drop the cache, so the next read re-resolves (the card's Refresh does this). */
export function forgetInstalledIdentity(variantId?: string): void {
  if (variantId === undefined) {
    versionCache.clear()
    resolvedVersion.clear()
  } else {
    versionCache.delete(variantId)
    resolvedVersion.delete(variantId)
  }
}
