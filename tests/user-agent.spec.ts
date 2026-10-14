import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UA_MAX_TEMPLATE_LENGTH,
  UA_PLACEHOLDERS,
  UA_SHARED_FALLBACK,
  UA_SLOTS,
  defaultUaTemplate,
  expandUaTemplate,
  isUaSlot,
  planUaSlot,
  resolveUserAgent,
  validateUaTemplate,
} from '../src/ua-template.ts'
import { WorkBuddyUserAgentStore, workbuddyUaPath } from '../src/ua-store.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { ChatIdentity } from '../src/client-identity.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

/**
 * The User-Agent override feature. Four properties carry the whole design, and
 * each is pinned here:
 *
 * 1. **An untouched install sends the UA this plugin has always sent**, with the
 *    versions taken from the installed app rather than from a release constant —
 *    so adding the feature cannot itself change what the upstream sees, and
 *    updating the app cannot silently drift the identity.
 * 2. **A stored template is honoured per request family, and only there.** The
 *    three slots exist because the upstream keys on client identity in three
 *    different ways; an override for one must never leak into another.
 * 3. **Nothing unusable reaches a header.** A template with a CR/LF, an unknown
 *    placeholder, or no content at all is refused at the store, at the route,
 *    and again at expansion — and the wire keeps sending the default.
 * 4. **A shipped default is never sent half-expanded.** Measurement on the CN
 *    catalog endpoint shows the short forms are not benign — see
 *    `templateResolvesCompletely`.
 */

const CLEANUP: (() => void)[] = []

afterEach(() => {
  for (const clean of CLEANUP.splice(0)) clean()
  vi.unstubAllGlobals()
})

/** Fresh throwaway directory registered for afterEach removal. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  CLEANUP.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const CN: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: 0,
  domain: 'www.codebuddy.cn', uid: 'uid-1', source: 'desktop',
}
const GLOBAL: WorkBuddyCredential = { ...CN, domain: 'www.workbuddy.ai' }
const IDENTITY: ChatIdentity = { clientVersion: '5.7.6', cliVersion: '2.156.0' }

function fakeResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: () => Promise.resolve(body) } as unknown as Response
}

/** Stub fetch and return the last (url, init) pair it received. */
function captureFetch(body: string, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => fakeResponse(body, ok, status))
  vi.stubGlobal('fetch', fetchMock)
  return {
    last: (): [string, RequestInit] => {
      expect(fetchMock).toHaveBeenCalled()
      return fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as unknown as [string, RequestInit]
    },
  }
}

const CATALOG_BODY = JSON.stringify({
  code: 0, msg: 'ok',
  data: {
    models: [{ id: 'm', name: 'M', maxInputTokens: 100, maxOutputTokens: 10 }],
    agents: [{ name: 'cli', models: ['m'] }],
  },
})

