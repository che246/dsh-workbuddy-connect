import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_CARD_VARIANT, CN_CARD_VARIANT, WorkBuddyPluginCard } from '../src/client/WorkBuddyPluginCard.tsx'
import { en } from '../src/client/locales.ts'
import { defaultUaTemplate } from '../src/ua-template.ts'

/**
 * The card's User-Agent editor: one block per slot, a preview of what will be
 * sent, and a default one click away.
 *
 * Three properties matter enough to pin here:
 *
 * 1. **The tab appears only when the host offers the section.** Its presence in
 *    the document is the capability signal — a tab that could only report "not
 *    supported" is worse than no tab.
 * 2. **Typing is safe.** The status poll replaces the document every minute, so
 *    a draft held in document-derived state would be erased mid-edit.
 * 3. **Saving is explicit and confirmed.** A template is a wire change; nothing
 *    is stored until Save, and a refused write says so instead of looking saved.
 *
 * The host side (store, validation, wire behaviour, route) is pinned by
 * `tests/user-agent.spec.ts` and `tests/probe-route.spec.ts`.
 */

/** A three-slot section shaped like the host's. */
const UA_SECTION = {
  placeholders: ['appVersion', 'cliVersion', 'product'],
  slots: [
    {
      slot: 'catalog',
      template: defaultUaTemplate('catalog', 'global'),
      defaultTemplate: defaultUaTemplate('catalog', 'global'),
      overridden: false,
      preview: 'WorkBuddyAI/5.7.6',
    },
    {
      slot: 'chat',
      template: 'Custom/{appVersion}',
      defaultTemplate: defaultUaTemplate('chat', 'global'),
      overridden: true,
      preview: 'Custom/5.7.6',
    },
    {
      slot: 'shared',
      template: defaultUaTemplate('shared', 'cn'),
      defaultTemplate: defaultUaTemplate('shared', 'cn'),
      overridden: false,
      preview: 'CLI/2.63.2 CodeBuddy/2.63.2',
      missingCliVersion: true,
    },
  ],
} as const

