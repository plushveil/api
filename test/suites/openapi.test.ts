import * as assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { diff, parseDocument, SpecError, stringify, type Document } from '../../src/openapi/main.ts'

const minimal = (): Document => ({
  openapi: '3.1.0',
  info: { title: 'Test', version: '1.0.0' },
  paths: {},
})

await describe('openapi writer', async () => {
  await it('emits responses in numeric order however they were inserted', async () => {
    const document = minimal()
    // Insert 404 first. Note that a JS object hoists integer-like keys anyway, which is exactly
    // why the writer builds an array of entries instead of trusting insertion order.
    document.paths['/x'] = {
      get: {
        responses: {
          404: { description: 'Not Found' },
          200: { description: 'OK' },
        },
      },
    }

    const text = stringify(document)
    assert.ok(text.indexOf('"200"') < text.indexOf('"404"'), 'expected 200 before 404')
  })

  await it('sorts components, properties, required and enum by name', async () => {
    const document = minimal()
    document.components = {
      schemas: {
        Zebra: { type: 'object', properties: { b: { type: 'string' }, a: { type: 'string' } }, required: ['b', 'a'] },
        Apple: { type: 'string', enum: ['zulu', 'alpha'] },
      },
    }

    const text = stringify(document)
    assert.ok(text.indexOf('"Apple"') < text.indexOf('"Zebra"'))
    assert.ok(text.indexOf('"a"') < text.indexOf('"b"'))
    assert.match(text, /"required": \[\s*"a",\s*"b"\s*\]/)
    assert.match(text, /"enum": \[\s*"alpha",\s*"zulu"\s*\]/)
  })

  await it('puts type before description, per the fixed keyword template', async () => {
    const text = stringify({
      ...minimal(),
      components: { schemas: { A: { description: 'a thing', type: 'object', properties: {} } } },
    })
    assert.ok(text.indexOf('"type"') < text.indexOf('"description"'))
  })

  await it('is idempotent and does not mutate the document', async () => {
    const document = minimal()
    document.components = { schemas: { A: { type: 'object', properties: { b: {}, a: {} }, required: ['b', 'a'] } } }
    const before = JSON.parse(JSON.stringify(document)) as unknown

    const once = stringify(document)
    const twice = stringify(document)

    assert.equal(once, twice)
    assert.deepEqual(document, before, "stringify must not reorder the caller's document")
  })

  await it('keeps an empty schema, which means `unknown`', async () => {
    const text = stringify({ ...minimal(), components: { schemas: { Anything: {} } } })
    assert.match(text, /"Anything": \{\}/)
  })

  await it('refuses a non-finite number rather than emitting invalid JSON', async () => {
    const document = minimal()
    document.components = { schemas: { A: { type: 'number', default: Number.POSITIVE_INFINITY } } }
    assert.throws(() => stringify(document), SpecError)
  })

  await it('ends with exactly one newline and uses LF', async () => {
    const text = stringify(minimal())
    assert.ok(text.endsWith('}\n'))
    assert.ok(!text.includes('\r'))
    assert.ok(!text.endsWith('\n\n'))
  })
})

await describe('openapi reader', async () => {
  await it('round-trips the committed openapi.json byte for byte', async () => {
    const bytes = await readFile(new URL('../fixtures/api-health/openapi.json', import.meta.url), 'utf8')
    assert.equal(stringify(parseDocument(bytes)), bytes)
  })

  await it('rejects a document that is not usable', async () => {
    assert.throws(() => parseDocument('not json'), SpecError)
    assert.throws(() => parseDocument('[]'), SpecError)
    assert.throws(() => parseDocument('{}'), SpecError)
    assert.throws(() => parseDocument('{"openapi":"3.1.0"}'), SpecError)
    assert.throws(() => parseDocument('{"openapi":"3.1.0","info":{"title":"a","version":"1"},"paths":{"/x":{"get":{}}}}'), SpecError)
  })
})

await describe('diff', async () => {
  await it('is empty for identical text', async () => {
    assert.equal(diff('a\nb\n', 'a\nb\n'), '')
  })

  await it('reports one hunk with context', async () => {
    const report = diff('a\nb\nc\n', 'a\nB\nc\n')
    assert.match(report, /^--- disk/m)
    assert.match(report, /^\+\+\+ generated/m)
    assert.match(report, /^-b$/m)
    assert.match(report, /^\+B$/m)
  })

  await it('truncates rather than printing an enormous diff', async () => {
    const report = diff(Array.from({ length: 500 }, (_, i) => `a${i}`).join('\n'), Array.from({ length: 500 }, (_, i) => `b${i}`).join('\n'), { limit: 20 })
    assert.ok(report.split('\n').length <= 21)
    assert.match(report, /more lines$/)
  })
})
