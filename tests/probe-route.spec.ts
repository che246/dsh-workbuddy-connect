import { createServer, request as httpRequest, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createProbeKey, workBuddyProbeHandler, type WorkBuddyProbeRouteOptions } from '../src/probe-route.ts'

/**
 * Offline tests for the probe control route, the plugin's only state-changing
 * endpoint. Two guards must both hold before anything happens: the loopback
 * Host/Origin check (drops DNS-rebinding pages) and the in-process key (proves
 * the caller was the same-origin card, since any local process can write
 * `Host: 127.0.0.1`).
 */

let server: Server | undefined

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() => resolve()))
    server = undefined
  }
})

/** Mount the handler on an ephemeral port and return its origin + key. */
async function mount(deps?: Partial<WorkBuddyProbeRouteOptions>): Promise<{ origin: string; key: string; calls: string[] }> {
  const key = createProbeKey()
  const calls: string[] = []
  const handler = workBuddyProbeHandler({
    probe: async modelId => {
      calls.push(modelId)
      return { state: 'ok' }
    },
    clear: () => { calls.push('clear') },
    ...deps,
  }, key)
  server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { origin: `http://127.0.0.1:${address.port}`, key, calls }
}

/** POST one control action. */
async function post(
  origin: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(origin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/**
 * POST with full control over the request headers, including `Host`, which
 * `fetch` refuses to set. Needed to exercise the rebinding guard.
 */
async function postRaw(
  origin: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(origin)
  const payload = JSON.stringify(body)
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      path: '/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed: Record<string, unknown> = {}
        try { parsed = JSON.parse(text) as Record<string, unknown> } catch { /* leave empty */ }
        resolve({ status: response.statusCode ?? 0, body: parsed })
      })
    })
    request.on('error', reject)
    request.end(payload)
  })
}

