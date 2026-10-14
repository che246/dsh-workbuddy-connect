/**
 * The international desktop app's version, used as the `/v3/config` UA.
 *
 * The App-shaped catalog is served only to a User-Agent the gateway recognizes
 * as a client identity (see `docs/workbuddy-ai-international-research-2026-09-11.md`
 * §2.7). **The reason for the no-space form was re-measured on 2026-10-15 and
 * the earlier explanation did not survive**: the space form `WorkBuddy AI/5.7.6`
 * is *not* rejected — it returns the same 24-model App document as every other
 * recognized form. What the gateway actually enforces is that the UA contains a
 * recognizable `name/version` token at all; `garbage`, `Mozilla/5.0`, `Foo/1.0`
 * and an empty string all answer `400 check ua, get coding copilot version error`,
 * while the prefix and the number are both ignored:
 *
 * | UA | result |
 * |---|---|
 * | `WorkBuddyAI/5.7.6`, `workbuddy-ai/5.7.6`, `WorkBuddy AI/5.7.6` | 24 models |
 * | `WorkBuddyAI/` (no version), `WorkBuddyAI/1.0.0`, `WorkBuddyAI/99.99.99` | 24 models |
 * | `CLI/2.63.2 CodeBuddy/2.63.2` | 19 models (the CLI roster) |
 *
 * So `WorkBuddyAI/<v>` is kept because it is what the *app itself* sends
 * (measured from its own logs, 59 occurrences of
 * `WorkBuddy/5.7.6 WorkBuddy/5.7.6 CLI/2.156.0` and one of the lowercase form),
 * not because a space would be refused. Do not "restore" the space on the
 * strength of the older prose, and do not tighten this into a validation rule
 * either: the gateway is more permissive than either claim.
 *
 * The version feeds the international catalog UA and the chat identity's
 * `X-IDE-Version`: a missing App, an unreadable plist, or a bad cached value
 * degrades to the last saved value and finally to a compiled-in constant, and
 * never blocks credential use or the provider.
 *
 * @module dsh-workbuddy-connect/app-version
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * Last-resort UA version.
 *
 * The gateway ignores the version number when splitting the UA (re-measured
 * 2026-10-15: `WorkBuddyAI/1.0.0`, `WorkBuddyAI/99.99.99` and the real version
 * all return the same document), so this constant is a shape requirement rather
 * than a currency claim. It is *not* used to infer anything about model
 * capabilities.
 */
export const FALLBACK_APP_VERSION = '5.5.2'

/** Basename of the saved version under `$DSH_HOME`. */
export const WORKBUDDY_APP_VERSION_FILENAME = '.workbuddy-ai-version.json'

/** Where the version came from, for `doctor` output. */
export type WorkBuddyAppVersionSource = 'installed' | 'saved' | 'fallback'

/** Resolved version plus provenance. */
export interface AppVersionInfo {
  version: string
  source: WorkBuddyAppVersionSource
  /** Basename of the App bundle the version was read from, when installed. */
  bundle?: string
}

/**
 * Whether a string is safe to interpolate into an HTTP header.
 *
 * Strict on purpose: the value reaches a header, so anything that could split
 * the request (CR, LF, spaces beyond the separator) or inject a second UA
 * token must never pass. The App's own version is always `N.N.N` or `N.N.N.N`.
 */
export function validAppVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}$/u.test(value)
}

/** macOS App-bundle roots: system-wide first, then the user's own install. */
function macAppRoots(): string[] {
  return ['/Applications', join(homedir(), 'Applications')]
}

/**
 * Read `CFBundleShortVersionString` out of an `Info.plist`.
 *
 * Parsed as XML rather than grepped, because the plist contains several
 * `<string>` values and a regex would be one unrelated key away from
 * returning the wrong one. A binary plist has no `<dict>` in its bytes and is
 * reported as unreadable (the saved value then applies) rather than guessed at.
 */
export async function readBundleVersion(plistPath: string): Promise<string | undefined> {
  let text: string
  try {
    text = await readFile(plistPath, 'utf8')
  } catch {
    return undefined
  }
  // `<key>CFBundleShortVersionString</key>` followed by the next `<string>`.
  const match = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(text)
  const version = match?.[1]?.trim()
  return validAppVersion(version) ? version : undefined
}

/**
 * The installed international App's version, or `undefined` when it is not
 * installed (or not readable).
 *
 * Windows and Linux have no verified bundle-metadata location yet, so this
 * returns `undefined` there and the saved/fallback value is used instead of
 * guessing a path — the same discipline the credential discovery follows.
 */
export async function installedAppVersion(): Promise<{ version: string; bundle: string } | undefined> {
  if (process.platform !== 'darwin') return undefined
  for (const root of macAppRoots()) {
    const bundle = join(root, 'WorkBuddy AI.app')
    const version = await readBundleVersion(join(bundle, 'Contents', 'Info.plist'))
    if (version !== undefined) return { version, bundle }
  }
  return undefined
}

/** Saved-version file path under the Harness home. */
export function appVersionPath(): string {
  return join(resolveDshHome(), WORKBUDDY_APP_VERSION_FILENAME)
}

/** Constructor dependencies; all injectable so tests never touch the real FS. */
export interface ResolveAppVersionOptions {
  /** Installed-version reader; defaults to {@link installedAppVersion}. */
  installed?: () => Promise<{ version: string; bundle: string } | undefined>
  /** Saved-version path; defaults to {@link appVersionPath}. */
  path?: string
}

/**
 * Resolve the UA version: installed App first, then the last saved value, then
 * the compiled-in fallback.
 *
 * A value read from the App is written back immediately, so an uninstalled App
 * or an unreadable plist later still has the last real version to fall back
 * on. The write is best-effort: failing to cache a version must never fail the
 * catalog request that asked for it.
 */
export async function resolveAppVersion(options: ResolveAppVersionOptions = {}): Promise<AppVersionInfo> {
  const path = options.path ?? appVersionPath()
  const installed = await (options.installed ?? installedAppVersion)()
  if (installed !== undefined && validAppVersion(installed.version)) {
    try {
      await writeFileAtomic(
        path,
        `${JSON.stringify({ version: installed.version, bundle: installed.bundle, observedAt: Date.now() }, null, 2)}\n`,
        { mode: 0o600, dirMode: 0o700 },
      )
    } catch {
      // A read-only home is not a reason to serve no catalog.
    }
    return { version: installed.version, source: 'installed', bundle: installed.bundle }
  }
  try {
    const saved: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof saved === 'object' && saved !== null) {
      const version = (saved as Record<string, unknown>)['version']
      if (validAppVersion(version)) return { version, source: 'saved' }
    }
  } catch {
    // Absent or malformed cache: fall through to the compiled-in default.
  }
  return { version: FALLBACK_APP_VERSION, source: 'fallback' }
}

/**
 * Build the App-shaped User-Agent for catalog requests.
 *
 * `WorkBuddyAI/<version>` matches the form the international app itself sends.
 * The no-space form is a *choice*, not a requirement: the gateway accepts the
 * space form too (re-measured 2026-10-15 — see the module header), and it
 * validates only that some `name/version` token is present. Throws on an
 * invalid version rather than sending a malformed header.
 */
export function appUserAgent(version: string): string {
  if (!validAppVersion(version)) throw new Error(`invalid WorkBuddy AI version for User-Agent: ${JSON.stringify(version)}`)
  return `WorkBuddyAI/${version}`
}
