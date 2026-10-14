/**
 * User-agent templates: the shape of every UA this plugin sends, plus the
 * placeholder expansion and validation that let a user replace them.
 *
 * Three slots cover every request the plugin makes, because the upstream keys
 * on client identity in three different ways and each one has to stay
 * internally consistent:
 *
 * - `catalog` — the `GET /v3/config` model-list request. The gateway splits
 *   that document by UA: a UA carrying a `CLI/…` segment *together with* a
 *   `CodeBuddy/…` segment yields the CLI roster, any other recognized
 *   `name/version` token yields the App roster. Measured on 2026-10-15: 19
 *   models for the CLI form, 24 for every App-shaped form, and `400 check ua,
 *   get coding copilot version error` for a UA with no recognizable token at
 *   all. The version numbers themselves are not validated.
 * - `chat` — chat streaming and the reasoning-effort probe, which present as
 *   the desktop client (`WorkBuddy/<v> <product>/<v> CLI/<cli>`).
 * - `shared` — token refresh and the CN console/badge read, which have always
 *   sent one CLI-form UA.
 *
 * **Why templates rather than free text.** Several parts of a UA are facts the
 * plugin reads from the installed app (its version, its bundled CLI version),
 * and one part names the product. A literal string would freeze today's facts
 * into a file and rot; a template keeps the user in control of the *shape*
 * while the plugin keeps supplying the values. Each default template expands to
 * the UA this plugin sent before the placeholder became editable, with the
 * versions taken from the local install rather than from a release constant.
 *
 * This module is deliberately Node-free: the browser half imports it to render
 * the live preview, so it must stay loadable from the client bundle.
 *
 * @module dsh-workbuddy-connect/ua-template
 */

/** The two products the plugin serves. Kept local so this module stays Node-free. */
export type UaRegion = 'cn' | 'global'

/** Which UA a request family sends. */
export const UA_SLOTS = ['catalog', 'chat', 'shared'] as const

/** One UA slot's name. */
export type UaSlot = typeof UA_SLOTS[number]

/** Whether a value names a slot this module knows. */
export function isUaSlot(value: unknown): value is UaSlot {
  return typeof value === 'string' && (UA_SLOTS as readonly string[]).includes(value)
}

/**
 * Placeholders a template may use.
 *
 * `appVersion` and `cliVersion` come from the installed app through
 * `app-install.ts`, falling back to `client-identity.ts`; `product` names the
 * product the app calls itself, or the region's conventional spelling. An
 * unavailable placeholder drops its whole whitespace-delimited token rather
 * than leaving `CLI/` behind — that is the official client's own rule for a
 * missing extension, and it is what a *user-written* template relies on.
 *
 * A shipped default is held to a stricter rule: see
 * {@link templateResolvesCompletely} for why a half-expanded default is never
 * sent, and how measurement forced that.
 */
export const UA_PLACEHOLDERS = ['appVersion', 'cliVersion', 'product'] as const

/** One placeholder's name. */
export type UaPlaceholder = typeof UA_PLACEHOLDERS[number]

/** Longest template accepted; real ones are well under 100 characters. */
export const UA_MAX_TEMPLATE_LENGTH = 512

/** Values the placeholders expand to. */
export interface UaContext {
  /** Desktop app version, e.g. `5.7.6`. */
  appVersion?: string | undefined
  /** The app's bundled agent-CLI version, when it could be read. */
  cliVersion?: string | undefined
  /** The region's product token, e.g. `WorkBuddy AI`. */
  product?: string | undefined
}

/** Why a template was refused. */
export type UaTemplateError =
  | 'empty'
  | 'control-char'
  | 'too-long'
  | 'unknown-placeholder'

const PLACEHOLDER_PATTERN = /\{([A-Za-z]+)\}/gu

/**
 * The default template for one slot and region.
 *
 * These reproduce what this plugin sent before it became editable, except that
 * every version is now a placeholder the host fills from the *installed app*
 * (`app-install.ts`) rather than a constant compiled into a release. That is
 * the point: the upstream reads the User-Agent to decide which model roster to
 * return, and the official apps identify themselves with their own installed
 * version — so a frozen version drifts the moment the user updates the app.
 *
 * The CN model list keeps the CLI identity its own chat requests use, so the
 * roster it advertises is the one those requests can use; the international
 * document is served to an App-shaped UA. Measured on this machine with the
 * real apps: CN 5.5.4 and international 5.7.6 both work in their own slots.
 */
