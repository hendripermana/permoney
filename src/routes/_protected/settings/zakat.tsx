import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Plus, Trash2, HandCoins, Pencil, Check, X } from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ConfirmDeleteDialog } from "@/components/blocks/confirm-delete-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { createUuidV7 } from "@/lib/uuid-v7"
import { getMembersFn } from "@/server/family-members"
import {
  createZakatPayerFn,
  deleteZakatPayerFn,
  getZakatSettingsFn,
  listZakatPayersFn,
  renameZakatPayerFn,
  suggestHawlStartDateFn,
  upsertZakatSettingsFn,
} from "@/server/zakat"

export const Route = createFileRoute("/_protected/settings/zakat")({
  ssr: false,
  staticData: { title: "Zakat" },
  component: ZakatSettingsPage,
})

const SETTINGS_KEY = ["zakat-settings"] as const
const PAYERS_KEY = ["zakat-payers"] as const
const MEMBERS_KEY = ["family-members"] as const

type NisabBasis = "gold" | "silver"
type HaulRule = "jumhur_continuous" | "hanafi_start_end"

/** Local calendar-day formatting for `<input type="date">` — mirrors
 * `toLocalDateInputValue` (dialog-date-time-field.tsx); Hawl start is a
 * calendar-day concept, no time-of-day precision needed. */
function toDateInputValue(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function ToggleOption<T extends string>({
  value,
  current,
  onSelect,
  title,
  description,
}: {
  value: T
  current: T
  onSelect: (value: T) => void
  title: string
  description: string
}) {
  const selected = value === current
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      aria-pressed={selected}
      className={cn(
        "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "border-border hover:bg-muted/50"
      )}
    >
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </button>
  )
}

