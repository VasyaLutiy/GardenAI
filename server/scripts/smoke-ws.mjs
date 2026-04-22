import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function run() {
  const port = 3100
  const server = spawn('node', ['index.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port) }
  })
  let started = false

  server.stdout.on('data', (chunk) => {
    const text = String(chunk)
    process.stdout.write(text)
    if (text.includes('GardenAI server started')) started = true
  })
  server.stderr.on('data', (chunk) => process.stderr.write(String(chunk)))

  for (let i = 0; i < 20 && !started; i += 1) {
    await wait(250)
  }
  if (!started) {
    server.kill('SIGTERM')
    throw new Error('Server did not start in time')
  }

  const sessionId = `smoke-ws-${Date.now()}`
  const ws = new WebSocket(`ws://localhost:${port}/ws?sessionId=${encodeURIComponent(sessionId)}`)

  const messagePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for ws message')), 5000)
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)
      if (data.type === 'capture.requested') {
        clearTimeout(timer)
        resolve(data)
      }
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('WebSocket error'))
    }
  })

  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('Failed to open websocket'))
  })

  const payload = {
    messageId: `smoke-msg-${Date.now()}`,
    type: 'capture.requested',
    sessionId,
    payload: { source: 'ws-smoke' }
  }

  const res = await fetch(`http://localhost:${port}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (res.status !== 202) {
    throw new Error(`Expected 202 from /api/events, got ${res.status}`)
  }

  const wsMessage = await messagePromise
  console.log('WS_EVENT', wsMessage.type, wsMessage.sessionId)

  ws.close()
  server.kill('SIGTERM')
}

run().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
