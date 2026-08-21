/**
 * The TypeScript side of the round trip: type extraction in one direction, code emission in the
 * other. Only `bin/` and this package may import `typescript`.
 */

export { createHost, HostError, type Host, type HostOptions } from './host.ts'
export { extractRoutes, type ExtractOptions, type ExtractResult } from './extract.ts'
export { emitAll, emitApiTypes, emitRoute, emitSchemas, routeFileFor, typeOf, UnsupportedHandlerModeError, type Emitted, type EmitRouteOptions } from './emit.ts'
export { readDoc, words, type Doc } from './jsdoc.ts'
export { applyTags, createComponents, typeToSchema, UnsupportedTypeError, type Components, type WalkContext } from './type-to-schema.ts'
