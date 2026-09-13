import * as React from "react"
import {
  HeadContent,
  Scripts,
  createRootRoute,
  Outlet,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "next-themes"
import { getQueryClient } from "@/lib/query-client"
import { Button } from "@/components/ui/button"
import { Toaster } from "@/components/ui/sonner"
import { useMountEffect } from "@/hooks/use-mount-effect"

import appCss from "../styles.css?url"

// 1. Initialize the shared query client cache - singleton factory
const queryClient = getQueryClient()

// 1.5. Config Devtools Lazy Loading (Standard TanStack Best Practice)
// Ensures DevTools is only loaded in development mode (doesn't pollute the production bundle)
// Router DevTools temporarily removed pending dependency resolution
// const TanStackRouterDevtools = ...
const ReactQueryDevtools = import.meta.env.PROD
  ? () => null
  : React.lazy(() =>
      import("@tanstack/react-query-devtools").then((res) => ({
        default: res.ReactQueryDevtools,
      }))
    )

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Permoney App" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  // 2. The key architectural decision is here: tell the router to use RootComponent
  component: RootComponent,
  // 🚀 BEST PRACTICE: our official 404 page
  notFoundComponent: () => (
    <div className="flex min-h-screen flex-col items-center justify-center p-4 text-center">
      <h1 className="text-4xl font-semibold text-red-500">404</h1>
      <p className="text-lg text-gray-600">This page doesn't exist.</p>
    </div>
  ),
  // 🛡️ Last-resort ErrorBoundary for the entire route tree.
  // Per-route `errorComponent` overrides this for finer-grained UX.
  errorComponent: RootErrorComponent,
})

function RootErrorComponent({ error, reset }: ErrorComponentProps) {
  // ─── Justified `useEffect` (no-use-effect skill exemption) ──────
  // Logs the error to the console (and, when wired, Sentry/PostHog)
  // each time the boundary catches a NEW error. The dep `[error]` is
  // load-bearing — we explicitly want the log to fire on identity
  // change, not just once on mount, so:
  //   - Rule 1 (derive) doesn't apply — logging is a side effect, not
  //     derived state.
  //   - Rule 3 (event handler) doesn't apply — error boundaries are
  //     not user events; there's no handler to put the log into.
  //   - Rule 4 (`useMountEffect`) doesn't apply — the dep changes;
  //     mount-only logging would miss subsequent errors after Reset.
  //   - Inline `console.error` during render would violate render
  //     purity AND double-log under StrictMode.
  // This is genuinely outside the skill's five rules. Keep as-is.
  // ────────────────────────────────────────────────────────────────
  React.useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[RootErrorBoundary]", error)
  }, [error])

  const message = error instanceof Error ? error.message : String(error)

  return (
    <RootDocument>
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-3xl font-semibold">Something went wrong 😵</h1>
        <p className="max-w-prose text-muted-foreground">
          The app ran into an unexpected error. Try resetting, or reload the
          page.
        </p>
        <pre className="max-w-prose rounded-md bg-muted p-3 text-left text-sm whitespace-pre-wrap">
          {message}
        </pre>
        <div className="flex gap-2">
          <Button onClick={reset}>Reset</Button>
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = "/"
            }}
          >
            Go home
          </Button>
        </div>
      </div>
    </RootDocument>
  )
}

function RootComponent() {
  useMountEffect(() => {
    document.documentElement.dataset.permoneyHydrated = "true"

    return () => {
      delete document.documentElement.dataset.permoneyHydrated
    }
  })

  return (
    <RootDocument>
      {/* 3. Wrap the app with providers */}
      <QueryClientProvider client={queryClient}>
        {/* next-themes drives the `.dark` class on <html>; the user's persisted
            choice (User.theme) is restored client-side via the profile pane.
            <html> already carries suppressHydrationWarning for this. */}
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <Outlet />
          {/* Single global toast outlet. Without this mounted, every
              toast.success/error across the app (import, smart rules, settings)
              is a silent no-op. */}
          <Toaster richColors closeButton />
          {/* Render lazy devtools only in the dev environment */}
          <React.Suspense fallback={null}>
            {/* <TanStackRouterDevtools position="bottom-right" /> */}
            <ReactQueryDevtools />
          </React.Suspense>
        </ThemeProvider>
      </QueryClientProvider>
    </RootDocument>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head suppressHydrationWarning>
        <HeadContent />
      </head>
      <body suppressHydrationWarning>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