export function defaultUaTemplate(slot: UaSlot, region: UaRegion): string {
  if (slot === 'chat') {
    return 'WorkBuddy/{appVersion} {product}/{appVersion} CLI/{cliVersion}'
  }
  if (slot === 'catalog') {
    // CN asks with the CLI form its chat path also presents; the international
    // endpoint answers an App-shaped UA. Both take the local install's version.
    return region === 'global' ? 'WorkBuddyAI/{appVersion}' : 'CLI/{cliVersion} CodeBuddy/{appVersion}'
  }
  return 'CLI/{cliVersion} CodeBuddy/{appVersion}'
}

/**
 * Whether a template may be stored and sent.
 *
 * Strict on purpose: this string is interpolated into an HTTP header, so
 * anything that could split the request (CR, LF, other control characters) must
 * never pass, and an unknown `{name}` is refused rather than left literal — a
 * typo would otherwise reach the wire looking like syntax the gateway may act
 * on.
 */
export function validateUaTemplate(template: string): UaTemplateError | undefined {
  if (template.trim() === '') return 'empty'
  if (template.length > UA_MAX_TEMPLATE_LENGTH) return 'too-long'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/u.test(template)) return 'control-char'
  let match: RegExpExecArray | null
  const pattern = new RegExp(PLACEHOLDER_PATTERN.source, 'gu')
  while ((match = pattern.exec(template)) !== null) {
    if (!(UA_PLACEHOLDERS as readonly string[]).includes(match[1] as string)) {
      return 'unknown-placeholder'
    }
  }
  return undefined
}

/**
 * Expand one template.
 *
 * A token that still carries an unresolved placeholder after substitution is
 * dropped whole, then surviving tokens are joined by single spaces — so
 * `WorkBuddy/{appVersion} CLI/{cliVersion}` with no CLI version yields
 * `WorkBuddy/5.5.6`, never `WorkBuddy/5.5.6 CLI/`. Whitespace in the template
 * is normalized, because a UA with a stray double space is a different string
 * to anything matching on it.
 */
export function expandUaTemplate(template: string, context: UaContext): string {
  const tokens = template.trim().split(/\s+/u)
  const kept: string[] = []
  for (const token of tokens) {
    let unresolved = false
    const expanded = token.replace(PLACEHOLDER_PATTERN, (_whole, name: string) => {
      if (name === 'appVersion') {
        if (context.appVersion === undefined || context.appVersion === '') unresolved = true
        return context.appVersion ?? ''
      }
      if (name === 'cliVersion') {
        if (context.cliVersion === undefined || context.cliVersion === '') unresolved = true
        return context.cliVersion ?? ''
      }
      if (name === 'product') {
        if (context.product === undefined || context.product === '') unresolved = true
        return context.product ?? ''
      }
      unresolved = true
      return ''
    })
    if (unresolved || expanded === '') continue
    kept.push(expanded)
  }
  return kept.join(' ')
}

/**
 * The compiled-in UA every slot falls back to when no template can expand.
 *
 * Reachable in two situations, both of which want the value this plugin has
 * always sent: a context carrying no version at all, and a default template
 * whose placeholders cannot all be filled on this machine. Sending a
 * half-expanded default would be worse — see {@link templateResolvesCompletely}.
 */
export const UA_SHARED_FALLBACK = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** The literal the App-shaped catalog UA carried before it became a template. */
export const UA_APP_FALLBACK_VERSION = '5.5.2'

/**
 * Whether every placeholder in a template found a value.
 *
 * Used to protect the *shipped defaults*. A template with a placeholder missing
 * expands to a short string that was never tested against the upstream, and
 * measurement shows those degradations are not benign: on the CN model-list
 * endpoint, `CodeBuddy/5.5.4` (the shipped default minus its `CLI/…` segment)
 * answers HTTP 200 with a document that has no `cli` roster at all — a silent
 * wrong answer — while `CLI/2.137.1` alone is a hard 400. So when the default
 * cannot be reproduced faithfully from this machine's values, the compiled-in
 * literal is sent instead.
 *
 * A *user* override is deliberately not subject to this: someone editing the
 * field has chosen the shape, and the documented drop-the-token rule is what
 * lets them build a template that tolerates a missing CLI version.
 */