describe('default templates reproduce the shipped UAs', () => {
  it('pins each slot to the template this plugin ships', () => {
    // Pinned literally: a change to a default template is a wire change and
    // must be a deliberate edit here too. Every version is a placeholder the
    // host fills from the *installed app*, which is what keeps the identity
    // from drifting when that app updates.
    expect(defaultUaTemplate('shared', 'cn')).toBe('CLI/{cliVersion} CodeBuddy/{appVersion}')
    expect(defaultUaTemplate('shared', 'global')).toBe('CLI/{cliVersion} CodeBuddy/{appVersion}')
    expect(defaultUaTemplate('catalog', 'cn')).toBe('CLI/{cliVersion} CodeBuddy/{appVersion}')
    expect(defaultUaTemplate('catalog', 'global')).toBe('WorkBuddyAI/{appVersion}')
    expect(defaultUaTemplate('chat', 'cn')).toBe('WorkBuddy/{appVersion} {product}/{appVersion} CLI/{cliVersion}')
    expect(defaultUaTemplate('chat', 'global')).toBe('WorkBuddy/{appVersion} {product}/{appVersion} CLI/{cliVersion}')
  })

  it('expands the chat default to the desktop form, CN and international', () => {
    const context = { appVersion: '5.7.6', cliVersion: '2.156.0' }
    expect(expandUaTemplate(defaultUaTemplate('chat', 'cn'), { ...context, product: 'WorkBuddy' }))
      .toBe('WorkBuddy/5.7.6 WorkBuddy/5.7.6 CLI/2.156.0')
    expect(expandUaTemplate(defaultUaTemplate('chat', 'global'), { ...context, product: 'WorkBuddy AI' }))
      .toBe('WorkBuddy/5.7.6 WorkBuddy AI/5.7.6 CLI/2.156.0')
  })

  it('expands the international catalog default to the App form, with no space', () => {
    const ua = expandUaTemplate(defaultUaTemplate('catalog', 'global'), { appVersion: '5.7.6' })
    expect(ua).toBe('WorkBuddyAI/5.7.6')
    expect(ua).not.toContain(' ')
  })

  it('expands the CLI-shaped defaults to the CLI form with the local versions', () => {
    // Measured on the CN endpoint: only `CLI/<v> CodeBuddy/<v>` yields the
    // `cli` roster. `CodeBuddy/<v>` alone answers HTTP 200 with a document that
    // has no cli agent at all — a silent wrong answer — and `CLI/<v>` alone is a
    // hard 400. Both are why a default must never be sent half-expanded.
    const context = { appVersion: '5.5.4', cliVersion: '2.137.1' }
    expect(expandUaTemplate(defaultUaTemplate('catalog', 'cn'), context)).toBe('CLI/2.137.1 CodeBuddy/5.5.4')
    expect(expandUaTemplate(defaultUaTemplate('shared', 'cn'), context)).toBe('CLI/2.137.1 CodeBuddy/5.5.4')
  })

  it('drops the CLI token rather than leaving a dangling segment', () => {
    // The official client's own rule for a missing extension, and the reason a
    // machine that cannot report its CLI version still sends a valid UA when a
    // *user* wrote the template.
    expect(expandUaTemplate(defaultUaTemplate('chat', 'cn'), { appVersion: '5.5.6', product: 'WorkBuddy' }))
      .toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6')
  })
})

describe('expandUaTemplate', () => {
  it('normalizes whitespace so a stray double space cannot change the header', () => {
    expect(expandUaTemplate('  A/1   B/1  ', {})).toBe('A/1 B/1')
  })

  it('drops a whole token when any of its placeholders is unresolved', () => {
    // The unit of dropping is the whitespace-delimited token, not the
    // placeholder: that is what makes `CLI/{cliVersion}` vanish entirely instead
    // of leaving a dangling `CLI/` behind.
    expect(expandUaTemplate('A/{appVersion} CLI/{cliVersion}', { appVersion: '1.0.0' })).toBe('A/1.0.0')
    expect(expandUaTemplate('A/{product} B', {})).toBe('B')
  })

  it('treats an empty-string value as unresolved', () => {
    expect(expandUaTemplate('A/{product} B', { product: '' })).toBe('B')
  })

  it('leaves no trace of an unknown placeholder name', () => {
    // Validation refuses these before storage; expansion is the second gate, and
    // it must not pass the literal through — a `{name}` on the wire would look
    // like syntax the gateway might act on.
    expect(expandUaTemplate('A/{nope} B', {})).toBe('B')
    expect(expandUaTemplate('{nope}/{nope}', {})).toBe('')
  })
})

describe('validateUaTemplate', () => {
  it('accepts every shipped default', () => {
    for (const slot of UA_SLOTS) {
      expect(validateUaTemplate(defaultUaTemplate(slot, 'cn'))).toBeUndefined()
      expect(validateUaTemplate(defaultUaTemplate(slot, 'global'))).toBeUndefined()
    }
  })

  it('refuses the header-splitting characters', () => {
    // The template reaches an HTTP header: CR/LF would split the request.
    expect(validateUaTemplate('A\r\nX-Injected: 1')).toBe('control-char')
    expect(validateUaTemplate('A\nB')).toBe('control-char')
    expect(validateUaTemplate('A\tB')).toBe('control-char')
    expect(validateUaTemplate('A\u0000B')).toBe('control-char')
  })

  it('refuses empty, oversized, and unknown-placeholder templates', () => {
    expect(validateUaTemplate('')).toBe('empty')
    expect(validateUaTemplate('   ')).toBe('empty')
    expect(validateUaTemplate('x'.repeat(UA_MAX_TEMPLATE_LENGTH + 1))).toBe('too-long')
    expect(validateUaTemplate('A/{latest}')).toBe('unknown-placeholder')
    expect(validateUaTemplate('A/{APPVERSION}')).toBe('unknown-placeholder')
  })

  it('accepts every documented placeholder', () => {
    for (const name of UA_PLACEHOLDERS) {
      expect(validateUaTemplate(`X/{${name}}`)).toBeUndefined()
    }
  })
})

