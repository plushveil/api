/**
 * Thrown for a non-2xx response when the client was created with `throwOnError`.
 */
export class ApiResponseError extends Error {
  readonly status: number
  readonly body: unknown
  readonly headers: Headers
  readonly response: Response

  constructor(status: number, body: unknown, response: Response) {
    super(`The request failed with status ${status}`)
    this.name = 'ApiResponseError'
    this.status = status
    this.body = body
    this.headers = response.headers
    this.response = response
  }
}

/**
 * Thrown when the request never completed: a network failure, an abort, or a timeout.
 */
export class ApiRequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ApiRequestError'
  }
}
