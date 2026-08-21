import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { coerce, compile, UnsupportedKeywordError, type Schema } from '../../src/schema/main.ts'

await describe('schema validator', async () => {
  await it('checks types', async () => {
    const check = compile({ type: 'string' })
    assert.deepEqual(check('a'), [])
    assert.equal(check(1).length, 1)
    assert.match(check(1)[0].message, /must be string/)
  })

  await it('treats integer and number distinctly', async () => {
    assert.deepEqual(compile({ type: 'integer' })(2), [])
    assert.equal(compile({ type: 'integer' })(2.5).length, 1)
    assert.deepEqual(compile({ type: 'number' })(2.5), [])
    assert.deepEqual(compile({ type: 'number' })(2), [])
  })

  await it('reports a wrong type exactly once, not once per keyword', async () => {
    // `type` is the only source of type problems; the object keywords bail on a mismatch.
    const check = compile({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })
    assert.equal(check(42).length, 1)
  })

  await it('locates a nested failure with a JSON Pointer', async () => {
    const check = compile({
      type: 'object',
      properties: { user: { type: 'object', properties: { email: { type: 'string', format: 'email' } } } },
    })
    const problems = check({ user: { email: 'nope' } })
    assert.equal(problems.length, 1)
    assert.equal(problems[0].path, '/user/email')
  })

  await it('enforces required, enum, const and additionalProperties', async () => {
    assert.equal(compile({ type: 'object', required: ['a'] })({}).length, 1)
    assert.equal(compile({ enum: ['a', 'b'] })('c').length, 1)
    assert.equal(compile({ const: 7 })(8).length, 1)
    assert.equal(compile({ type: 'object', properties: { a: {} }, additionalProperties: false })({ a: 1, b: 2 }).length, 1)
  })

  await it('validates the formats it knows and ignores the ones it does not', async () => {
    assert.equal(compile({ type: 'string', format: 'uuid' })('nope').length, 1)
    assert.deepEqual(compile({ type: 'string', format: 'uuid' })('3f2a9c1e-0000-4a7b-8c11-b6d2e4f50a91'), [])
    assert.deepEqual(compile({ type: 'string', format: 'something-invented' })('anything'), [])
  })

  await it('treats annotation keywords as no-ops', async () => {
    // Throwing on these would reject the documents api-port itself emits.
    const schema: Schema = { type: 'string', description: 'a', title: 'b', example: 'c', deprecated: true, readOnly: true }
    assert.deepEqual(compile(schema)('x'), [])
  })

  await it('rejects an out-of-subset keyword at compile time', async () => {
    // Typed as an intersection so the extra keyword is declared rather than asserted.
    const unsupported: Schema & { patternProperties: Record<string, unknown> } = { patternProperties: {} }
    assert.throws(() => compile(unsupported), UnsupportedKeywordError)
  })

  await it('resolves internal $refs and survives a cycle', async () => {
    const root = {
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: { next: { $ref: '#/components/schemas/Node' }, name: { type: 'string' } },
            required: ['name'],
          },
        },
      },
    }
    const check = compile({ $ref: '#/components/schemas/Node' }, { root })
    assert.deepEqual(check({ name: 'a', next: { name: 'b' } }), [])
    // `name` is missing at both depths, and recursion through the $ref reports each one.
    assert.deepEqual(
      check({ name: 'a', next: { next: {} } }).map((p) => p.path),
      ['/next/name', '/next/next/name'],
    )
  })

  await it('enforces string, number and array constraints', async () => {
    assert.equal(compile({ type: 'string', minLength: 2 })('a').length, 1)
    assert.equal(compile({ type: 'number', minimum: 5 })(4).length, 1)
    assert.equal(compile({ type: 'number', exclusiveMaximum: 5 })(5).length, 1)
    assert.equal(compile({ type: 'array', items: { type: 'string' } })(['a', 1]).length, 1)
    assert.equal(compile({ type: 'array', uniqueItems: true })([1, 1]).length, 1)
    assert.equal(compile({ type: 'array', prefixItems: [{ type: 'string' }], items: false })(['a', 'b']).length, 1)
  })

  await it('handles oneOf, anyOf and allOf', async () => {
    assert.deepEqual(compile({ oneOf: [{ type: 'string' }, { type: 'number' }] })('a'), [])
    assert.equal(compile({ oneOf: [{ type: 'string' }, { type: 'number' }] })(true).length, 1)
    assert.deepEqual(compile({ anyOf: [{ type: 'string' }, { type: 'number' }] })(1), [])
    assert.equal(compile({ allOf: [{ type: 'string' }, { minLength: 3 }] })('ab').length, 1)
  })
})

await describe('parameter coercion', async () => {
  await it('coerces the declared type', async () => {
    assert.equal(coerce({ type: 'number' }, '2.5'), 2.5)
    assert.equal(coerce({ type: 'integer' }, '2'), 2)
    assert.equal(coerce({ type: 'boolean' }, 'true'), true)
    assert.equal(coerce({ type: 'boolean' }, 'false'), false)
    assert.equal(coerce({ type: 'null' }, 'null'), null)
    assert.equal(coerce({ type: 'string' }, '2'), '2')
  })

  await it('leaves an uncoercible value alone so the validator reports it', async () => {
    // Substituting a fallback here would hide the failure instead of surfacing it.
    assert.equal(coerce({ type: 'number' }, 'abc'), 'abc')
    assert.equal(coerce({ type: 'integer' }, '2.5'), '2.5')
  })

  await it('coerces array items and accepts a repeated parameter', async () => {
    assert.deepEqual(coerce({ type: 'array', items: { type: 'number' } }, ['1', '2']), [1, 2])
    assert.deepEqual(coerce({ type: 'array', items: { type: 'string' } }, 'a'), ['a'])
  })

  await it('returns undefined for an absent value', async () => {
    assert.equal(coerce({ type: 'string' }, undefined), undefined)
  })
})
