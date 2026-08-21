/**
 * `@plushveil/api/server` — a zero-dependency HTTP server for an `api/` folder.
 *
 * Nothing here imports `typescript`. The reference is docs/CONTRIBUTING/SERVER.md.
 */

/**
 * Per-request scratch space, augmentable by consumers:
 *
 * ```ts
 * declare module '@plushveil/api/server' {
 *   interface State {
 *     user: User
 *   }
 * }
 * ```
 *
 * Empty by design. It must be an `interface` rather than a type alias for declaration merging to
 * work, and it must start with no members so that a consumer's augmentation is the only source of
 * them — an index signature here would erase the very typing it exists to provide.
 */
// oxlint-disable-next-line typescript/no-empty-interface
export interface State {}

export { createRouter } from './router.ts'
export { createServer, type Server } from './server.ts'
export { discoverRoutes, loadRoutes, type DiscoveredRoute, type LoadRoutesOptions } from './load-routes.ts'
export { HttpError, ResponseValidationError, RouteError, ValidationError } from './errors.ts'
export { MalformedPathError, compareRoutes, matchSegments, parsePattern, patternToPath, splitPath } from './route-path.ts'
export { compose, run } from './compose.ts'
export { finalize } from './finalize.ts'
export { checkCoverage, indexSpec, resolveValidateOptions, validateRequest, validateResponse } from './validate.ts'
export { createContext, parseCookies, parseQuery, readBody, PayloadTooLargeError } from './context.ts'
export { createListener, sendResponse, toRequest } from './adapters/node.ts'

export type {
  AddOptions,
  AnyHandler,
  BodyInit,
  Content,
  Context,
  Handler,
  HandlerRequest,
  HandlerResult,
  HeadersInit,
  IndexedOperation,
  Middleware,
  OperationInfo,
  OperationShape,
  Payload,
  Problem,
  RequestContext,
  ResponseContext,
  ResponseFor,
  ResponseLike,
  Route,
  Router,
  Runtime,
  Segment,
  ServerOptions,
  SpecIndex,
  ValidateOptions,
} from './types.ts'
