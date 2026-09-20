import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

/**
 * A real confirmation for destructive actions (F1 audit B2).
 *
 * Smart-Rule and Zakat-payer deletes fired on a single click of a trash icon
 * with no confirmation at all, and the transaction deletes used the browser's
 * `confirm()` — which is unstyled, untranslatable, blocked in some embedded
 * browsers, and gives the household no context about what is about to go.
 * This matches the account-delete pattern the app already had.
 *
 * The dialog stays CONTROLLED by the caller and only closes when the caller
 * closes it, so a failed delete leaves the dialog (and its `error`) on screen
 * instead of silently vanishing — the same shape as the member-removal and
 * ownership-transfer confirmations.
 */
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  pendingLabel = "Deleting…",
  isPending = false,
  error = null,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  pendingLabel?: string
  isPending?: boolean
  error?: string | null
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {error ? (
          <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              // Keep the dialog controlled: the caller closes it on success, so
              // a rejection stays visible instead of flashing past.
              event.preventDefault()
              onConfirm()
            }}
            disabled={isPending}
          >
            {isPending ? pendingLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
