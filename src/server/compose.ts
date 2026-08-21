import type { Context, Middleware } from './types.ts'

/**
 * Composes middleware into an onion: each layer may act before, after, or instead of the layers
 * within it. Not calling `next` short-circuits everything nested inside.
 *
 * Built with `reduceRight` so the first registered layer ends up outermost. The context is passed
 * in rather than held in module state, because two requests are routinely in flight at once and
 * shared state would let them read each other's.
 */
export function compose(middleware: readonly Middleware[], context: Context, core: () => Promise<void>): () => Promise<void> {
  return middleware.reduceRight<() => Promise<void>>(
    (next, layer) => async () => {
      let entered = false
      await layer(context, async () => {
        // Calling `next` twice would run the rest of the chain — and the handler — a second time.
        // On the client that is a legitimate retry; here it is always a bug.
        if (entered) throw new Error('A middleware layer called next() more than once')
        entered = true
        await next()
      })
    },
    core,
  )
}

/**
 * Runs a middleware chain for one context.
 */
export async function run(middleware: readonly Middleware[], context: Context, core: () => Promise<void>): Promise<void> {
  await compose(middleware, context, core)()
}
