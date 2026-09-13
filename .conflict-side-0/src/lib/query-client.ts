// File: src/lib/query-client.ts
import { QueryCache, QueryClient } from "@tanstack/react-query"
import { isAuthError, isSessionLossError } from "./auth-errors"

const LOGIN_PATH = "/login"

// PER-187: every collection in src/lib/*-collections.ts shares this one
// QueryClient singleton, so a single global handler here covers all of them
// (transactions, accounts, balance-drift, and any future live collection) —
// no per-collection auth handling needed.
//
// UNAUTHENTICATED/NOT_A_MEMBER mean the session itself is gone: no amount of
// retrying fixes that, and the live query would otherwise retry forever
// (TanStack Query's default backoff) while the app sits in a broken
// half-authenticated state. A hard redirect (not router.navigate) is
// deliberate: it guarantees this poisoned QueryClient singleton and every
// collection's in-memory cache are torn down by the reload, rather than
// risking one collection's cache surviving into the next session.
//
// FORBIDDEN is intentionally excluded from the redirect: that error means
// the session is valid but the capability is missing, so sending the user to
// /login would just bounce them straight back via _protected's guard. It
// still skips retries below, since it is never transient either.
function redirectToLoginOnSessionLoss(error: unknown): void {
  if (typeof window === "undefined") return
  if (!isSessionLossError(error)) return
  if (window.location.pathname.startsWith(LOGIN_PATH)) return
  window.location.assign(LOGIN_PATH)
}

// 1. ENTERPRISE SSR PATTERN: Factory pattern untuk keamanan SSR
function makeQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: redirectToLoginOnSessionLoss,
    }),
    defaultOptions: {
      queries: {
        // Data tidak akan fetch ulang otomatis dalam 1 menit
        // untuk mencegah spam request ke backend
        staleTime: 60 * 1000,
        // Auth-class errors are never transient — retrying UNAUTHENTICATED/
        // NOT_A_MEMBER/FORBIDDEN can't succeed, it just spams the server
        // until redirectToLoginOnSessionLoss above fires. Everything else
        // keeps TanStack Query's default retry behavior (3 attempts).
        retry: (failureCount, error) => !isAuthError(error) && failureCount < 3,
      },
    },
  })
}

// 2. Variabel penampung untuk Singleton di Browser
let browserQueryClient: QueryClient | undefined = undefined

export function getQueryClient() {
  // Aturan SSR: Jika di server, selalu buat instance baru per-request!
  if (typeof window === "undefined") {
    return makeQueryClient()
  }

  // Aturan Client: Jika di browser, selalu gunakan instance yang sama (Singleton)
  if (!browserQueryClient) browserQueryClient = makeQueryClient()
  return browserQueryClient
}
