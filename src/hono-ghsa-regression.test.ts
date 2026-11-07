// Security regression guards pinning the Hono stack forced by package.json `overrides`
// (hono and @hono/node-server land transitively via @modelcontextprotocol/sdk). Each group
// reproduces one advisory against the real `@hono/node-server` transport, using raw request
// lines so the client cannot normalize the attack path:
//
//  - GHSA-jpvv-r467-5p4w (@hono/node-server < 2.1.6): a raw backslash in the request-target is
//    parsed as a path separator, so `/public/..\admin/secret` reaches the application rewritten
//    as `/admin/secret`, bypassing path-based access control. Fixed: transport answers 400.
//  - GHSA-rmxm-3fg6-px4f (@hono/node-server < 2.1.3): serveStatic decodes the request path a
//    second time, so encoded paths can reach files whose prefix middleware never ran. Fixed:
//    single decode; the protected file must never be served without credentials.
//  - GHSA-h7mg-cq63-vhpq (hono <= 4.13.15): RegExpRouter skips wildcard middleware for some
//    route patterns (case 2: route `/x*` vs middleware `/x/*`) and for paths with an encoded
//    line terminator (case 3), so a protected handler runs without its auth. Fixed: middleware
//    always applies — a protected route must refuse without credentials.

import * as http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { serve, type ServerType } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { type Context, Hono, type Next } from 'hono'

const auth = async (c: Context, next: Next) => {
  if (!c.req.header('authorization')) return c.text('UNAUTHORIZED', 401)
  await next()
}

const stripPrefix = (prefix: string) => (p: string) => p.replace(new RegExp(`^${prefix}`), '') || '/'

type RawResult = { status: number; body: string }

const rawRequest = (port: number, target: string, headers: Record<string, string> = {}): Promise<RawResult> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: target, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })

const withServer = async (app: Hono, run: (port: number) => Promise<void>): Promise<void> => {
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  try {
    await run(port)
  } finally {
    server.close()
  }
}

describe('GHSA-jpvv-r467-5p4w — raw backslash must never be routed as a path separator', () => {
  const corpus = [
    '/public/..\\admin/secret',
    '/public\\..\\admin/secret',
    '/admin\\secret',
  ]

  it('answers every raw-backslash request-target with 400 and never reaches the protected route', async () => {
    await withServer(
      (() => {
        const app = new Hono()
        let adminReached = false
        app.get('/public/*', (c) => c.text('PUBLIC AREA'))
        app.get('/admin/*', () => {
          adminReached = true
          return new Response('ADMIN AREA')
        })
        app.notFound((c) => c.text('NOT FOUND', 404))
        return app
      })(),
      async (port) => {
        for (const target of corpus) {
          const res = await rawRequest(port, target)
          expect(res.status, target).toBe(400)
          expect(res.body, target).not.toContain('ADMIN AREA')
        }
      },
    )
  })
})