describe('probe control route', () => {
  it('accepts a probe carrying the correct key', async () => {
    const { origin, key, calls } = await mount()
    const result = await post(origin, { action: 'probe', model: 'auto' }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result.status).toBe(200)
    expect(result.body['state']).toBe('ok')
    expect(calls).toEqual(['auto'])
  })

  it('rejects a probe with no key', async () => {
    const { origin, calls } = await mount()
    const result = await post(origin, { action: 'probe', model: 'auto' })
    expect(result.status).toBe(403)
    expect(result.body['error']).toBe('invalid-probe-key')
    // Nothing was spent.
    expect(calls).toEqual([])
  })

  it('rejects a wrong key of the same length', async () => {
    const { origin, key, calls } = await mount()
    const wrong = `${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`
    const result = await post(origin, { action: 'probe', model: 'auto' }, { 'X-WorkBuddy-Probe-Key': wrong })
    expect(result.status).toBe(403)
    expect(calls).toEqual([])
  })

  it('rejects a non-loopback Host even with the right key', async () => {
    const { origin, key, calls } = await mount()
    // `fetch` refuses to set a `Host` header (it is a forbidden header name),
    // so a spoofed Host has to go through the raw HTTP client — which is
    // exactly what a DNS-rebinding page's request looks like on the wire.
    const result = await postRaw(origin, { action: 'probe', model: 'auto' }, {
      'X-WorkBuddy-Probe-Key': key,
      'Host': 'attacker.example',
    })
    expect(result.status).toBe(403)
    expect(result.body['error']).toBe('request-not-trusted')
    expect(calls).toEqual([])
  })

  it('rejects a non-loopback Origin even with the right key', async () => {
    const { origin, key, calls } = await mount()
    const result = await post(origin, { action: 'probe', model: 'auto' }, {
      'X-WorkBuddy-Probe-Key': key,
      'Origin': 'https://attacker.example',
    })
    expect(result.status).toBe(403)
    expect(calls).toEqual([])
  })

  it('refuses GET', async () => {
    const { origin, key } = await mount()
    const response = await fetch(origin, { headers: { 'X-WorkBuddy-Probe-Key': key } })
    expect(response.status).toBe(405)
  })

  it('rejects a malformed action, and a probe with no model', async () => {
    const { origin, key, calls } = await mount()
    const headers = { 'X-WorkBuddy-Probe-Key': key }
    expect((await post(origin, { action: 'nope' }, headers)).status).toBe(400)
    expect((await post(origin, { action: 'probe' }, headers)).status).toBe(400)
    expect((await post(origin, { action: 'probe', model: '   ' }, headers)).status).toBe(400)
    expect((await post(origin, 'not json', headers)).status).toBe(400)
    expect(calls).toEqual([])
  })

  it('rejects an oversized body', async () => {
    const { origin, key } = await mount()
    const result = await post(origin, { action: 'probe', model: 'x'.repeat(5000) }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result.status).toBe(413)
  })

  it('accepts a clear action', async () => {
    const { origin, key, calls } = await mount()
    const result = await post(origin, { action: 'clear' }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result.status).toBe(200)
    expect(calls).toEqual(['clear'])
  })

  it('accepts the maximum-context preference only when the host supports it', async () => {
    let enabled: boolean | undefined
    const { origin, key } = await mount({
      setMaximumContextWindow: async value => {
        enabled = value
        return { state: 'updated' }
      },
    })
    const result = await post(origin, { action: 'set-maximum-context-window', enabled: true }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result).toMatchObject({ status: 200, body: { state: 'updated' } })
    expect(enabled).toBe(true)
  })

  it('routes a UA template to its slot, and a null template as a clear', async () => {
    const writes: [string, string | null][] = []
    const { origin, key } = await mount({
      setUserAgent: async (slot, template) => {
        writes.push([slot, template])
        return { state: 'updated' }
      },
    })
    const headers = { 'X-WorkBuddy-Probe-Key': key }
    expect((await post(origin, { action: 'set-user-agent', slot: 'chat', template: 'X/{appVersion}' }, headers)).status).toBe(200)
    expect((await post(origin, { action: 'set-user-agent', slot: 'catalog', template: null }, headers)).status).toBe(200)
    expect(writes).toEqual([['chat', 'X/{appVersion}'], ['catalog', null]])
  })

  it('rejects a UA write with no slot, or a non-string template', async () => {
    // A bare template with no slot has no honest target, so it is refused rather
    // than guessed at — routing it by default would change a request family the
    // user never named.
    const writes: unknown[] = []
    const { origin, key } = await mount({
      setUserAgent: async (slot, template) => {
        writes.push([slot, template])
        return { state: 'updated' }
      },
    })
    const headers = { 'X-WorkBuddy-Probe-Key': key }
    expect((await post(origin, { action: 'set-user-agent', template: 'X' }, headers)).status).toBe(400)
    expect((await post(origin, { action: 'set-user-agent', slot: '', template: 'X' }, headers)).status).toBe(400)
    expect((await post(origin, { action: 'set-user-agent', slot: 'chat', template: 42 }, headers)).status).toBe(400)
    expect(writes).toEqual([])
  })

  it('reports a refused UA template without storing it', async () => {
    // The handler is the pass-through; the *refusal* is the host callback's, and
    // this pins that its reason reaches the caller instead of a bare 200.
    const { origin, key } = await mount({
      setUserAgent: async () => ({ state: 'failed', reason: 'control characters are not allowed' }),
    })
    const result = await post(origin, { action: 'set-user-agent', slot: 'chat', template: 'X' }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result).toMatchObject({ status: 200, body: { state: 'failed', reason: 'control characters are not allowed' } })
  })

  it('answers 404 for a UA write on a host that offers no editor', async () => {
    const { origin, key } = await mount()
    const result = await post(origin, { action: 'set-user-agent', slot: 'chat', template: 'X' }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result.status).toBe(404)
    expect(result.body['error']).toBe('user-agent-setting-not-supported')
  })

  it('keeps the same guards in front of a UA write', async () => {
    let wrote = false
    const { origin, key } = await mount({
      setUserAgent: async () => {
        wrote = true
        return { state: 'updated' }
      },
    })
    const body = { action: 'set-user-agent', slot: 'chat', template: 'X' }
    expect((await post(origin, body)).status).toBe(403)
    expect((await postRaw(origin, body, { 'X-WorkBuddy-Probe-Key': key, 'Host': 'attacker.example' })).status).toBe(403)
    expect((await post(origin, body, { 'X-WorkBuddy-Probe-Key': key, 'Origin': 'https://attacker.example' })).status).toBe(403)
    expect(wrote).toBe(false)
  })

  it('mints a distinct key per call', () => {
    expect(createProbeKey()).not.toBe(createProbeKey())
  })
})
