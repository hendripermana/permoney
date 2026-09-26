import { createMiddleware } from "@tanstack/react-start"
import { logAndRethrow, withServerLogContext } from "../log.server"

/**
 * Error-capturing server-fn middleware (F1 audit S5.1).
 *
 * TanStack Start serializes a thrown error to the client through
 * `ShallowErrorPlugin`, which keeps **only `.message`** — everything else
 * (`.name`, Prisma's `.code`/`.meta`, our own error fields) is stripped before
 * the client ever sees it. So the server is the only place where the real error
 * still exists, and if nothing logs it here, a production failure leaves no
 * trace beyond a red toast.
 *
 * This middleware is composed as the OUTERMOST layer of the middleware chain
 * (`authMiddleware` starts with it), so one failing RPC produces exactly one
 * log line, carrying the fn name + source file from `serverFnMeta`, the
 * request-scoped correlation ids, and the scrubbed error name/message. The
 * error is then rethrown untouched: client-visible behaviour is unchanged.
 *
 * It logs failures only. A success line per call would be a firehose (114
 * server functions, most of them reads) for no diagnostic gain.
 */
export const errorLogMiddleware = createMiddleware().server(
  async ({ next, serverFnMeta }) => {
    return await withServerLogContext(async () => {
      const startedAt = Date.now()
      try {
        return await next()
      } catch (error) {
        logAndRethrow(error, {
          durationMs: Date.now() - startedAt,
          fn: serverFnMeta?.name,
          fnFile: serverFnMeta?.filename,
        })
      }
    })
  }
)
