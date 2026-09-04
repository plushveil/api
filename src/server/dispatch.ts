import type { Document } from '../openapi/main.ts'
import { run } from './compose.ts'
import { PayloadTooLargeError, readBody } from './context.ts'
import { HttpError, ResponseValidationError } from './errors.ts'
import { finalize } from './finalize.ts'
import { MalformedPathError } from './route-path.ts'
import { applyResult } from './router.ts'
import type { Context, Router, Runtime } from './types.ts'
import { validateRequest, validateResponse } from './validate.ts'

/**
 * Runs one request through server middleware, validation, the router, and finalisation.
 *
 * There are two error boundaries. The inner one sits just outside validation and the router, so a
 * handler failure mutates the response and outer middleware still unwinds normally. The outer one
 * catches middleware that throws on the way in, and finalisation itself — a failure there must
 * still produce a Response rather than rejecting.
 */
export async function dispatch(runtime: Runtime, router: Router, context: Context, document: Document | undefined): Promise<Response> {
  try {
    await run(runtime.middleware, context, async () => {
      try {
        if (context.request.raw === undefined || context.request.body === undefined) {
          // Nothing has read the body yet; do it before validation needs it.
          context.request.body = await readBodyFor(context, runtime)
        }
        await router.handle(context, {
          beforeHandler: document ? (matched) => validateRequest(runtime, matched, document) : undefined,
          afterHandler: document ? (matched) => reportResponseProblems(runtime, matched, document) : undefined,
        })
      } catch (error) {
        await applyError(runtime, context, error)
      }
    })
  } catch (error) {
    await applyError(runtime, context, error)
  }

  try {
    return finalize(context)
  } catch (error) {
    // Finalisation failed, so build the fallback by hand rather than recursing through it.
    console.error('Failed to finalise the response', error)
    return new Response(JSON.stringify({ error: 'internal', message: 'Something went wrong.' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }
}

async function readBodyFor(context: Context, runtime: Runtime): Promise<unknown> {
  const web = context.request.raw instanceof Request ? context.request.raw : undefined
  if (!web) return context.request.body
  return readBody(web, runtime.options.bodyLimit ?? 1_048_576)
}

function reportResponseProblems(runtime: Runtime, context: Context, document: Document): void {
  const problems = validateResponse(runtime, context, document)
  if (problems.length === 0) return
  if (runtime.validate?.response === 'warn') {
    console.warn(`Response for ${context.operation?.method} ${context.operation?.path} does not match the specification`, problems)
    return
  }
  throw new ResponseValidationError(problems)
}

async function applyError(runtime: Runtime, context: Context, error: unknown): Promise<void> {
  const normalised = normalise(error)
  try {
    const result = await runtime.onError(normalised, context)
    if (result instanceof Response) {
      context.response.status = result.status
      context.response.body = result
      return
    }
    applyResult(context, result)
  } catch (secondary) {
    // The error handler itself failed. Report both, and fall back to a bare 500.
    console.error('The onError handler threw', secondary, { cause: normalised })
    context.response.status = 500
    context.response.body = { type: 'error', error: { code: 500, message: 'Internal Server Error' } }
  }
}

/**
 * Converts the errors this layer knows about into `HttpError`s.
 */
function normalise(error: unknown): unknown {
  if (error instanceof MalformedPathError) {
    return new HttpError(400, {
      error: 'validation_failed',
      message: 'The request does not match the specification.',
      problems: [{ in: 'path', path: '', message: 'is not valid percent-encoding' }],
    })
  }
  if (error instanceof PayloadTooLargeError) {
    return new HttpError(413, { error: 'payload_too_large', message: error.message })
  }
  return error
}

/**
 * The built-in `onError`: honour `HttpError`, log anything else and say nothing about it.
 */
export async function defaultOnError(error: unknown, context: Context): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
  if (error instanceof HttpError) {
    return { status: error.status, body: error.body, headers: error.headers }
  }
  console.error(`Unhandled error in ${context.request.method} ${context.request.url.pathname}`, error)
  return { status: 500, body: { error: 'internal', message: 'Something went wrong.' } }
}
