import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

// The "load one entity by id via useQuery, then show a spinner / a load
// failure / the real form" shell shared by every correction dialog
// (trade-correction-dialog.tsx, holding-event-correction-dialog.tsx) — the
// entity differs, the three states around it don't.
export function DialogLoadingOrError({
  isLoading,
  error,
  hasData,
  loadingLabel,
  notFoundTitle,
  notFoundMessage,
  onClose,
  children,
}: {
  isLoading: boolean
  error: unknown
  hasData: boolean
  loadingLabel: string
  notFoundTitle: string
  notFoundMessage: string
  onClose: () => void
  children: React.ReactNode
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {loadingLabel}
      </div>
    )
  }
  if (error || !hasData) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{notFoundTitle}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-destructive" role="alert">
          {error instanceof Error ? error.message : notFoundMessage}
        </p>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    )
  }
  return <>{children}</>
}
