import type { Handler } from '@plushveil/api/server'
import type { HealthStatus } from '../schemas.ts'

/**
 * Report service health.
 *
 * @operationId getHealth
 * @tags ops
 */
export interface Operation {
  query: {
    /**
     * Include the region in the response.
     */
    verbose?: boolean
  }
  responses: {
    200: HealthStatus
  }
}

const started = Date.now()

export const handler: Handler<Operation> = async (request) => ({
  status: 200,
  body: {
    dependenciesReady: true,
    status: 'ok',
    uptime: Math.floor((Date.now() - started) / 1000),
    ...(request.query.verbose ? { region: 'local' } : {}),
  },
})
