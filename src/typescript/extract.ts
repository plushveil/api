/**
 * Extracts an OpenAPI document from an `api/` folder.
 *
 * The filesystem rules are not duplicated here: `discoverRoutes` from the server package already
 * implements them, so both directions agree on what a route file is by construction.
 */

import { STATUS_CODES } from 'node:http'
import { relative } from 'node:path'
import type { Symbol as TsSymbol, Type } from 'typescript/unstable/sync'
import { compareCodePoints, type Document, type OperationObject, type ParameterLocation, type ParameterObject, type ResponseObject, type Schema } from '../openapi/main.ts'
import { discoverRoutes, patternToPath } from '../server/main.ts'
import { createHost, type Host } from './host.ts'
import { readDoc, words } from './jsdoc.ts'
import { applyTags, createComponents, typeOfSymbol, typeToSchema, UnsupportedTypeError, type WalkContext } from './type-to-schema.ts'

export interface ExtractOptions {
  project?: string
  title?: string
  version?: string
  description?: string
  servers?: string[]
  basePath?: string
  /**
   * Reuse a host across calls, as `--watch` does.
   */
  host?: Host
}

export interface ExtractResult {
  document: Document
  warnings: string[]
}

const LOCATIONS: [string, ParameterLocation][] = [
  ['path', 'path'],
  ['query', 'query'],
  ['headers', 'header'],
  ['cookies', 'cookie'],
]

/**
 * Extracts the document. Never writes anything; the CLI owns every side effect.
 */
export async function extractRoutes(dir: string, options: ExtractOptions = {}): Promise<ExtractResult> {
  const discovered = await discoverRoutes(dir, { basePath: options.basePath })
  const host = options.host ?? createHost({ project: options.project })
  const owned = options.host === undefined
  const warnings: string[] = []
  const components = createComponents()

  try {
    const paths: Record<string, Record<string, OperationObject>> = {}

    for (const route of discovered) {
      const errors = host.errorsIn(route.file)
      if (errors.length > 0) {
        // Refuse rather than extract from a file the compiler cannot resolve: the result would be
        // silently wrong, and ARCHITECTURE.md forbids a silent degrade.
        throw new UnsupportedTypeError(`${relative(process.cwd(), route.file)} does not typecheck, so its Operation cannot be read:\n  ${errors.join('\n  ')}`)
      }

      const exports = host.exportsOf(route.file)
      const operationSymbol = exports.get('Operation')
      if (!operationSymbol) {
        throw new UnsupportedTypeError(`${relative(process.cwd(), route.file)} does not export an \`Operation\` interface`)
      }

      const context: WalkContext = {
        checker: host.checker,
        components,
        active: new Set(),
        location: (symbol) => `${relative(process.cwd(), route.file)}${symbol ? `#${symbol.name}` : ''}`,
      }

      const operationType = host.checker.getDeclaredTypeOfSymbol(operationSymbol)
      const operation = buildOperation(context, operationType, operationSymbol, relative(process.cwd(), route.file))

      const path = patternToPath(route.pattern)
      paths[path] ??= {}
      paths[path][route.method] = operation
    }

    const document: Document = {
      openapi: '3.1.0',
      info: {
        title: options.title ?? '@plushveil/api',
        version: options.version ?? '0.0.0',
        ...(options.description ? { description: options.description } : {}),
      },
      ...(options.servers && options.servers.length > 0 ? { servers: options.servers.map((url) => ({ url })) } : {}),
      paths,
      ...(components.schemas.size > 0 ? { components: { schemas: Object.fromEntries([...components.schemas].sort((a, b) => compareCodePoints(a[0], b[0]))) } } : {}),
    }

    return { document, warnings }
  } finally {
    if (owned) host.close()
  }
}

function buildOperation(context: WalkContext, type: Type, symbol: TsSymbol, file: string): OperationObject {
  const doc = readDoc(context.checker, symbol)
  const members = new Map(context.checker.getPropertiesOfType(type).map((s) => [s.name, s]))

  const responsesSymbol = members.get('responses')
  if (!responsesSymbol) throw new UnsupportedTypeError(`The \`Operation\` in ${file} must declare \`responses\``, file)

  const operation: OperationObject = { responses: buildResponses(context, responsesSymbol, file) }

  const [operationId] = doc.tags.operationId ?? []
  if (operationId) operation.operationId = operationId
  if (doc.summary) operation.summary = doc.summary
  const description = doc.tags.description?.[0] ?? doc.body
  if (description) operation.description = description
  const tags = doc.tags.tags?.flatMap((value) => words(value)) ?? []
  if (tags.length > 0) operation.tags = tags
  if (doc.tags.deprecated) operation.deprecated = true
  if (doc.tags.security) {
    operation.security = doc.tags.security.map((value) => {
      const [name, ...scopes] = words(value)
      return name ? { [name]: scopes } : {}
    })
  }

  const parameters: ParameterObject[] = []
  for (const [member, location] of LOCATIONS) {
    const bag = members.get(member)
    if (!bag) continue
    for (const property of context.checker.getPropertiesOfType(typeOfSymbol(context, bag))) {
      const propertyDoc = readDoc(context.checker, property)
      const schema = applyTags(typeToSchema(context, typeOfSymbol(context, property), file), { tags: propertyDoc.tags })
      const parameter: ParameterObject = {
        name: property.name,
        in: location,
        required: location === 'path' ? true : (property.flags & (1 << 24)) === 0,
        schema,
      }
      if (propertyDoc.summary) parameter.description = propertyDoc.summary
      parameters.push(parameter)
    }
  }
  if (parameters.length > 0) operation.parameters = parameters

  const bodySymbol = members.get('body')
  if (bodySymbol) {
    const bodyType = typeOfSymbol(context, bodySymbol)
    const isNever = bodyType.isIntrinsicType() && bodyType.intrinsicName === 'never'
    if (!isNever) {
      operation.requestBody = {
        required: (bodySymbol.flags & (1 << 24)) === 0,
        content: { 'application/json': { schema: typeToSchema(context, bodyType, file) } },
      }
    }
  }

  return operation
}

function buildResponses(context: WalkContext, symbol: TsSymbol, file: string): Record<string, ResponseObject> {
  const responses: Record<string, ResponseObject> = {}
  const type = typeOfSymbol(context, symbol)
  const statuses = context.checker.getPropertiesOfType(type)

  if (statuses.length === 0) throw new UnsupportedTypeError(`The \`responses\` in ${file} declares no statuses`, file)

  for (const status of statuses) {
    const statusType = typeOfSymbol(context, status)
    const doc = readDoc(context.checker, status)
    const reason = STATUS_CODES[status.name] ?? 'Response'

    const empty = statusType.isIntrinsicType() && (statusType.intrinsicName === 'never' || statusType.intrinsicName === 'undefined')
    // OpenAPI requires a description on every response, so it defaults to the standard reason
    // phrase. The emitter must not turn that default back into an `@description` tag, or the round
    // trip would accrete one on every pass.
    const response: ResponseObject = { description: doc.tags.description?.[0] ?? doc.summary ?? reason }
    if (!empty) {
      const schema: Schema = typeToSchema(context, statusType, file)
      response.content = { 'application/json': { schema } }
    }
    responses[status.name] = response
  }

  return responses
}
