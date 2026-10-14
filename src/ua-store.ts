/**
 * User-agent overrides: the per-variant file holding a user's edited UA
 * templates, one entry per slot.
 *
 * Why a plugin-owned file rather than a settings section: the settings sections
 * are statically-typed schemastery objects shared by `settings.yaml` and the
 * TUI, and a UA override is neither per-account nor part of that schema's
 * vocabulary — it is a diagnostic escape hatch for the day the upstream
 * changes what it expects. The saved-catalog, probe, and visibility stores
 * already persist this way, so this store follows them: version-tagged
 * document, atomic write with `0o600`, and a malformed file that reads as
 * "nothing overridden" rather than throwing.
 *
 * One file per variant, like the catalogs: the two products send different UAs
 * and the file is keyed by variant id inside one document, so a CN override can
 * never be sent to the international endpoint.
 *
 * **Not a place for secrets, and not a bypass.** The stored value is a header
 * string the plugin would otherwise compile in; tokens, prompts, and payloads
 * never touch it, and an override cannot widen what the plugin asks the
 * upstream for — it only changes how the client introduces itself.
 *
 * @module dsh-workbuddy-connect/ua-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { isUaSlot, type UaSlot } from './ua-template.ts'

/** On-disk format this reader accepts; other versions are discarded. */
const UA_FORMAT_VERSION = 1

/** Basename of the CN variant's UA-override file inside the Harness home. */
export const WORKBUDDY_UA_FILENAME = '.workbuddy-user-agent.json'

/** One variant's overrides: only the slots the user actually edited. */
type SavedUa = Partial<Record<UaSlot, string>>

interface UaDocument {
  version: typeof UA_FORMAT_VERSION
  /** Keyed by variant id (`workbuddy`, `workbuddy-ai`). */
  variants: Record<string, SavedUa>
}

/** Plugin-owned UA-override file path inside the Harness home. */
export function workbuddyUaPath(filename: string = WORKBUDDY_UA_FILENAME): string {
  return join(resolveDshHome(), filename)
}

/** Whether a parsed value is an override map this reader can trust. */
function isSaved(value: unknown): value is SavedUa {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  for (const [key, template] of Object.entries(value as Record<string, unknown>)) {
    if (!isUaSlot(key)) return false
    if (typeof template !== 'string') return false
  }
  return true
}

/** Options for {@link WorkBuddyUserAgentStore}. */
export interface WorkBuddyUserAgentStoreOptions {
  /** Explicit state-file path, overriding the `$DSH_HOME` default. */
  path?: string
}

/**
 * The per-variant UA overrides, read once and written atomically.
 *
 * An absent entry and a `{template: undefined}` entry mean the same thing —
 * "send the default" — so clearing an override deletes the key rather than
 * storing an empty string, and the file never accumulates blanks.
 *
 * A failed *write* propagates, exactly like the visibility store: a UA the user
 * believes they changed but that did not persist would be diagnosed as an
 * upstream problem. Reads stay forgiving — a corrupt file is "nothing
 * overridden", which only ever sends the default this plugin shipped with.
 */
export class WorkBuddyUserAgentStore {
  private readonly path: string
  private variants: Record<string, SavedUa> | undefined

  constructor(options: WorkBuddyUserAgentStoreOptions | string = {}) {
    this.path = typeof options === 'string'
      ? options
      : options.path ?? workbuddyUaPath()
  }

  /** Resolved state-file path, for the CLI and tests. */
  filePath(): string {
    return this.path
  }

  private load(): Record<string, SavedUa> {
    if (this.variants !== undefined) return this.variants
    const variants: Record<string, SavedUa> = {}
    if (existsSync(this.path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const document = parsed as Record<string, unknown>
          const raw = document['version'] === UA_FORMAT_VERSION ? document['variants'] : undefined
          if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
            for (const [variantId, value] of Object.entries(raw)) {
              if (isSaved(value)) variants[variantId] = value
            }
          }
        }
      } catch {
        // Corrupt or unreadable: treated as nothing overridden.
      }
    }
    this.variants = variants
    return variants
  }

  /** One variant's stored override for one slot, or undefined for the default. */
  override(variantId: string, slot: UaSlot): string | undefined {
    return this.load()[variantId]?.[slot]
  }

  /** Every stored override for one variant, as a copy. */
  overrides(variantId: string): SavedUa {
    return { ...this.load()[variantId] }
  }

  /**
   * Store or clear one slot's override, persisting before committing.
   *
   * `template === undefined` clears it. Throws when the write fails, leaving
   * the in-memory state untouched so a re-read cannot lie about what was
   * persisted — the caller reports the failure instead of answering "saved".
   */
  setOverride(variantId: string, slot: UaSlot, template: string | undefined): void {
    const variants = { ...this.load() }
    const current = { ...variants[variantId] }
    if (template === undefined) delete current[slot]
    else current[slot] = template
    if (Object.keys(current).length === 0) delete variants[variantId]
    else variants[variantId] = current
    this.persist(variants)
    this.variants = variants
  }

  /** Clear every override for one variant. */
  clear(variantId: string): void {
    const variants = { ...this.load() }
    if (variants[variantId] === undefined) return
    delete variants[variantId]
    this.persist(variants)
    this.variants = variants
  }

  private persist(variants: Record<string, SavedUa>): void {
    const directory = dirname(this.path)
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
    const document: UaDocument = { version: UA_FORMAT_VERSION, variants }
    const temporary = resolve(`${this.path}.tmp`)
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}
