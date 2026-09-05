/**
 * The OpenAPI 3.1 document model, limited to what this project reads and writes.
 */

import type { Json, Schema } from '../schema/main.ts'

export type { Json, Schema, SchemaType } from '../schema/main.ts'

/**
 * HTTP methods that map to a route file, in the canonical emission order.
 */
export const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const

export type Method = (typeof METHODS)[number]

export type ParameterLocation = 'cookie' | 'header' | 'path' | 'query'

export interface ParameterObject {
  name: string
  in: ParameterLocation
  required?: boolean
  deprecated?: boolean
  description?: string
  style?: string
  explode?: boolean
  schema?: Schema
}

export interface MediaTypeObject {
  schema?: Schema
  /**
   * Marks a binary media type whose body a handler receives as a `ReadableStream<Uint8Array>`
   * rather than a buffered `Uint8Array`. Round-trips through `Content<M, ReadableStream<Uint8Array>>`
   * so the TypeScript side can tell "buffered" and "streamed" apart -- both describe the same
   * `{ type: 'string', format: 'binary' }` schema, so the schema alone cannot.
   */
  'x-stream'?: boolean
}

export interface RequestBodyObject {
  description?: string
  required?: boolean
  content: Record<string, MediaTypeObject>
}

export interface ResponseObject {
  description: string
  content?: Record<string, MediaTypeObject>
}

export interface OperationObject {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  deprecated?: boolean
  security?: Record<string, string[]>[]
  parameters?: ParameterObject[]
  requestBody?: RequestBodyObject
  responses: Record<string, ResponseObject>
}

export type PathItemObject = Partial<Record<Method, OperationObject>>

export interface ComponentsObject {
  schemas?: Record<string, Schema>
  securitySchemes?: Record<string, Json>
}

export interface InfoObject {
  title: string
  version: string
  description?: string
}

export interface ServerObject {
  url: string
  description?: string
}

export interface Document {
  openapi: string
  info: InfoObject
  servers?: ServerObject[]
  paths: Record<string, PathItemObject>
  components?: ComponentsObject
}

/**
 * True when `value` is one of the methods that maps to a route file.
 */
export function isMethod(value: string): value is Method {
  return (METHODS as readonly string[]).includes(value)
}
