import * as React from "react"
import {
  HeadContent,
  Scripts,
  createRootRoute,
  Outlet,
} from "@tanstack/react-router"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import { QueryClientProvider } from "@tanstack/react-query"
import { getQueryClient } from "@/lib/query-client"

import appCss from "../styles.css?url"

// 1. Inisialisasi Markas Besar Cache - Menggunakan Factory Singleton
const queryClient = getQueryClient()

// 1.5. Config Devtools Lazy Loading (Standard TanStack Best Practice)
// Memastikan DevTools hanya diload di mode development (tidak mengotori bundle production)
// DevTools untuk Router dilepas sementara untuk resolusi dependensi
// const TanStackRouterDevtools = ...

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
})

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
