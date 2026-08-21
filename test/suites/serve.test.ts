/**
 * `api-server` as a process: it starts, binds, serves the fixture over a real socket, and stops.
 *
 * Everything here goes through a child process and a TCP connection, because that is the only way
 * to cover the shebang, the `bin` mapping, port resolution from the environment, and shutdown.
 */

import * as assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { readJson, records } from '../helpers/json.ts'

const root = new URL('../../', import.meta.url).pathname
const FIXTURE = join(root, 'test/fixtures/api-health')
const SERVER = join(root, 'bin/server.ts')

interface Started {
  child: ChildProcessWithoutNullStreams
  port: number
  stderr: () => string
}

const running: ChildProcessWithoutNullStreams[] = []

after(() => {
  for (const child of running) if (!child.killed) child.kill('SIGKILL')
})

/**
 * Starts the server and waits until it reports the port it bound.
 *
 * Port 0 is used throughout so the tests never collide with each other or with anything already
 * listening; the actual port is read back from the startup line.
 */
function start(args: string[], env: Record<string, string> = {}): Promise<Started> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [SERVER, ...args], { cwd: root, env: { ...process.env, ...env } })
    running.push(child)

    let stderr = ''
    const timer = setTimeout(() => fail(new Error(`the server did not report a port within 30s: ${stderr}`)), 30_000)

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      const match = /http:\/\/[^:]+:(?<port>\d+)/.exec(stderr)
      if (match) {
        clearTimeout(timer)
        settle({ child, port: Number(match.groups?.port), stderr: () => stderr })
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      fail(new Error(`the server exited with ${code} before listening: ${stderr}`))
    })
  })
}

/**
 * Polls until `predicate` holds. The startup banner and the route list arrive in separate stderr
 * chunks, so reading straight after the port appears is a race.
 */
async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for expected output')
    await new Promise<void>((settle) => {
      setTimeout(settle, 25)
    })
  }
}

/**
 * Stops a server and resolves with its exit code.
 */
function stop(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((settle) => {
    child.once('close', (code) => settle(code))
    child.kill('SIGTERM')
  })
}

await describe('api-server', async () => {
  await it('starts, serves the fixture, and is reachable over HTTP', async () => {
    const server = await start([join(FIXTURE, 'api'), '--port', '0'])
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`)
      assert.equal(response.status, 200)

      const body = await readJson(response)
      assert.equal(body.status, 'ok')
      assert.equal(body.dependenciesReady, true)
      assert.equal(typeof body.uptime, 'number')
    } finally {
      await stop(server.child)
    }
  })

  await it('lists the routes it is serving', async () => {
    const server = await start([join(FIXTURE, 'api'), '--port', '0'])
    try {
      await until(() => /GET\s+\/health/.test(server.stderr()))
    } finally {
      await stop(server.child)
    }
  })

  await it('answers 404 for a path it does not serve', async () => {
    const server = await start([join(FIXTURE, 'api'), '--port', '0'])
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/nope`)
      assert.equal(response.status, 404)
    } finally {
      await stop(server.child)
    }
  })

  await it('honours a declared query parameter end to end', async () => {
    const server = await start([join(FIXTURE, 'api'), '--port', '0'])
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health?verbose=true`)
      const body = await readJson(response)
      assert.equal(body.region, 'local')
    } finally {
      await stop(server.child)
    }
  })

  await it('reads the port from the PORT environment variable', async () => {
    const server = await start([join(FIXTURE, 'api')], { PORT: '0' })
    try {
      assert.equal((await fetch(`http://127.0.0.1:${server.port}/health`)).status, 200)
    } finally {
      await stop(server.child)
    }
  })

  await it('lets --port override PORT', async () => {
    // Both are 0 here, so the check is that it starts at all rather than rejecting the conflict.
    const server = await start([join(FIXTURE, 'api'), '--port', '0'], { PORT: '65535' })
    try {
      assert.notEqual(server.port, 65535)
      assert.equal((await fetch(`http://127.0.0.1:${server.port}/health`)).status, 200)
    } finally {
      await stop(server.child)
    }
  })

  await it('validates requests when given a specification', async () => {
    const server = await start([join(FIXTURE, 'api'), '--port', '0', '--spec', join(FIXTURE, 'openapi.json'), '--validate'])
    try {
      const bad = await fetch(`http://127.0.0.1:${server.port}/health?verbose=maybe`)
      assert.equal(bad.status, 400)
      const problem = await readJson(bad)
      assert.equal(problem.error, 'validation_failed')
      assert.equal(records(problem, 'problems')[0]?.in, 'query')

      // And a valid request still succeeds, with the parameter coerced to a real boolean.
      assert.equal((await fetch(`http://127.0.0.1:${server.port}/health?verbose=true`)).status, 200)
    } finally {
      await stop(server.child)
    }
  })

  await it('stops cleanly on SIGTERM', async () => {
    const server = await start([join(FIXTURE, 'api'), '--port', '0'])
    const code = await stop(server.child)
    assert.equal(code, 0)
  })
})

await describe('api-server usage', async () => {
  function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((settle, fail) => {
      const child = spawn(process.execPath, [SERVER, ...args], { cwd: root, env: { ...process.env, ...env } })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      child.on('error', fail)
      child.on('close', (code) => settle({ code: code ?? -1, stdout, stderr }))
    })
  }

  await it('prints help and exits 0', async () => {
    const result = await run(['--help'])
    assert.equal(result.code, 0)
    for (const flag of ['--port', '--host', '--spec', '--validate', '--base-path']) {
      assert.ok(result.stdout.includes(flag), `--help is missing ${flag}`)
    }
  })

  await it('exits 2 for a port that is not a number', async () => {
    const result = await run([join(FIXTURE, 'api'), '--port', 'http'])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /invalid port/)
  })

  await it('exits 2 for a port outside the valid range', async () => {
    const result = await run([join(FIXTURE, 'api'), '--port', '70000'])
    assert.equal(result.code, 2)
  })

  await it('exits 1 when the folder does not exist', async () => {
    const result = await run([join(root, 'no', 'such', 'folder'), '--port', '0'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /does not exist/)
  })

  await it('exits 1 when the folder holds no route modules', async () => {
    // A server that binds a port and answers nothing hides a mount that did not land.
    const empty = await mkdtemp(join(tmpdir(), 'api-empty-'))
    const result = await run([empty, '--port', '0'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /no route modules found/)
  })

  await it('exits 2 when --validate is given without a specification', async () => {
    const result = await run([join(FIXTURE, 'api'), '--port', '0', '--validate', '--config', join(FIXTURE, 'missing.config.ts')])
    assert.notEqual(result.code, 0)
  })
})
