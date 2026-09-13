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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { createUuidV7 } from "@/lib/uuid-v7"
import {
  createZakatPayerFn,
  deleteZakatPayerFn,
  getZakatSettingsFn,
  listZakatPayersFn,
  renameZakatPayerFn,
  upsertZakatSettingsFn,
} from "@/server/zakat"

export const Route = createFileRoute("/_protected/settings/zakat")({
  ssr: false,
  staticData: { title: "Zakat" },
  component: ZakatSettingsPage,
})

const SETTINGS_KEY = ["zakat-settings"] as const
const PAYERS_KEY = ["zakat-payers"] as const

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

  const [nisabBasis, setNisabBasis] = React.useState<NisabBasis>("gold")
  const [haulRule, setHaulRule] = React.useState<HaulRule>("jumhur_continuous")
  const [hawlStartDate, setHawlStartDate] = React.useState("")
  // Track whether the user has touched the form locally, so a background
  // refetch of `settings` never clobbers an in-progress edit — a plain
  // declarative sync from props on every query update, no useEffect.
  const [dirty, setDirty] = React.useState(false)

  if (settings && !dirty) {
    if (
      settings.nisabBasis !== nisabBasis ||
      settings.haulRule !== haulRule ||
      toDateInputValue(settings.hawlStartDate) !== hawlStartDate
    ) {
      setNisabBasis(settings.nisabBasis)
      setHaulRule(settings.haulRule)
      setHawlStartDate(toDateInputValue(settings.hawlStartDate))
    }
  }

  const saveSettings = useMutation({
    mutationFn: () =>
      upsertZakatSettingsFn({
        data: {
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

  const [newPayerName, setNewPayerName] = React.useState("")
  const createPayer = useMutation({
    mutationFn: (displayName: string) =>
      createZakatPayerFn({
        data: { displayName, idempotencyKey: createUuidV7() },
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
                    <Input
                      id="hawl-start-date"
                      type="date"
                      value={hawlStartDate}
                      onChange={(event) => {
                        setHawlStartDate(event.target.value)
                        setDirty(true)
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      When your household's wealth first reached nisab. Left
                      unset, Zakat cannot be calculated yet.
                    </p>
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
                      <span className="font-medium text-foreground">
                        "Saya"
                      </span>
                      .
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
                      onDelete={() => deletePayer.mutate(payer.id)}
                    />
                  ))}
                  <div className="flex gap-2 pt-2">
                    <Input
                      placeholder="e.g. Istri, Suami"
                      value={newPayerName}
                      onChange={(event) => setNewPayerName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && newPayerName.trim()) {
                          createPayer.mutate(newPayerName.trim())
                        }
                      }}
                    />
                    <Button
                      variant="secondary"
                      disabled={!newPayerName.trim() || createPayer.isPending}
                      onClick={() => createPayer.mutate(newPayerName.trim())}
                    >
                      <Plus size={16} className="mr-1" />
                      Add
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
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