export function templateResolvesCompletely(template: string, context: UaContext): boolean {
  const pattern = new RegExp(PLACEHOLDER_PATTERN.source, 'gu')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(template)) !== null) {
    const name = match[1]
    const value = name === 'appVersion'
      ? context.appVersion
      : name === 'cliVersion' ? context.cliVersion : name === 'product' ? context.product : undefined
    if (value === undefined || value === '') return false
  }
  return true
}

/**
 * The UA to actually send.
 *
 * Degradation order: the stored override when it is still valid and expands to
 * something → the slot's default template, but only when it expands
 * *completely* → the compiled-in literal. The completeness condition is the
 * difference between a graceful fallback and a silent wrong answer; see
 * {@link templateResolvesCompletely}.
 */
export function resolveUserAgent(
  override: string | undefined,
  defaults: { template: string; fallback: string },
  context: UaContext,
): string {
  if (override !== undefined && validateUaTemplate(override) === undefined) {
    const expanded = expandUaTemplate(override, context)
    if (expanded !== '') return expanded
  }
  if (templateResolvesCompletely(defaults.template, context)) {
    const fromDefault = expandUaTemplate(defaults.template, context)
    if (fromDefault !== '') return fromDefault
  }
  return defaults.fallback
}

/** One slot's effective state, as both the wire and the card need it. */
export interface UaSlotPlan {
  slot: UaSlot
  /** The template in effect: the override when one is stored, else the default. */
  template: string
  /** The template this plugin ships with for this slot and region. */
  defaultTemplate: string
  /** Whether `template` is a stored override rather than the shipped default. */
  overridden: boolean
  /** The exact header value the next request on this slot would send. */
  preview: string
  /**
   * Something the stored template was refused for, so the card can explain why
   * the preview does not match what was typed. Absent for a default.
   */
  error?: UaTemplateError
  /**
   * The shipped default needs a value this machine could not supply, so the
   * preview below shows the compiled-in literal instead.
   *
   * Set only for an un-overridden slot: it explains a preview that visibly
   * differs from the template in the field, which would otherwise read as a
   * bug. Never set alongside `error`, which is about a stored override.
   */
  defaultUnavailable?: true
}

/** The compiled-in fallback for one slot, before any template is applied. */
export function uaSlotFallback(slot: UaSlot, region: UaRegion): string {
  if (slot === 'catalog' && region === 'global') return `WorkBuddyAI/${UA_APP_FALLBACK_VERSION}`
  return UA_SHARED_FALLBACK
}

/**
 * Resolve one slot for display and for the wire.
 *
 * The host calls this to build a request; the card calls the very same function
 * through the status document's values, so a preview can never disagree with
 * what is sent — which is the only reason a preview is worth rendering at all.
 *
 * A stored template that fails validation is *reported*, not applied: the wire
 * keeps sending the default (see {@link resolveUserAgent}) while the card says
 * why, rather than silently accepting a header the plugin would refuse.
 */
export function planUaSlot(
  slot: UaSlot,
  region: UaRegion,
  override: string | undefined,
  context: UaContext,
): UaSlotPlan {
  const defaultTemplate = defaultUaTemplate(slot, region)
  const fallback = uaSlotFallback(slot, region)
  const error = override === undefined ? undefined : validateUaTemplate(override)
  const usable = override !== undefined && error === undefined ? override : undefined
  // `template` is what the user *sees*, so for an untouched slot it is the
  // shipped default even when this machine cannot fill it — the field is an
  // editor for that template, not a report of the current expansion. The
  // `defaultUnavailable` flag is how the card explains that the preview under
  // it is showing the compiled-in literal instead.
  const defaultUnavailable = usable === undefined && !templateResolvesCompletely(defaultTemplate, context)
  const plan: UaSlotPlan = {
    slot,
    template: usable ?? defaultTemplate,
    defaultTemplate,
    overridden: usable !== undefined,
    preview: resolveUserAgent(usable, { template: defaultTemplate, fallback }, context),
  }
  if (error !== undefined) plan.error = error
  if (defaultUnavailable) plan.defaultUnavailable = true
  return plan
}
