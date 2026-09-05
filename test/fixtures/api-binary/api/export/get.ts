import type { Content, Handler } from '@plushveil/api/server'

/**
 * Export a report, as a PDF or a CSV depending on `format`.
 *
 * @operationId exportReport
 */
export interface Operation {
  query: {
    format: 'csv' | 'pdf'
  }
  responses: {
    /**
     * Report
     */
    200: Content<'application/pdf', Uint8Array> | Content<'text/csv', string>
    404: never
  }
}

export const handler: Handler<Operation> = async (request) => {
  if (request.query.format === 'csv') return { status: 200, headers: { 'content-type': 'text/csv' }, body: 'a,b\n1,2\n' }
  return { status: 200, headers: { 'content-type': 'application/pdf' }, body: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }
}
