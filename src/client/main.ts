/**
 * `@plushveil/api/client` — a zero-dependency, type-safe client for any `api.types.ts`.
 *
 * Nothing here imports `typescript`, and nothing here is generated: one generated types file plus
 * one generic function. The reference is docs/CONTRIBUTING/CLIENT.md.
 */

export { createClient, interpolate, serializeQuery } from './client.ts'
export { ApiRequestError, ApiResponseError } from './errors.ts'

export type {
  ApiResponse,
  ApiResult,
  ApiShape,
  BodyAt,
  CallOptions,
  CallResult,
  Client,
  ClientMiddleware,
  ClientOptions,
  OperationShape,
  PathsWith,
  RequestArgs,
  RequestOptions,
  RequiredKeysOf,
  SuccessBody,
  Verb,
} from './types.ts'
