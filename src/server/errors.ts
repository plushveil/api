import type { Problem } from '../schema/main.ts'

/**
 * A deliberate HTTP failure. Throw this rather than returning an undeclared status.
 */
export class HttpError extends Error {
  readonly status: number
  readonly body: unknown
  readonly headers: Record<string, string> | undefined

  constructor(status: number, body?: unknown, headers?: Record<string, string>) {
    super(`HTTP ${status}`)
    this.name = 'HttpError'
    this.status = status
    this.body = body
    this.headers = headers
  }
}

/**
 * A request that does not match the specification.
 */
export class ValidationError extends HttpError {
  readonly problems: Problem[]

  constructor(problems: Problem[]) {
    super(400, {
      error: 'validation_failed',
      message: 'The request does not match the specification.',
      problems,
    })
    this.name = 'ValidationError'
    this.problems = problems
  }
}

/**
 * A request body sent with a `content-type` the matched operation does not declare.
 */
export class UnsupportedMediaTypeError extends HttpError {
  constructor(contentType: string, accepted: readonly string[]) {
    super(415, {
      error: 'unsupported_media_type',
      message: `${contentType || '(no content-type)'} is not one of the media types this operation accepts: ${accepted.length > 0 ? accepted.join(', ') : 'none'}.`,
    })
    this.name = 'UnsupportedMediaTypeError'
  }
}

/**
 * A response that does not match the specification.
 */
export class ResponseValidationError extends HttpError {
  readonly problems: Problem[]

  constructor(problems: Problem[]) {
    super(500, {
      error: 'response_validation_failed',
      message: 'The response does not match the specification.',
    })
    this.name = 'ResponseValidationError'
    this.problems = problems
  }
}

/**
 * A malformed route module. Thrown at load time, never per request.
 */
export class RouteError extends Error {
  readonly file: string | undefined

  constructor(message: string, file?: string) {
    super(file ? `${message} (${file})` : message)
    this.name = 'RouteError'
    this.file = file
  }
}
