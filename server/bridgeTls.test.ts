import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBridgeAgent } from './bridgeTls'

// Scenario coverage for which bridges home-manager is willing to send its
// application key to. A local HTTPS server stands in for the bridge, with a
// test root CA in place of the Hue one. The fixture certificates in
// testdata/ name bridge ID 001788fffe000001 in their CN and carry no
// hostname or IP SAN, the same shape as a real bridge certificate.

const fixture = (name: string) =>
  readFileSync(join(__dirname, 'testdata', name), 'utf8')

const testRootCa = fixture('test-root-ca.pem')
const BRIDGE_ID = '001788fffe000001'

const servers: Server[] = []
const startBridge = async (certName: 'bridge' | 'impostor') => {
  const server = createServer(
    {
      cert: fixture(`${certName}-cert.pem`),
      key: fixture(`${certName}-key.pem`)
    },
    (_req, res) => res.end('[]')
  )
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `https://127.0.0.1:${(server.address() as AddressInfo).port}/api`
}

let genuineBridge: string
let impostorBridge: string

before(async () => {
  genuineBridge = await startBridge('bridge')
  impostorBridge = await startBridge('impostor')
})

after(() => servers.forEach((s) => s.close()))

const fetchVia = (url: string, bridgeId: string) =>
  fetch(url, {
    dispatcher: createBridgeAgent({ bridgeId, ca: [testRootCa] })
  } as RequestInit)

const causeOf = async (request: Promise<unknown>) => {
  const err = await request.then(
    () => assert.fail('expected the connection to be refused'),
    (e: Error & { cause?: Error }) => e
  )
  return String(err.cause?.message ?? err.message)
}

test('connects to the bridge when its certificate chains to the root CA and names the expected bridge ID', async () => {
  const res = await fetchVia(genuineBridge, BRIDGE_ID)
  assert.equal(await res.text(), '[]')
})

test('accepts the bridge ID regardless of case, as the Hue app shows it uppercase', async () => {
  const res = await fetchVia(genuineBridge, BRIDGE_ID.toUpperCase())
  assert.equal(res.status, 200)
})

test('refuses a certificate from the right CA that names a different bridge, saying which ID it got', async () => {
  const cause = await causeOf(fetchVia(genuineBridge, 'ecb5fafffe91e132'))
  assert.match(cause, /001788fffe000001/)
  assert.match(cause, /expected "ecb5fafffe91e132"/)
})

test('refuses a certificate naming the right bridge ID but not issued by the root CA', async () => {
  const cause = await causeOf(fetchVia(impostorBridge, BRIDGE_ID))
  assert.match(cause, /issuer|self.signed|verify/i)
})
