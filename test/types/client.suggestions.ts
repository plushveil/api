/**
 * Compile-time assertions for what the client offers and what it returns.
 *
 * Two properties, both of which are only observable to the type checker:
 *
 * 1. Endpoints are suggested correctly — each verb offers exactly the paths that declare it.
 * 2. Responses carry the right type definitions — status is a literal union, the body follows from the status, and an empty body is `undefined` rather than `never`.
 *
 * Checked by `npm run test:types`. This file lives outside `test/suites/`, which is what
 * `test:smoke` globs, so nothing here is ever executed and no request is ever issued.
 */

import { createClient, type Client, type PathsWith } from '../../src/client/main.ts'

type Expect<T extends true> = T

/**
 * Exact type equality. The two single-use type parameters are the whole mechanism — deferring the
 * conditional makes the checker compare A and B invariantly rather than by assignability.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

interface User {
  id: string
  name: string
}

interface ApiError {
  code: string
  message: string
}

/**
 * A deliberately uneven API: every path declares a different set of verbs, so "the paths that
 * declare this verb" is a different answer for each one.
 */
interface Catalogue {
  '/health': {
    get: { responses: { 200: { status: 'ok' } } }
  }
  '/users': {
    get: { query: { page?: number }; responses: { 200: User[] } }
    post: { body: { name: string }; responses: { 201: User; 409: ApiError } }
  }
  '/users/{userId}': {
    get: { path: { userId: string }; responses: { 200: User; 404: ApiError } }
    delete: { path: { userId: string }; responses: { 204: never; 404: ApiError } }
  }
  '/sessions': {
    post: { body: { token: string }; responses: { 200: { token: string } } }
  }
}

declare const baseUrl: string
const client = createClient<Catalogue>({ baseUrl })

/* -------------------------------------------------------------------------------------------------
 * 1. Endpoints are suggested correctly
 * ---------------------------------------------------------------------------------------------- */

// `PathsWith` is what drives the suggestion list for a verb.
export type GetSuggests = Expect<Equal<PathsWith<Catalogue, 'get'>, '/health' | '/users' | '/users/{userId}'>>
export type PostSuggests = Expect<Equal<PathsWith<Catalogue, 'post'>, '/sessions' | '/users'>>
export type DeleteSuggests = Expect<Equal<PathsWith<Catalogue, 'delete'>, '/users/{userId}'>>

// A verb no path declares suggests nothing, so any call is rejected rather than falling back to string.
export type PutSuggestsNothing = Expect<Equal<PathsWith<Catalogue, 'put'>, never>>
export type PatchSuggestsNothing = Expect<Equal<PathsWith<Catalogue, 'patch'>, never>>

// The suggestion reaches the method signature, which is what an editor completes from.
export type GetParameterIsTheUnion = Expect<Equal<Parameters<typeof client.get>[0], '/health' | '/users' | '/users/{userId}'>>
export type DeleteParameterIsTheUnion = Expect<Equal<Parameters<typeof client.delete>[0], '/users/{userId}'>>

// Every suggested path really is callable.
await client.get('/health')
await client.get('/users')
await client.get('/users/{userId}', { path: { userId: 'u1' } })
await client.delete('/users/{userId}', { path: { userId: 'u1' } })
await client.post('/sessions', { body: { token: 't' } })

// @ts-expect-error a path that is not in the Api is not suggested
await client.get('/nope')

// @ts-expect-error `/sessions` declares post, not get
await client.get('/sessions')

// @ts-expect-error `/health` declares get, not delete
await client.delete('/health')

// @ts-expect-error no path declares put, so there is nothing to call
await client.put('/users')

// There is deliberately no `trace` method: TRACE is a forbidden method for `fetch`.
// @ts-expect-error trace is not part of the client surface
await client.trace('/health')

/* -------------------------------------------------------------------------------------------------
 * 2. Responses have correct type definitions
 * ---------------------------------------------------------------------------------------------- */

const single = await client.get('/health')

// One declared status collapses to that literal, not `number`.
export type SingleStatusIsLiteral = Expect<Equal<typeof single.status, 200>>
export type SingleBodyIsExact = Expect<Equal<typeof single.body, { status: 'ok' }>>
export type MetadataIsStandard = Expect<Equal<typeof single.headers, Headers>>
export type ResponseIsStandard = Expect<Equal<typeof single.response, Response>>
export type OkIsBoolean = Expect<Equal<typeof single.ok, boolean>>

const many = await client.get('/users/{userId}', { path: { userId: 'u1' } })

// Several declared statuses become a union of exactly those literals.
export type ManyStatusIsUnion = Expect<Equal<typeof many.status, 200 | 404>>

// Before narrowing, the body is the union of the declared bodies.
export type ManyBodyIsUnion = Expect<Equal<typeof many.body, ApiError | User>>

// Narrowing on the status narrows the body with it. Expressed with `Extract` rather than an `if`
// block, because a type alias cannot be exported from inside one — the property under test is the
// same either way: the result is a discriminated union keyed on `status`.
type Arm<Status extends number> = Extract<typeof many, { status: Status }>
export type NarrowedToUser = Expect<Equal<Arm<200>['body'], User>>
export type NarrowedToError = Expect<Equal<Arm<404>['body'], ApiError>>

// And it narrows in a control-flow position too, which is how it is actually used.
if (many.status === 200) {
  const email: User = many.body
  void email
}

const created = await client.post('/users', { body: { name: 'Ada' } })
export type CreatedStatusIsUnion = Expect<Equal<typeof created.status, 201 | 409>>

const removed = await client.delete('/users/{userId}', { path: { userId: 'u1' } })
export type RemovedStatusIsUnion = Expect<Equal<typeof removed.status, 204 | 404>>

// A response declared `never` has no body, expressed as `undefined` rather than `never` — the
// latter would make the property unreadable rather than merely empty.
export type EmptyBodyIsUndefined = Expect<Equal<Extract<typeof removed, { status: 204 }>['body'], undefined>>
export type PresentBodyStillTyped = Expect<Equal<Extract<typeof removed, { status: 404 }>['body'], ApiError>>

const collection = await client.get('/users')
export type ArrayBodyIsPreserved = Expect<Equal<typeof collection.body, User[]>>

// A status the operation never declares is a type error, so a typo cannot silently never match.
// @ts-expect-error /health only declares 200
const impossible = single.status === 404
void impossible

/* --- throwOnError changes the return type to the success bodies alone --- */

const strict = createClient<Catalogue>({ baseUrl, throwOnError: true })

const strictBody = await strict.get('/users/{userId}', { path: { userId: 'u1' } })
export type ThrowOnErrorUnwrapsToSuccessBody = Expect<Equal<typeof strictBody, User>>

const strictCreated = await strict.post('/users', { body: { name: 'Ada' } })
// 409 is dropped: only 2xx bodies survive, because the rest throw.
export type ThrowOnErrorDropsErrors = Expect<Equal<typeof strictCreated, User>>

/* --- the client type itself --- */

// `Client<Catalogue>` already means the non-throwing variant, so spelling the `false` out would be
// redundant — and the default being the non-throwing one is exactly what this asserts.
export type DefaultClientIsNotThrowing = Expect<Equal<typeof client, Client<Catalogue>>>
export type StrictClientIsThrowing = Expect<Equal<typeof strict, Client<Catalogue, true>>>