describe('resolveUserAgent degradation chain', () => {
  const defaults = { template: 'A/{appVersion}', fallback: 'A/fallback' }

  it('prefers a valid override', () => {
    expect(resolveUserAgent('B/{appVersion}', defaults, { appVersion: '9.9.9' })).toBe('B/9.9.9')
  })

  it('ignores an invalid override and uses the default', () => {
    expect(resolveUserAgent('B\r\nX: 1', defaults, { appVersion: '9.9.9' })).toBe('A/9.9.9')
    expect(resolveUserAgent('B/{nope}', defaults, { appVersion: '9.9.9' })).toBe('A/9.9.9')
  })

  it('falls through to the compiled-in literal when even the default expands to nothing', () => {
    // Only reachable if a context carries no version at all — but a UA that
    // expands to "" would send no header at all, so this step must exist.
    expect(resolveUserAgent(undefined, defaults, {})).toBe('A/fallback')
  })

  it('does not fall through to the literal while the default still expands', () => {
    expect(resolveUserAgent(undefined, defaults, { appVersion: '1.0.0' })).toBe('A/1.0.0')
  })
})

describe('planUaSlot', () => {
  it('reports the override, its default, and the exact preview', () => {
    const plan = planUaSlot('chat', 'cn', 'X/{appVersion} CLI/{cliVersion}', {
      appVersion: '5.7.6', cliVersion: '2.156.0',
    })
    expect(plan).toMatchObject({
      slot: 'chat',
      template: 'X/{appVersion} CLI/{cliVersion}',
      defaultTemplate: defaultUaTemplate('chat', 'cn'),
      overridden: true,
      preview: 'X/5.7.6 CLI/2.156.0',
    })
    expect(plan.error).toBeUndefined()
  })

  it('reports a stored template it refuses, and previews the default instead', () => {
    const context = { appVersion: '5.7.6', cliVersion: '2.156.0', product: 'WorkBuddy' }
    const plan = planUaSlot('chat', 'cn', 'X/{nope}', context)
    expect(plan.error).toBe('unknown-placeholder')
    // The wire keeps the default — the report and the behaviour must agree with
    // what `resolveUserAgent` would actually send.
    expect(plan.preview).toBe(expandUaTemplate(defaultUaTemplate('chat', 'cn'), context))
  })

  it('falls back to the compiled-in literal when the default needs a value this machine lacks', () => {
    // The chat default names three placeholders. A context missing any of them
    // cannot reproduce it, and measurement shows the short forms are NOT benign
    // on the CN catalog endpoint: `CodeBuddy/<v>` alone answers HTTP 200 with a
    // document carrying no cli roster (a silent wrong answer) and `CLI/<v>` alone
    // is a hard 400. So an incomplete context must send the known-good literal,
    // not a half-expanded template.
    const plan = planUaSlot('chat', 'cn', undefined, { appVersion: '5.7.6' })
    expect(plan.preview).toBe(UA_SHARED_FALLBACK)
    expect(plan.defaultUnavailable).toBe(true)
  })

  it('does not flag an available default, and needs no fallback then', () => {
    const plan = planUaSlot('catalog', 'cn', undefined, { appVersion: '5.5.4', cliVersion: '2.137.1' })
    expect(plan.defaultUnavailable).toBeUndefined()
    expect(plan.preview).toBe('CLI/2.137.1 CodeBuddy/5.5.4')
  })

  it('marks an untouched slot un-overridden', () => {
    const plan = planUaSlot('shared', 'cn', undefined, {})
    expect(plan.overridden).toBe(false)
    expect(plan.error).toBeUndefined()
    expect(plan.template).toBe(defaultUaTemplate('shared', 'cn'))
  })

  it('agrees with resolveUserAgent for the same inputs', () => {
    // The preview is only worth rendering if it equals what goes out.
    for (const region of ['cn', 'global'] as const) {
      for (const slot of UA_SLOTS) {
        for (const override of [undefined, 'Z/{appVersion}', 'bad\nvalue']) {
          const context = { appVersion: '5.7.6', cliVersion: '2.156.0', product: 'WorkBuddy AI' }
          const plan = planUaSlot(slot, region, override, context)
          const sent = resolveUserAgent(
            plan.overridden ? plan.template : undefined,
            { template: defaultUaTemplate(slot, region), fallback: plan.preview },
            context,
          )
          expect(plan.preview).toBe(sent)
        }
      }
    }
  })
})

