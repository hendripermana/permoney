import * as React from "react"
import { IconCloudOff, IconRefresh, IconWifiOff } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { BootUnreachableError } from "@/lib/boot-guard"

/**
 * The state the user sees when the boot guard could not reach the server
 * (F1 audit B5). Replaces the blank loading screen the production incident
 * left behind.
 *
 * Two honest states, not one generic message:
 *   - offline  → the browser has no network. Reloading now would fail again,
 *                so the copy says what to do, and the panel reloads BY ITSELF
 *                when the connection comes back.
 *   - otherwise → the server did not answer (or refused). The copy says so and
 *                the Reload button is the action.
 *
 * `onReload` is injectable so the component test can assert the action without
 * navigating a jsdom document.
 */
export function BootUnreachablePanel({
  error,
  onReload,
}: {
  error: unknown
  onReload?: () => void
}) {
  const reason =
    error instanceof BootUnreachableError ? error.reason : "unreachable"
  const offline = reason === "offline"

  const reload = React.useCallback(() => {
    if (onReload) {
      onReload()
      return
    }
    window.location.reload()
  }, [onReload])

  // Subscribe to the browser's connectivity signal so the offline state
  // recovers by itself the moment the network returns — the user should not
  // have to notice that the Wi-Fi came back and then remember to reload. This
  // is the `useMountEffect` case the hook documents: one-time external
  // subscription with a cleanup, no changing dependencies.
  useMountEffect(() => {
    if (!offline) return undefined
    const handleOnline = () => reload()
    window.addEventListener("online", handleOnline)
    return () => window.removeEventListener("online", handleOnline)
  })

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {offline ? (
          <IconWifiOff className="size-6" aria-hidden="true" />
        ) : (
          <IconCloudOff className="size-6" aria-hidden="true" />
        )}
      </span>

      <div className="space-y-2">
        <h2 className="text-xl font-semibold">
          {offline ? "You're offline" : "Can't reach Permoney"}
        </h2>
        <p className="mx-auto max-w-prose text-sm text-muted-foreground">
          {offline
            ? "Your device has no network connection. Permoney will reload by itself as soon as you're back online."
            : "The server didn't answer. Your data is safe — nothing was changed. Reload to try again."}
        </p>
      </div>

      {/* No raw error text, no stack, no request URL: a first-run household
          should never be shown a transport error, and the underlying error
          can carry server internals. */}
      <Button type="button" onClick={reload}>
        <IconRefresh className="size-4" aria-hidden="true" />
        Reload
      </Button>

      {offline ? null : (
        <p className="text-xs text-muted-foreground">
          Still nothing? Check your connection, then reload.
        </p>
      )}
    </div>
  )
}