function ZakatSettingsPage() {
  const queryClient = useQueryClient()

  const { data: settings } = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => getZakatSettingsFn(),
  })
  const { data: payers = [] } = useQuery({
    queryKey: PAYERS_KEY,
    queryFn: () => listZakatPayersFn(),
  })
  const { data: members = [] } = useQuery({
    queryKey: MEMBERS_KEY,
    queryFn: () => getMembersFn(),
  })

  const [enabled, setEnabled] = React.useState(false)
  const [nisabBasis, setNisabBasis] = React.useState<NisabBasis>("gold")
  const [haulRule, setHaulRule] = React.useState<HaulRule>("jumhur_continuous")
  const [hawlStartDate, setHawlStartDate] = React.useState("")
  // Whether the current `hawlStartDate` value came from "Auto-detect from my
  // transaction history" — drives the inline note below the date input.
  // Cleared the moment the user edits the date any other way, so it never
  // describes a value it didn't actually produce.
  const [autoDetectNote, setAutoDetectNote] = React.useState<{
    approximate: boolean
  } | null>(null)
  // Track whether the user has touched the form locally, so a background
  // refetch of `settings` never clobbers an in-progress edit — a plain
  // declarative sync from props on every query update, no useEffect.
  const [dirty, setDirty] = React.useState(false)

  if (settings && !dirty) {
    if (
      settings.enabled !== enabled ||
      settings.nisabBasis !== nisabBasis ||
      settings.haulRule !== haulRule ||
      toDateInputValue(settings.hawlStartDate) !== hawlStartDate
    ) {
      setEnabled(settings.enabled)
      setNisabBasis(settings.nisabBasis)
      setHaulRule(settings.haulRule)
      setHawlStartDate(toDateInputValue(settings.hawlStartDate))
    }
  }

  const saveSettings = useMutation({
    mutationFn: () =>
      upsertZakatSettingsFn({
        data: {
          enabled,
          nisabBasis,
          haulRule,
          hawlStartDate: hawlStartDate ? new Date(hawlStartDate) : null,
          idempotencyKey: createUuidV7(),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY })
      setDirty(false)
      toast.success("Zakat settings saved.")
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Could not save settings."
      ),
  })

  const autoDetectHawl = useMutation({
    mutationFn: () => suggestHawlStartDateFn(),
    onSuccess: (result) => {
      if (result.status === "price_unavailable") {
        toast.error(result.reason)
        return
      }
      if (!result.suggestion) {
        toast.error(
          "Your current wealth hasn't reached nisab yet — Zakat isn't due, so there's nothing to detect."
        )
        return
      }
      setHawlStartDate(toDateInputValue(result.suggestion.hawlStartDate))
      setAutoDetectNote({ approximate: result.suggestion.approximate })
      setDirty(true)
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not auto-detect a Hawl start date."
      ),
  })

  const [newPayerName, setNewPayerName] = React.useState("")
  const createPayer = useMutation({
    mutationFn: (input: { displayName: string; linkedUserId?: string }) =>
      createZakatPayerFn({
        data: { ...input, idempotencyKey: createUuidV7() },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PAYERS_KEY })
      setNewPayerName("")
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Could not add payer."
      ),
  })

  // Family members not yet linked to any existing ZakatPayer — one-click
  // "add as a payer" chips, so tagging a real household member never
  // requires typing their name manually (PER — Gap 2 fast-follow). Only
  // "active" members are offered — an "invited" member has no accepted
  // membership yet, and the server only allows linking an active one.
  const unlinkedMembers = members.filter(
    (m) =>
      m.status === "active" && !payers.some((p) => p.linkedUserId === m.userId)
  )

  const renamePayer = useMutation({
    mutationFn: (input: { id: string; displayName: string }) =>
      renameZakatPayerFn({
        data: { ...input, idempotencyKey: createUuidV7() },
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: PAYERS_KEY }),
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Could not rename payer."
      ),
  })

  const [pendingDelete, setPendingDelete] = React.useState<{
    id: string
    displayName: string
  } | null>(null)

  const deletePayer = useMutation({
    mutationFn: (id: string) =>
      deleteZakatPayerFn({ data: { id, idempotencyKey: createUuidV7() } }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: PAYERS_KEY }),
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Could not remove payer."
      ),
  })

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar variant="inset" />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col gap-6 p-4 md:p-6 lg:p-8">
            <header className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <HandCoins className="text-yellow-500" aria-hidden />
                <h1 className="text-3xl font-bold tracking-tight">
                  Zakat Maal
                </h1>
              </div>
              <p className="text-muted-foreground">
                Methodology settings for the Zakat calculator. Every result
                shows which of these choices it used — there is real,
                longstanding scholarly disagreement here, so Permoney never
                picks one silently.
              </p>
            </header>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Methodology</CardTitle>
                  <CardDescription>
                    Confirm these against your own madhab or your national Zakat
                    authority (e.g. BAZNAS) if unsure.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-5">
                  <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
                    <div className="space-y-0.5">
                      <Label htmlFor="zakat-enabled">
                        Enable Zakat calculator
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Opt-in and off by default — not every Permoney user
                        needs this. Turning it off hides Zakat everywhere,
                        including the sidebar.
                      </p>
                    </div>
                    <Switch
                      id="zakat-enabled"
                      checked={enabled}
                      onCheckedChange={(checked) => {
                        setEnabled(checked)
                        setDirty(true)
                      }}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Nisab basis</Label>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <ToggleOption
                        value="gold"
                        current={nisabBasis}
                        onSelect={(v) => {
                          setNisabBasis(v)
                          setDirty(true)
                        }}
                        title="Gold (default)"
                        description="87.48g — Maliki, Shafi'i, Hanbali."
                      />
                      <ToggleOption
                        value="silver"
                        current={nisabBasis}
                        onSelect={(v) => {
                          setNisabBasis(v)
                          setDirty(true)
                        }}
                        title="Silver — more precautionary"
                        description="612.36g — Hanafi; recommended by Qaradawi's Fiqh az-Zakat. Includes more people."
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Hawl (holding period) rule</Label>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <ToggleOption
                        value="jumhur_continuous"
                        current={haulRule}
                        onSelect={(v) => {
                          setHaulRule(v)
                          setDirty(true)
                        }}
                        title="Continuous (default)"
                        description="Majority view — wealth must stay at/above nisab every day of the year."
                      />
                      <ToggleOption
                        value="hanafi_start_end"
                        current={haulRule}
                        onSelect={(v) => {
                          setHaulRule(v)
                          setDirty(true)
                        }}
                        title="Start & end only"
                        description="Hanafi — only the first and last day matter; dips in between don't reset it."
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="hawl-start-date">Hawl start date</Label>
                    <p className="text-xs text-muted-foreground">
                      Zakat is only due once your wealth has stayed at or above
                      the nisab threshold continuously for one full Hijri year
                      (~354 days). This date is the anchor your one-year clock
                      counts from.
                    </p>
                    <Input
                      id="hawl-start-date"
                      type="date"
                      value={hawlStartDate}
                      onChange={(event) => {
                        setHawlStartDate(event.target.value)
                        setAutoDetectNote(null)
                        setDirty(true)
                      }}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setHawlStartDate(
                            toDateInputValue(new Date().toISOString())
                          )
                          setAutoDetectNote(null)
                          setDirty(true)
                        }}
                      >
                        Not sure? Start counting from today
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={autoDetectHawl.isPending}
                        onClick={() => autoDetectHawl.mutate()}
                      >
                        Auto-detect from my transaction history
                      </Button>
                    </div>
                    {autoDetectNote && (
                      <p className="text-xs text-muted-foreground">
                        Detected from your transaction history — your wealth
                        appears to have first reached nisab around this date.
                        {autoDetectNote.approximate &&
                          " (approximate — based on your earliest recorded transaction; your real wealth may go back further)"}
                      </p>
                    )}
                  </div>

                  <Button
                    onClick={() => saveSettings.mutate()}
                    disabled={saveSettings.isPending || !dirty}
                  >
                    Save settings
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Payers ({payers.length || 1})</CardTitle>
                  <CardDescription>
                    Zero or one payer needs no account tagging at all — every
                    account counts 100% toward that one payer, exactly like
                    before. Add a SECOND payer once the household has more than
                    one person's wealth to track independently (Zakat is never
                    pooled between them).
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {payers.length === 0 && (
                    <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                      No payers created yet — everything counts as{" "}
                      <span className="font-medium text-foreground">"Me"</span>.
                    </div>
                  )}
                  {payers.map((payer) => (
                    <PayerRow
                      key={payer.id}
                      id={payer.id}
                      displayName={payer.displayName}
                      onRename={(displayName) =>
                        renamePayer.mutate({ id: payer.id, displayName })
                      }
                      onDelete={() =>
                        setPendingDelete({
                          id: payer.id,
                          displayName: payer.displayName,
                        })
                      }
                    />
                  ))}

                  {unlinkedMembers.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {unlinkedMembers.map((member) => (
                        <Button
                          key={member.userId}
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={createPayer.isPending}
                          onClick={() =>
                            createPayer.mutate({
                              displayName: member.name,
                              linkedUserId: member.userId,
                            })
                          }
                        >
                          <Plus size={14} className="mr-1" />
                          Add {member.name} as a payer
                        </Button>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-col gap-1.5 pt-2">
                    <Label htmlFor="new-payer-name" className="text-xs">
                      Or add someone who isn't on Permoney yet (e.g. a spouse
                      who hasn't signed up)
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id="new-payer-name"
                        placeholder="e.g. Istri, Suami"
                        value={newPayerName}
                        onChange={(event) =>
                          setNewPayerName(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && newPayerName.trim()) {
                            createPayer.mutate({
                              displayName: newPayerName.trim(),
                            })
                          }
                        }}
                      />
                      <Button
                        variant="secondary"
                        disabled={!newPayerName.trim() || createPayer.isPending}
                        onClick={() =>
                          createPayer.mutate({
                            displayName: newPayerName.trim(),
                          })
                        }
                      >
                        <Plus size={16} className="mr-1" />
                        Add
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title={`Remove ${pendingDelete?.displayName ?? "this payer"}?`}
        description="Their Zakat history stays in your records, but they will no longer be counted as a payer on any account."
        confirmLabel="Remove"
        pendingLabel="Removing…"
        isPending={deletePayer.isPending}
        onConfirm={() => {
          if (!pendingDelete) return
          deletePayer.mutate(pendingDelete.id, {
            onSuccess: () => setPendingDelete(null),
          })
        }}
      />
    </TooltipProvider>
  )
}

function PayerRow({
  displayName,
  onRename,
  onDelete,
}: {
  id: string
  displayName: string
  onRename: (displayName: string) => void
  onDelete: () => void
}) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(displayName)

  return (
    <div className="flex items-center gap-2 rounded-lg border p-2">
      {editing ? (
        <>
          <Input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && draft.trim()) {
                onRename(draft.trim())
                setEditing(false)
              }
              if (event.key === "Escape") {
                setDraft(displayName)
                setEditing(false)
              }
            }}
            className="h-8"
          />
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={() => {
              if (draft.trim()) onRename(draft.trim())
              setEditing(false)
            }}
            aria-label="Save name"
          >
            <Check size={14} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={() => {
              setDraft(displayName)
              setEditing(false)
            }}
            aria-label="Cancel"
          >
            <X size={14} />
          </Button>
        </>
      ) : (
        <>
          <span className="flex-1 text-sm font-medium">{displayName}</span>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={() => setEditing(true)}
            aria-label={`Rename ${displayName}`}
          >
            <Pencil size={14} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-destructive hover:text-destructive"
            onClick={onDelete}
            aria-label={`Remove ${displayName}`}
          >
            <Trash2 size={14} />
          </Button>
        </>
      )}
    </div>
  )
}
