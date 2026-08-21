import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

await describe('main', async () => {
  await it('works', async () => {
    assert.equal(true, true)
  })
})