describe('user-agent editor card controls', () => {
  let view: ReactTestRenderer | undefined
  /** The mutable status body every GET answers with. */
  let statusBody: Record<string, unknown>
  /** The response every POST answers with; `{ state: 'updated' }` saves. */
  let postResponse: Record<string, unknown>
  const posts: { body: Record<string, unknown> }[] = []
  const request = vi.fn()

  const t = (key: keyof typeof en, params: Record<string, unknown> = {}): string =>
    Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), en[key] as string)

  /** Apply one UA write to the simulated host truth, as the host would. */
  function applyWrite(body: Record<string, unknown>): void {
    if (body['action'] !== 'set-user-agent') return
    const section = statusBody['userAgent'] as { slots: { slot: string, template: string, defaultTemplate: string, overridden: boolean, preview: string }[] }
    const entry = section.slots.find(slot => slot.slot === body['slot'])
    if (entry === undefined) return
    const template = body['template'] as string | null
    if (template === null) {
      entry.template = entry.defaultTemplate
      entry.overridden = false
    } else {
      entry.template = template
      entry.overridden = true
    }
    entry.preview = entry.template.replace('{appVersion}', '5.7.6')
  }

  /** The three slot inputs, in document order. */
  function inputs(): { props: Record<string, unknown> }[] {
    return view!.root.findAll(node => node.type === 'input'
      && (node.props as Record<string, unknown>)['type'] === 'text') as unknown as { props: Record<string, unknown> }[]
  }

  function buttonLabels(): string[] {
    return view!.root.findAllByType('button').map(node => node.children.join(''))
  }

  /**
   * One slot's block, located through its input's `aria-label`.
   *
   * Scoping matters here: every slot has its own Save and Reset, and an
   * unscoped lookup would always find the first one — making a test that means
   * to exercise the chat slot silently exercise the catalog slot instead.
   */
  function block(slotLabel: string): { findAll: (fn: (node: any) => boolean) => any[] } {
    const input = view!.root.findAll(node => node.type === 'input'
      && (node.props as Record<string, unknown>)['aria-label'] === slotLabel)
    if (input.length === 0) throw new Error(`no slot input labelled ${slotLabel}`)
    // input → block <div>
    return input[0]!.parent as unknown as { findAll: (fn: (node: any) => boolean) => any[] }
  }

  /** Press one button by label, inside one slot's block. */
  function pressInBlock(slotLabel: string, label: string): void {
    const found = block(slotLabel).findAll(node => node.type === 'button' && node.children.join('') === label)
    if (found.length === 0) throw new Error(`no ${label} in the ${slotLabel} block`)
    act(() => { (found[0]!.props['onClick'] as () => void)() })
  }

  /** Whether the button labelled `label` in one slot's block is disabled. */
  function blockButtonDisabled(slotLabel: string, label: string): boolean {
    const found = block(slotLabel).findAll(node => node.type === 'button' && node.children.join('') === label)
    if (found.length === 0) throw new Error(`no ${label} in the ${slotLabel} block`)
    return found[0]!.props['disabled'] === true
  }

  /**
   * The visible text of one slot's block.
   *
   * Walked by hand rather than `JSON.stringify`: a react-test-renderer instance
   * holds fiber back-references, and stringifying one throws on the cycle.
   */
  function blockText(slotLabel: string): string {
    const instance = view!.root.findAll(node => node.type === 'input'
      && (node.props as Record<string, unknown>)['aria-label'] === slotLabel)[0]!
    const walk = (node: unknown): string => {
      if (typeof node === 'string' || typeof node === 'number') return String(node)
      if (typeof node !== 'object' || node === null) return ''
      const children = (node as { children?: unknown[] }).children
      if (!Array.isArray(children)) return ''
      return children.map(walk).join('')
    }
    return walk(instance.parent)
  }

  /** Mount, expand, and optionally switch to the UA tab. */
  async function mount(variant = AI_CARD_VARIANT, { tab = true }: { tab?: boolean } = {}): Promise<void> {
    const props = { t, variant } as unknown as Parameters<typeof WorkBuddyPluginCard>[0]
    await act(async () => { view = create(createElement(WorkBuddyPluginCard, props)) })
    await act(async () => { view!.root.findAllByType('button')[0]!.props.onClick() })
    if (!tab) return
    const node = view!.root.findAllByType('button').find(entry => entry.children.join('') === en.tabUserAgent)
    if (node === undefined) throw new Error('user-agent tab not found')
    await act(async () => { node.props.onClick() })
  }

  /** Type into one slot's field. */
  async function type(index: number, value: string): Promise<void> {
    const node = inputs()[index]
    if (node === undefined) throw new Error(`no text input #${index}`)
    const onChange = node.props['onChange'] as (event: unknown) => void
    await act(async () => { onChange({ currentTarget: { value } }) })
  }

  /** Let a POST and its follow-up read settle. */
  async function settle(): Promise<void> {
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
  }

  beforeEach(() => {
    statusBody = {
      status: 'signed-in',
      nickname: '昵称',
      probeKey: 'test-key',
      catalog: { source: 'live', fetchedAt: Date.now() },
      userAgent: JSON.parse(JSON.stringify(UA_SECTION)),
    }
    postResponse = { state: 'updated' }
    posts.length = 0
    request.mockReset().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') {
        return { ok: true, json: async () => JSON.parse(JSON.stringify(statusBody)) }
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ body })
      if (postResponse['state'] === 'updated') applyWrite(body)
      return { ok: true, json: async () => postResponse }
    })
    vi.stubGlobal('fetch', request)
    vi.stubGlobal('window', {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
  })

  afterEach(() => {
    act(() => view?.unmount())
    vi.unstubAllGlobals()
  })

  it('offers the tab only when the document carries the section', async () => {
    await mount()
    expect(buttonLabels()).toContain(en.tabUserAgent)

    // A host without the editor: the tab must not appear at all, rather than
    // rendering a control that can only fail.
    act(() => view?.unmount())
    delete statusBody['userAgent']
    await mount(AI_CARD_VARIANT, { tab: false })
    expect(buttonLabels()).not.toContain(en.tabUserAgent)
  })

  it('shows every slot with its template, its default, and the preview', async () => {
    await mount()
    const text = JSON.stringify(view!.toJSON())
    expect(text).toContain(en.uaSlotCatalog)
    expect(text).toContain(en.uaSlotChat)
    expect(text).toContain(en.uaSlotShared)
    // The preview is the point of the tab: what the next request would send.
    expect(text).toContain('WorkBuddyAI/5.7.6')
    expect(text).toContain('Custom/5.7.6')
    // The default is always visible, because Reset needs something to reset to.
    expect(text).toContain(defaultUaTemplate('chat', 'global'))
  })

  it('marks which slots are customized', async () => {
    await mount()
    const text = JSON.stringify(view!.toJSON())
    // One slot is overridden in the fixture, two are not.
    expect(text.split(en.uaOverridden).length - 1).toBe(1)
    expect(text.split(en.uaUsingDefault).length - 1).toBe(2)
  })

  it('names a dropped CLI token instead of letting the segment vanish silently', async () => {
    // A template using {cliVersion} on a machine that cannot report one still
    // sends a valid UA — the token is dropped — but the card must say why, or a
    // correct template reads as broken.
    await mount()
    expect(blockText(en.uaSlotShared)).toContain(en.uaMissingCliVersion)
  })

  it('keeps a draft through a status poll, and clears it on save', async () => {
    await mount()
    await type(0, 'Draft/{appVersion}')
    // Nothing was stored by typing: a template is a wire change.
    expect(posts).toHaveLength(0)
    expect(inputs()[0]!.props['value']).toBe('Draft/{appVersion}')

    // A poll lands (the interval is stubbed, so drive the read directly).
    await act(async () => { view!.root.findAllByType('button').find(node => node.children.join('') === en.refresh)!.props.onClick() })
    await settle()
    // The draft survives: it lives in local state, not in the document.
    expect(inputs()[0]!.props['value']).toBe('Draft/{appVersion}')

    pressInBlock(en.uaSlotCatalog, en.uaSave)
    await settle()
    expect(posts).toEqual([{ body: { action: 'set-user-agent', slot: 'catalog', template: 'Draft/{appVersion}' } }])
  })

  it('sends the slot the user edited, and only that slot', async () => {
    await mount()
    await type(1, 'Chatty/{appVersion}')
    pressInBlock(en.uaSlotChat, en.uaSave)
    await settle()
    expect(posts).toEqual([{ body: { action: 'set-user-agent', slot: 'chat', template: 'Chatty/{appVersion}' } }])
  })

  it('sends null to reset, and does not offer Reset on an untouched slot', async () => {
    await mount()
    // Slots 0 and 2 are un-overridden, so their Reset buttons are inert.
    expect(blockButtonDisabled(en.uaSlotCatalog, en.uaReset)).toBe(true)
    expect(blockButtonDisabled(en.uaSlotChat, en.uaReset)).toBe(false)
    expect(blockButtonDisabled(en.uaSlotShared, en.uaReset)).toBe(true)

    pressInBlock(en.uaSlotChat, en.uaReset)
    await settle()
    expect(posts).toEqual([{ body: { action: 'set-user-agent', slot: 'chat', template: null } }])
  })

  it('disables Save until the field differs from what is stored', async () => {
    await mount()
    expect(blockButtonDisabled(en.uaSlotCatalog, en.uaSave)).toBe(true)
    await type(0, 'Changed')
    expect(blockButtonDisabled(en.uaSlotCatalog, en.uaSave)).toBe(false)
  })

  it('reports a refused write instead of leaving the field looking saved', async () => {
    postResponse = { state: 'failed', reason: 'control characters are not allowed' }
    await mount()
    await type(0, 'Bad')
    pressInBlock(en.uaSlotCatalog, en.uaSave)
    await settle()
    expect(JSON.stringify(view!.toJSON())).toContain('control characters are not allowed')
    // The host truth is untouched, so the slot still reads as un-overridden.
    expect(JSON.stringify(view!.toJSON()).split(en.uaOverridden).length - 1).toBe(1)
  })

  it('shows a host-reported template error beside the slot, previewing what is sent', async () => {
    // The host keeps sending the default when a stored template is unusable; the
    // card must show that value *and* the reason — hiding the preview would leave
    // the user unable to see what actually goes out.
    const section = statusBody['userAgent'] as { slots: { slot: string, error?: string, preview: string }[] }
    section.slots[1]!.error = 'unknown-placeholder'
    section.slots[1]!.preview = 'WorkBuddy/5.7.6 WorkBuddy AI/5.7.6'
    await mount()
    const chatBlock = blockText(en.uaSlotChat)
    expect(chatBlock).toContain(en.uaInvalid.replace('{reason}', 'unknown-placeholder'))
    expect(chatBlock).toContain('WorkBuddy/5.7.6 WorkBuddy AI/5.7.6')
  })

  it('renders no editor on a signed-out document', async () => {
    statusBody = { status: 'signed-out' }
    await mount(CN_CARD_VARIANT, { tab: false })
    expect(buttonLabels()).not.toContain(en.tabUserAgent)
  })
})