describe('WorkBuddyUserAgentStore', () => {
  it('starts empty and defaults its path into the Harness home', () => {
    const store = new WorkBuddyUserAgentStore({ path: join(tempDir('wb-ua-'), 'ua.json') })
    expect(store.override('workbuddy', 'chat')).toBeUndefined()
    expect(store.overrides('workbuddy')).toEqual({})
    expect(workbuddyUaPath()).toContain('.workbuddy-user-agent.json')
  })

  it('persists per variant and per slot, atomically and owner-readable only', () => {
    const path = join(tempDir('wb-ua-'), 'ua.json')
    const store = new WorkBuddyUserAgentStore({ path })
    store.setOverride('workbuddy', 'chat', 'X/{appVersion}')
    store.setOverride('workbuddy-ai', 'catalog', 'Y/{appVersion}')

    const document = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number
      variants: Record<string, Record<string, string>>
    }
    expect(document.version).toBe(1)
    expect(document.variants['workbuddy']).toEqual({ chat: 'X/{appVersion}' })
    expect(document.variants['workbuddy-ai']).toEqual({ catalog: 'Y/{appVersion}' })
    // A UA is not a secret, but it is still the user's file: keep it private.
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }

    // A second instance reads what the first wrote — the card and the wire path
    // are different objects, so this round trip is the actual contract.
    const reopened = new WorkBuddyUserAgentStore({ path })
    expect(reopened.override('workbuddy', 'chat')).toBe('X/{appVersion}')
    expect(reopened.override('workbuddy', 'catalog')).toBeUndefined()
    expect(reopened.override('workbuddy-ai', 'catalog')).toBe('Y/{appVersion}')
  })

  it('clears one slot without touching the others, and drops an emptied variant', () => {
    const path = join(tempDir('wb-ua-'), 'ua.json')
    const store = new WorkBuddyUserAgentStore({ path })
    store.setOverride('workbuddy', 'chat', 'X')
    store.setOverride('workbuddy', 'shared', 'Y')
    store.setOverride('workbuddy', 'chat', undefined)
    expect(store.override('workbuddy', 'shared')).toBe('Y')
    store.setOverride('workbuddy', 'shared', undefined)
    expect(store.overrides('workbuddy')).toEqual({})
    const document = JSON.parse(readFileSync(path, 'utf8')) as { variants: Record<string, unknown> }
    expect(document.variants['workbuddy']).toBeUndefined()
  })

  it('clears a whole variant at once', () => {
    const path = join(tempDir('wb-ua-'), 'ua.json')
    const store = new WorkBuddyUserAgentStore({ path })
    store.setOverride('workbuddy', 'chat', 'X')
    store.setOverride('workbuddy-ai', 'chat', 'Y')
    store.clear('workbuddy')
    expect(store.overrides('workbuddy')).toEqual({})
    expect(store.override('workbuddy-ai', 'chat')).toBe('Y')
  })

  it('reads a corrupt, wrong-version, or wrong-shaped file as nothing overridden', () => {
    const dir = tempDir('wb-ua-')
    for (const content of [
      '{ not json',
      JSON.stringify({ version: 99, variants: { workbuddy: { chat: 'X' } } }),
      JSON.stringify({ version: 1, variants: 'nope' }),
      JSON.stringify({ version: 1, variants: { workbuddy: { bogusSlot: 'X' } } }),
      JSON.stringify({ version: 1, variants: { workbuddy: { chat: 42 } } }),
    ]) {
      const path = join(dir, `${content.length}.json`)
      writeFileSync(path, content, 'utf8')
      expect(new WorkBuddyUserAgentStore({ path }).overrides('workbuddy')).toEqual({})
    }
  })

  it('throws when the write fails, leaving in-memory state untouched', () => {
    const dir = tempDir('wb-ua-')
    if (process.platform === 'win32') return
    // A path whose parent is a regular file can never be written.
    const blocked = join(dir, 'file')
    writeFileSync(blocked, 'x', 'utf8')
    const store = new WorkBuddyUserAgentStore({ path: join(blocked, 'under', 'a', 'file.json') })
    expect(() => { store.setOverride('workbuddy', 'chat', 'X') }).toThrow()
    expect(store.override('workbuddy', 'chat')).toBeUndefined()
  })
})

