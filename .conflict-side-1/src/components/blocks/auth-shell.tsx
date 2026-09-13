import type * as React from "react"

// PER-166 — single shell for the public auth routes (login + signup) so the two
// pages share one structure and one canvas instead of duplicating the wrapper
// inline (which silently drifts). Uses the Wise warm off-white canvas token
// (DESIGN.md §1) so landing ↔ login ↔ signup read as one surface.
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-wise-canvas p-6 md:p-10">
      <div className="w-full max-w-sm md:max-w-4xl">{children}</div>
    </div>
  )
}