describe('GHSA-rmxm-3fg6-px4f — serveStatic privacy containment under a guarded prefix', () => {
  let base: string
  let server: ServerType
  let port: number

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'track-hono-ghsa-'))
    mkdirSync(join(base, 'public', 'sub'), { recursive: true })
    mkdirSync(join(base, 'private'), { recursive: true })
    writeFileSync(join(base, 'public', 'ok.txt'), 'PUBLIC-CONTENT')
    writeFileSync(join(base, 'public', 'sub', 'hi.txt'), 'PUBLIC-SUB')
    writeFileSync(join(base, 'private', 'secret.txt'), 'PRIVATE-SECRET-1')

    const app = new Hono()
    app.use('/pub/private/*', auth)
    app.use('/pub/*', serveStatic({ root: base, rewriteRequestPath: stripPrefix('/pub') }))
    app.notFound((c) => c.text('NOT FOUND', 404))

    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    await once(server, 'listening')
    port = (server.address() as AddressInfo).port
  })

  afterAll(() => {
    server.close()
    rmSync(base, { recursive: true, force: true })
  })

  it('serves the public control row', async () => {
    const res = await rawRequest(port, '/pub/public/ok.txt')
    expect(res.status).toBe(200)
    expect(res.body).toContain('PUBLIC-CONTENT')
  })

  it('refuses the private file without credentials and serves it with credentials', async () => {
    const refused = await rawRequest(port, '/pub/private/secret.txt')
    expect(refused.status).toBe(401)
    expect(refused.body).not.toContain('PRIVATE-SECRET-1')

    const allowed = await rawRequest(port, '/pub/private/secret.txt', { authorization: 'Bearer ok' })
    expect(allowed.status).toBe(200)
    expect(allowed.body).toContain('PRIVATE-SECRET-1')
  })

  it('never serves the private file through backslash or encoded traversal corpus', async () => {
    const corpus = [
      '/pub/public/..\\private/secret.txt', // raw backslashes (transport must 400)
      '/pub/public/..%5Cprivate/secret.txt', // encoded backslash
      '/pub/public/..%5cprivate/secret.txt', // lowercase hex
      '/pub/public/sub/..%5C..%5Cprivate/secret.txt', // mixed ..%5C chains
      '/pub/public/..%255Cprivate/secret.txt', // double-encoded backslash
      '/pub/public/..%2541%5Cprivate/secret.txt', // double-encoded mix (%2541)
      '/pub/public/%2e%2e/private/secret.txt', // encoded dot segments
      '/pub/public/../private/secret.txt', // plain dot segments
    ]
    for (const target of corpus) {
      const res = await rawRequest(port, target)
      expect(res.body, target).not.toContain('PRIVATE-SECRET-1')
      expect([400, 401, 404], target).toContain(res.status)
    }
  })

  it('answers the raw-backslash serveStatic traversal with 400 (vulnerable versions served the file)', async () => {
    const res = await rawRequest(port, '/pub/public/..\\private/secret.txt')
    expect(res.status).toBe(400)
    expect(res.body).not.toContain('PRIVATE-SECRET-1')
  })
})

describe('GHSA-h7mg-cq63-vhpq — wildcard middleware must guard its routes (RegExpRouter)', () => {
  it('app.use("/x/*", auth) guards a route registered as "/x*" (case 2): refuses without credentials', async () => {
    await withServer(
      (() => {
        const app = new Hono()
        app.use('/x/*', auth)
        app.get('/x*', (c) => c.text('PROTECTED REACHED'))
        return app
      })(),
      async (port) => {
        for (const target of ['/x/panel', '/x', '/x/a/b']) {
          const res = await rawRequest(port, target)
          expect(res.status, target).toBe(401)
          expect(res.body, target).not.toContain('PROTECTED REACHED')
        }
      },
    )
  })

  it('app.use("*", auth) runs for every path, including an encoded line terminator (case 3)', async () => {
    await withServer(
      (() => {
        const app = new Hono()
        let mwRan = false
        app.use('*', async (c, next) => {
          mwRan = true
          return auth(c, next)
        })
        app.get('/ok', (c) => c.text('PROTECTED REACHED'))
        return app
      })(),
      async (port) => {
        const res = await rawRequest(port, '/ok%0A') // encoded '\n' — skipped middleware pre-fix
        expect(res.status).toBe(401)
        expect(res.body).not.toContain('PROTECTED REACHED')
        const control = await rawRequest(port, '/ok')
        expect(control.status).toBe(401)
      },
    )
  })

  it('middleware with an explicit default param pattern still guards its route (case 1 containment)', async () => {
    await withServer(
      (() => {
        const app = new Hono()
        app.use('/api/:tenant{[^/]+}/adm/*', auth)
        app.get('/api/:tenant/adm/:id', (c) => c.text(`PROTECTED REACHED ${c.req.param('id')}`))
        return app
      })(),
      async (port) => {
        const res = await rawRequest(port, '/api/t1/adm/9')
        expect(res.status).toBe(401)
        expect(res.body).not.toContain('PROTECTED REACHED')
      },
    )
  })
})
