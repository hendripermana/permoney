import * as React from "react"
import {
  HeadContent,
  Scripts,
  createRootRoute,
  Outlet,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { QueryClientProvider } from "@tanstack/react-query"
import { getQueryClient } from "@/lib/query-client"
import { Button } from "@/components/ui/button"

import appCss from "../styles.css?url"

// 1. Inisialisasi Markas Besar Cache - Menggunakan Factory Singleton
const queryClient = getQueryClient()

// 1.5. Config Devtools Lazy Loading (Standard TanStack Best Practice)
// Memastikan DevTools hanya diload di mode development (tidak mengotori bundle production)
// DevTools untuk Router dilepas sementara untuk resolusi dependensi
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
  // 2. KUNCI ARSITEKTURNYA DI SINI: Kita kasih tahu router untuk pakai RootComponent
  component: RootComponent,
  // 🚀 BEST PRACTICE: Halaman 404 resmi kita
  notFoundComponent: () => (
    <div className="flex min-h-screen flex-col items-center justify-center p-4 text-center">
      <h1 className="text-4xl font-bold text-red-500">404</h1>
      <p className="text-lg text-gray-600">
        Bro, halamannya nggak ada (Not Found)!
      </p>
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
        <h1 className="text-3xl font-bold">Ada yang salah 😵</h1>
        <p className="max-w-prose text-muted-foreground">
          Aplikasi mengalami error tak terduga. Tim sudah otomatis dapat
          notifikasi. Coba reset, atau refresh halaman.
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
            Ke beranda
          </Button>
        </div>
      </div>
    </RootDocument>
  )
}

function RootComponent() {
  return (
    <RootDocument>
      {/* 3. BUNGKUS APLIKASIMU DENGAN PROVIDER */}
      <QueryClientProvider client={queryClient}>
        <Outlet />
        {/* Render lazy devtools hanya di dev environment */}
        <React.Suspense fallback={null}>
          {/* <TanStackRouterDevtools position="bottom-right" /> */}
          <ReactQueryDevtools />
        </React.Suspense>
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
