import type { Content, Handler } from '@plushveil/api/server'

/**
 * Upload a file's bytes.
 *
 * @operationId uploadFile
 */
export interface Operation {
  body: Content<'application/octet-stream', ReadableStream<Uint8Array>>
  responses: {
    /**
     * Accepted
     */
    204: never
  }
}

export const handler: Handler<Operation> = async (request) => {
  const reader = request.body.getReader()
  for (;;) {
    const { done } = await reader.read()
    if (done) break
  }
  return { status: 204 }
}
