import { spawn } from 'node:child_process'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const body = await response.json()
  return { status: response.status, body }
}

async function run() {
  const server = spawn('node', ['index.js'], { stdio: ['ignore', 'pipe', 'pipe'] })
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

  const messageId = `smoke-${Date.now()}`
  const payload = {
    messageId,
    type: 'capture.requested',
    sessionId: 'smoke-session',
    payload: { source: 'smoke' }
  }

  const first = await postJson('http://localhost:3000/api/events', payload)
  const second = await postJson('http://localhost:3000/api/events', payload)

  console.log('FIRST', first.status, first.body.status)
  console.log('SECOND', second.status, second.body.status)

  server.kill('SIGTERM')

  if (first.status !== 202 || first.body.status !== 'accepted') {
    throw new Error('Smoke test failed on first /api/events call')
  }
  if (second.status !== 200 || second.body.status !== 'duplicate') {
    throw new Error('Smoke test failed on duplicate /api/events call')
  }
}

run().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
