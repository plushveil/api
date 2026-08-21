/**
 * The JSON Schema subset this project supports, as documented in
 * docs/CONTRIBUTING/TYPE_MAPPING.md. OpenAPI 3.1 schemas are JSON Schema 2020-12, so there is
 * no separate dialect to reconcile.
 */

/**
 * Any JSON value.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/**
 * The `type` keyword's permitted values.
 */
export type SchemaType = 'array' | 'boolean' | 'integer' | 'null' | 'number' | 'object' | 'string'

/**
 * A schema in the supported subset. Every keyword here is either enforced by the validator or
 * an explicit annotation no-op; anything else is rejected at compile time.
 */
export interface Schema {
  $ref?: string

  type?: SchemaType | SchemaType[]
  format?: string
  enum?: Json[]
  const?: Json

  items?: Schema | false
  prefixItems?: Schema[]
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: Schema | boolean

  oneOf?: Schema[]
  allOf?: Schema[]
  anyOf?: Schema[]

  minLength?: number
  maxLength?: number
  pattern?: string
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  multipleOf?: number
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  minProperties?: number
  maxProperties?: number

  // Annotations. Carried through, never enforced.
  title?: string
  description?: string
  default?: Json
  example?: Json
  examples?: Json[]
  deprecated?: boolean
  readOnly?: boolean
  writeOnly?: boolean
  $comment?: string
  contentMediaType?: string
}

/**
 * One validation failure, in the shape SERVER.md documents for a 400 body.
 */
export interface Problem {
  /**
   * Where the value came from. Absent when validating a bare value.
   */
  in?: 'body' | 'cookie' | 'header' | 'path' | 'query'
  /**
   * JSON Pointer to the offending value, relative to what was validated.
   */
  path: string
  message: string
}

/**
 * A compiled schema. Returns an empty array when the value is valid.
 */
export type Validator = (value: unknown) => Problem[]

/**
 * Internal form: carries the pointer so nested checks can report a location.
 */
export type Check = (value: unknown, pointer: string) => Problem[]
