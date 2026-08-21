/**
 * Compile-time assertions for the client's type machinery.
 *
 * Checked by `npm run test:types`, never executed — it lives outside `test/suites/`, which is what
 * `test:smoke` globs, precisely so these calls are never issued as real requests.
 */

import { createClient } from '../../src/client/main.ts'
import type { Api } from '../fixtures/api-health/api.types.ts'

type Expect<T extends true> = T

/**
 * Exact type equality. The two single-use type parameters are the whole mechanism — deferring the
 * conditional makes the checker compare A and B invariantly rather than by assignability — so the
 * "used only once" rule cannot apply here.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

declare const baseUrl: string

const client = createClient<Api>({ baseUrl })

// An operation whose every option is optional takes no second argument at all.
const noArgs = await client.get('/health')

// Narrowing on a declared status narrows the body with it.
export type StatusIsLiteral = Expect<Equal<typeof noArgs.status, 200>>
export type BodyIsHealth = Expect<Equal<typeof noArgs.body.status, 'degraded' | 'down' | 'ok'>>
export type UptimeIsNumber = Expect<Equal<typeof noArgs.body.uptime, number>>

// Optional properties stay optional.
export type RegionOptional = Expect<Equal<typeof noArgs.body.region, string | undefined>>

// The declared query is accepted, and so are the common options.
await client.get('/health', { query: { verbose: true }, timeout: 100 })
await client.get('/health', { headers: { 'x-trace': 'abc' } })

// @ts-expect-error a path that is not in the Api is rejected
await client.get('/nope')

// @ts-expect-error a verb the path does not declare is rejected
await client.post('/health')

// @ts-expect-error the declared query type is enforced
await client.get('/health', { query: { verbose: 'yes' } })

// @ts-expect-error an operation with no request body does not accept one
await client.get('/health', { body: { a: 1 } })

// throwOnError collapses the result to the success body.
const strict = createClient<Api>({ baseUrl, throwOnError: true })
const body = await strict.get('/health')
export type ThrowOnErrorUnwraps = Expect<Equal<typeof body.status, 'degraded' | 'down' | 'ok'>>

// Middleware is chainable and preserves the client's type.
export type UseIsChainable = Expect<Equal<ReturnType<typeof client.use>, typeof client>>