describe('the wire honours an override, per slot', () => {
  function clientWith(overrides: Record<string, string>, identity: ChatIdentity = IDENTITY) {
    return new WorkBuddyUpstreamClient({
      resolveChatIdentity: async () => identity,
      resolveAppVersion: async () => ({ version: '5.7.6', source: 'installed', bundle: '/x' }),
      uaOverride: (slot, region) => overrides[`${slot}:${region}`],
      // Stands in for `app-install.ts`: the identity every slot expands with.
      // Injected rather than read, so these tests never touch the machine.
      installedIdentity: async () => ({ appVersion: '5.5.4', cliVersion: '2.137.1', productName: 'WorkBuddy' }),
    })
  }

  it('replaces the chat UA when the chat slot is overridden', async () => {
    const wire = captureFetch('{}')
    await clientWith({ 'chat:cn': 'Custom/{appVersion} CLI/{cliVersion}' })
      .chatStream(CN, JSON.stringify({ model: 'm', messages: [] }))
    expect((wire.last()[1].headers as Record<string, string>)['User-Agent']).toBe('Custom/5.5.4 CLI/2.137.1')
  })

  it('replaces the catalog UA when only the catalog slot is overridden', async () => {
    const wire = captureFetch(CATALOG_BODY)
    await clientWith({ 'catalog:global': 'workbuddy-ai/{appVersion}' }).fetchModels(GLOBAL)
    expect((wire.last()[1].headers as Record<string, string>)['User-Agent']).toBe('workbuddy-ai/5.5.4')
  })

  it('does not let a catalog override leak into chat, or the reverse', async () => {
    // The slots are separate request families: a brand-new App-shaped catalog UA
    // must not silently become the chat identity.
    const chatWire = captureFetch('{}')
    await clientWith({ 'catalog:global': 'workbuddy-ai/{appVersion}' })
      .chatStream(GLOBAL, JSON.stringify({ model: 'm', messages: [] }))
    expect((chatWire.last()[1].headers as Record<string, string>)['User-Agent'])
      .toBe('WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1')

    const catalogWire = captureFetch(CATALOG_BODY)
    await clientWith({ 'chat:global': 'Nope/{appVersion}' }).fetchModels(GLOBAL)
    expect((catalogWire.last()[1].headers as Record<string, string>)['User-Agent']).toBe('WorkBuddyAI/5.5.4')
  })

  it('replaces the shared UA on refresh, and leaves the chat-only headers off it', async () => {
    const wire = captureFetch(JSON.stringify({ code: 0, msg: 'ok', data: { accessToken: 'next' } }))
    await clientWith({ 'shared:cn': 'Refresher/9' }).refreshToken(CN)
    const headers = wire.last()[1].headers as Record<string, string>
    expect(headers['User-Agent']).toBe('Refresher/9')
    // The blast radius stays where it was: refresh still carries no X-IDE-*.
    expect(headers['X-IDE-Type']).toBeUndefined()
    expect(headers['X-IDE-Version']).toBeUndefined()
  })

  it('sends the default when a stored template is unusable', async () => {
    const wire = captureFetch('{}')
    await clientWith({ 'chat:cn': 'Bad\r\nX-Injected: 1' })
      .chatStream(CN, JSON.stringify({ model: 'm', messages: [] }))
    const headers = wire.last()[1].headers as Record<string, string>
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1')
    expect(headers['X-Injected']).toBeUndefined()
  })

  it('leaves every request byte-identical when nothing is overridden', async () => {
    // The whole point of expanding from the machine's own identity: an
    // untouched install sends a UA built from the installed app, and nothing
    // else about a request changes.
    const chatWire = captureFetch('{}')
    await clientWith({}).chatStream(CN, JSON.stringify({ model: 'm', messages: [] }))
    expect((chatWire.last()[1].headers as Record<string, string>)['User-Agent'])
      .toBe('WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1')

    // The CN catalog keeps the CLI form, now with the local versions.
    const catalogWire = captureFetch(CATALOG_BODY)
    await clientWith({}).fetchModels(CN)
    expect((catalogWire.last()[1].headers as Record<string, string>)['User-Agent'])
      .toBe('CLI/2.137.1 CodeBuddy/5.5.4')

    const intlWire = captureFetch(CATALOG_BODY)
    await clientWith({}).fetchModels(GLOBAL)
    expect((intlWire.last()[1].headers as Record<string, string>)['User-Agent']).toBe('WorkBuddyAI/5.5.4')

    const refreshWire = captureFetch(JSON.stringify({ code: 0, msg: 'ok', data: { accessToken: 'next' } }))
    await clientWith({}).refreshToken(CN)
    expect((refreshWire.last()[1].headers as Record<string, string>)['User-Agent'])
      .toBe('CLI/2.137.1 CodeBuddy/5.5.4')
  })

  it('uses the identity chain when the app itself cannot be read', async () => {
    // Both sources are legitimate, so this pins which one wins: the catalog
    // path's own app-version resolution leads when the installed reader has
    // nothing, and the identity chain fills the CLI version.
    const client = new WorkBuddyUpstreamClient({
      resolveChatIdentity: async () => IDENTITY,
      resolveAppVersion: async () => ({ version: '5.7.6', source: 'saved' }),
      uaOverride: () => undefined,
      installedIdentity: async () => ({}),
    })
    const catalogWire = captureFetch(CATALOG_BODY)
    await client.fetchModels(CN)
    expect((catalogWire.last()[1].headers as Record<string, string>)['User-Agent'])
      .toBe('CLI/2.156.0 CodeBuddy/5.7.6')

    const intlWire = captureFetch(CATALOG_BODY)
    await client.fetchModels(GLOBAL)
    expect((intlWire.last()[1].headers as Record<string, string>)['User-Agent']).toBe('WorkBuddyAI/5.7.6')
  })

  it('falls back to a UA this plugin has shipped when only some values resolve', async () => {
    // The real "no app installed on this machine" case: the identity chain has
    // only a compiled-in app version and no CLI version at all.
    const client = new WorkBuddyUpstreamClient({
      resolveChatIdentity: async () => ({ clientVersion: '5.5.6' }),
      resolveAppVersion: async () => ({ version: '5.5.2', source: 'fallback' }),
      uaOverride: () => undefined,
      installedIdentity: async () => ({}),
    })
    // The CLI-shaped default needs a CLI version, so it falls back to the
    // literal this plugin has always sent.
    const catalogWire = captureFetch(CATALOG_BODY)
    await client.fetchModels(CN)
    expect((catalogWire.last()[1].headers as Record<string, string>)['User-Agent']).toBe(UA_SHARED_FALLBACK)

    const refreshWire = captureFetch(JSON.stringify({ code: 0, msg: 'ok', data: { accessToken: 'next' } }))
    await client.refreshToken(CN)
    expect((refreshWire.last()[1].headers as Record<string, string>)['User-Agent']).toBe(UA_SHARED_FALLBACK)

    // The chat slot's fallback is the desktop form with the CLI token dropped —
    // the official client's own rule for a missing extension, and the shape
    // `chatUserAgent()` has always produced. So it is safe to send half-built.
    const chatWire = captureFetch('{}')
    await client.chatStream(CN, JSON.stringify({ model: 'm', messages: [] }))
    expect((chatWire.last()[1].headers as Record<string, string>)['User-Agent'])
      .toBe('WorkBuddy/5.5.6 WorkBuddy/5.5.6')

    // The App-shaped default names only one placeholder, so it still expands.
    const intlWire = captureFetch(CATALOG_BODY)
    await client.fetchModels(GLOBAL)
    expect((intlWire.last()[1].headers as Record<string, string>)['User-Agent']).toBe('WorkBuddyAI/5.5.2')
  })
})

describe('isUaSlot', () => {
  it('accepts exactly the three slots', () => {
    expect(UA_SLOTS).toEqual(['catalog', 'chat', 'shared'])
    expect(isUaSlot('catalog')).toBe(true)
    expect(isUaSlot('chat')).toBe(true)
    expect(isUaSlot('shared')).toBe(true)
    expect(isUaSlot('billing')).toBe(false)
    expect(isUaSlot(undefined)).toBe(false)
  })
})
