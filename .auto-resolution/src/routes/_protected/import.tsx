import * as React from "react"
import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  Upload,
  FileSpreadsheet,
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  CircleAlert,
  CopyCheck,
  Sparkles,
  Loader2,
  FileJson,
} from "lucide-react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

import {
  DATE_FORMATS,
  IMPORT_PRESETS,
  getPreset,
  mapCsvRows,
  parseCsv,
  parseQif,
  sha256Hex,
  toStagedRows,
  type AmountMapping,
  type ColumnMapping,
  type DateFormat,
  type ImportPreset,
  type ParsedImportRow,
} from "@/lib/csv-import"
import {
  createImportBatchFn,
  getImportBatchFn,
  promoteImportBatchFn,
  reviewImportRowsFn,
} from "@/server/imports"
import { getTransactionFormData } from "@/server/transactions"
import { formatMoney } from "@/lib/money"
import { type CurrencyCode } from "@/lib/data/currencies"
import { createUuidV7 } from "@/lib/uuid-v7"

export const Route = createFileRoute("/_protected/import")({
  ssr: false,
  staticData: { title: "Import Transactions" },
  component: ImportPage,
})

type WizardStep = "upload" | "map" | "preview"
type Verdict = "confirm" | "reject"
type BatchData = Awaited<ReturnType<typeof getImportBatchFn>>
type BatchRow = BatchData["rows"][number]

const UNSET = "__unset__"

function ImportPage() {
  const router = useRouter()
  const queryClient = useQueryClient()

  const { data: formData } = useQuery({
    queryKey: ["transactionFormData"],
    queryFn: () => getTransactionFormData(),
  })

  const importableAccounts = React.useMemo(
    () => (formData?.accounts ?? []).filter((account) => account.isImportable),
    [formData]
  )

  const [step, setStep] = React.useState<WizardStep>("upload")
  const [presetId, setPresetId] = React.useState<ImportPreset["id"]>("generic")
  const [fileName, setFileName] = React.useState("")
  const [fileText, setFileText] = React.useState("")
  const [fileKind, setFileKind] = React.useState<"csv" | "qif">("csv")
  const [headers, setHeaders] = React.useState<string[]>([])
  const [rawRows, setRawRows] = React.useState<Record<string, string>[]>([])
  const [mapping, setMapping] = React.useState<ColumnMapping | null>(null)
  const [qifDateFormat, setQifDateFormat] =
    React.useState<DateFormat>("MM/DD/YYYY")
  const [targetAccountId, setTargetAccountId] = React.useState("")
  const [batchId, setBatchId] = React.useState<string | null>(null)
  const [overrides, setOverrides] = React.useState<Record<string, Verdict>>({})

  const targetAccount = importableAccounts.find(
    (account) => account.id === targetAccountId
  )
  const currency = (targetAccount?.currency ?? "IDR") as CurrencyCode

  // ----- File upload (event handler — not an effect) ----------------------
  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    const text = await file.text()
    setFileName(file.name)
    setFileText(text)
    if (file.name.toLowerCase().endsWith(".qif")) {
      setFileKind("qif")
      setHeaders([])
      setRawRows([])
      setMapping(null)
    } else {
      const parsed = parseCsv(text)
      setFileKind("csv")
      setHeaders(parsed.headers)
      setRawRows(parsed.rows)
      setMapping(getPreset(presetId).suggestMapping(parsed.headers))
    }
    setStep("map")
  }

  const handlePreset = (id: ImportPreset["id"]) => {
    setPresetId(id)
    if (fileKind === "csv" && headers.length > 0) {
      setMapping(getPreset(id).suggestMapping(headers))
    }
  }

  const patchMapping = (patch: Partial<ColumnMapping>) =>
    setMapping((current) => (current ? { ...current, ...patch } : current))

  const changeAmountKind = (kind: AmountMapping["kind"]) => {
    if (kind === "signed") {
      patchMapping({
        amount: { kind: "signed", column: "", negativeMeans: "expense" },
      })
    } else if (kind === "split") {
      patchMapping({
        amount: { kind: "split", outflowColumn: "", inflowColumn: "" },
      })
    } else {
      patchMapping({
        amount: {
          kind: "typed",
          amountColumn: "",
          typeColumn: "",
          expenseValues: ["debit"],
          incomeValues: ["credit"],
        },
      })
    }
  }

  // ----- Client-side preview (pure, memoized) -----------------------------
  const parsedPreview = React.useMemo<ParsedImportRow[]>(() => {
    if (!targetAccount) return []
    if (fileKind === "qif") {
      return parseQif(fileText, { dateFormat: qifDateFormat, currency })
    }
    if (!mapping) return []
    return mapCsvRows(rawRows, mapping, currency)
  }, [
    targetAccount,
    fileKind,
    fileText,
    qifDateFormat,
    mapping,
    rawRows,
    currency,
  ])

  const readyCount = parsedPreview.filter((row) => row.error === null).length
  const skippedCount = parsedPreview.length - readyCount

  // ----- Staging ----------------------------------------------------------
  const stageMutation = useMutation({
    mutationFn: async () => {
      if (!targetAccount) throw new Error("Select a target account first.")
      const rows = toStagedRows(parsedPreview, targetAccount.id)
      if (rows.length === 0) {
        throw new Error("No importable rows — check the column mapping.")
      }
      const contentHash = await sha256Hex(fileText)
      return createImportBatchFn({
        data: {
          sourceKind: "csv_upload",
          accountId: targetAccount.id,
          contentHash,
          idempotencyKey: createUuidV7(),
          rows,
        },
      })
    },
    onSuccess: (summary) => {
      setBatchId(summary.id)
      setOverrides({})
      setStep("preview")
      if (summary.replayed) {
        toast.info("This exact file was already imported — showing that batch.")
      }
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Staging failed."),
  })

  // ----- Preview (server batch with dedup verdicts) -----------------------
  const batchQuery = useQuery({
    queryKey: ["importBatch", batchId],
    queryFn: () => getImportBatchFn({ data: { batchId: batchId as string } }),
    enabled: batchId !== null,
  })
  const batch = batchQuery.data

  const defaultVerdict = (row: BatchRow): Verdict =>
    row.rowStatus === "duplicate" ? "reject" : "confirm"
  const verdictOf = (row: BatchRow): Verdict =>
    overrides[row.id] ?? defaultVerdict(row)
  const toggleVerdict = (row: BatchRow) =>
    setOverrides((current) => ({
      ...current,
      [row.id]: verdictOf(row) === "confirm" ? "reject" : "confirm",
    }))

  const promoteMutation = useMutation({
    mutationFn: async () => {
      if (!batch) throw new Error("No batch loaded.")
      const reviewable = batch.rows.filter(
        (row) => row.rowStatus !== "promoted"
      )
      const decisions = reviewable.map((row) => ({
        rowId: row.id,
        verdict: verdictOf(row),
      }))
      if (decisions.length > 0) {
        await reviewImportRowsFn({
          data: {
            batchId: batch.batch.id,
            idempotencyKey: createUuidV7(),
            decisions,
          },
        })
      }
      return promoteImportBatchFn({
        data: { batchId: batch.batch.id, idempotencyKey: createUuidV7() },
      })
    },
    onSuccess: async (result) => {
      const [{ transactionCollection }] = await Promise.all([
        import("@/lib/collections"),
        queryClient.invalidateQueries({ queryKey: ["transactions_live"] }),
      ])
      await transactionCollection.utils.refetch()
      toast.success(
        `Promoted ${result.promotedCount} transaction(s) to the ledger.`
      )
      void router.navigate({ to: "/transactions" })
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Promotion failed."),
  })

  const confirmCount = batch
    ? batch.rows.filter(
        (row) => row.rowStatus !== "promoted" && verdictOf(row) === "confirm"
      ).length
    : 0

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar variant="inset" />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col gap-6 p-4 md:p-6 lg:p-8">
            <header className="flex flex-col gap-2">
              <h1 className="text-3xl font-bold tracking-tight">
                Import Transactions
              </h1>
              <p className="text-muted-foreground">
                Upload a CSV or QIF export, map the columns, review for
                duplicates, then promote confirmed rows into your ledger.
              </p>
              <WizardSteps step={step} />
            </header>

            {step === "upload" && (
              <Link
                to="/import/sure"
                className="group flex max-w-2xl items-center gap-4 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 transition-colors hover:border-emerald-400 hover:bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30 dark:hover:border-emerald-700"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  <FileJson size={20} />
                </span>
                <div className="flex-1">
                  <p className="font-semibold">Coming from Sure?</p>
                  <p className="text-sm text-muted-foreground">
                    Migrate your whole history — accounts, categories, merchants
                    and transactions — in one guided step.
                  </p>
                </div>
                <ArrowRight
                  size={18}
                  className="shrink-0 text-emerald-600 transition-transform group-hover:translate-x-0.5 dark:text-emerald-400"
                />
              </Link>
            )}

            {step === "upload" && (
              <UploadStep
                presetId={presetId}
                onPreset={handlePreset}
                onFile={handleFile}
                fileName={fileName}
              />
            )}

            {step === "map" && (
              <MapStep
                fileName={fileName}
                fileKind={fileKind}
                headers={headers}
                mapping={mapping}
                onPatchMapping={patchMapping}
                onChangeAmountKind={changeAmountKind}
                qifDateFormat={qifDateFormat}
                onQifDateFormat={setQifDateFormat}
                accounts={importableAccounts}
                targetAccountId={targetAccountId}
                onTargetAccount={setTargetAccountId}
                currency={currency}
                preview={parsedPreview}
                readyCount={readyCount}
                skippedCount={skippedCount}
                onBack={() => setStep("upload")}
                onStage={() => stageMutation.mutate()}
                staging={stageMutation.isPending}
                canStage={!!targetAccount && readyCount > 0}
              />
            )}

            {step === "preview" && (
              <PreviewStep
                loading={batchQuery.isLoading}
                batch={batch}
                currency={currency}
                verdictOf={verdictOf}
                onToggle={toggleVerdict}
                confirmCount={confirmCount}
                onBack={() => setStep("map")}
                onPromote={() => promoteMutation.mutate()}
                promoting={promoteMutation.isPending}
              />
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

// ===========================================================================
// Step indicator
// ===========================================================================

function WizardSteps({ step }: { step: WizardStep }) {
  const steps: { id: WizardStep; label: string }[] = [
    { id: "upload", label: "1 · Upload" },
    { id: "map", label: "2 · Map & account" },
    { id: "preview", label: "3 · Review & promote" },
  ]
  const activeIndex = steps.findIndex((s) => s.id === step)
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1 text-sm">
      {steps.map((s, index) => (
        <React.Fragment key={s.id}>
          <span
            className={
              index <= activeIndex
                ? "font-semibold text-foreground"
                : "text-muted-foreground"
            }
          >
            {s.label}
          </span>
          {index < steps.length - 1 && (
            <ArrowRight size={14} className="text-muted-foreground" />
          )}
        </React.Fragment>
      ))}
    </div>
  )
}

// ===========================================================================
// Step 1 — upload
// ===========================================================================

function UploadStep({
  presetId,
  onPreset,
  onFile,
  fileName,
}: {
  presetId: ImportPreset["id"]
  onPreset: (id: ImportPreset["id"]) => void
  onFile: (event: React.ChangeEvent<HTMLInputElement>) => void
  fileName: string
}) {
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="text-emerald-600 dark:text-emerald-400" />
          <div>
            <CardTitle>Choose a format and upload</CardTitle>
            <CardDescription>
              Presets pre-fill the column mapping. CSV files are mapped in the
              next step; QIF files are parsed automatically.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="space-y-2">
          <Label>Format preset</Label>
          <Select
            value={presetId}
            onValueChange={(value) => onPreset(value as ImportPreset["id"])}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {IMPORT_PRESETS.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            QIF files (.qif) skip column mapping regardless of the preset.
          </p>
        </div>
        <div className="space-y-2">
          <Label>Statement file (.csv or .qif)</Label>
          <div className="flex items-center gap-2">
            <Upload size={16} className="text-muted-foreground" />
            <Input
              type="file"
              accept=".csv,.qif"
              onChange={onFile}
              className="cursor-pointer"
            />
          </div>
          {fileName && (
            <p className="text-xs text-muted-foreground">
              Selected: {fileName}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ===========================================================================
// Step 2 — map columns + target account
// ===========================================================================

function HeaderSelect({
  value,
  onChange,
  headers,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  headers: string[]
  placeholder?: string
}) {
  return (
    <Select
      value={value || UNSET}
      onValueChange={(next) => onChange(next === UNSET ? "" : next)}
    >
      <SelectTrigger>
        <SelectValue placeholder={placeholder ?? "Select column"} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNSET}>— none —</SelectItem>
        {headers.map((header) => (
          <SelectItem key={header} value={header}>
            {header}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function MapStep({
  fileName,
  fileKind,
  headers,
  mapping,
  onPatchMapping,
  onChangeAmountKind,
  qifDateFormat,
  onQifDateFormat,
  accounts,
  targetAccountId,
  onTargetAccount,
  currency,
  preview,
  readyCount,
  skippedCount,
  onBack,
  onStage,
  staging,
  canStage,
}: {
  fileName: string
  fileKind: "csv" | "qif"
  headers: string[]
  mapping: ColumnMapping | null
  onPatchMapping: (patch: Partial<ColumnMapping>) => void
  onChangeAmountKind: (kind: AmountMapping["kind"]) => void
  qifDateFormat: DateFormat
  onQifDateFormat: (format: DateFormat) => void
  accounts: { id: string; name: string; currency: string }[]
  targetAccountId: string
  onTargetAccount: (id: string) => void
  currency: CurrencyCode
  preview: ParsedImportRow[]
  readyCount: number
  skippedCount: number
  onBack: () => void
  onStage: () => void
  staging: boolean
  canStage: boolean
}) {
  const dateFormat = fileKind === "qif" ? qifDateFormat : mapping?.dateFormat
  const setDateFormat = (format: DateFormat) =>
    fileKind === "qif"
      ? onQifDateFormat(format)
      : onPatchMapping({ dateFormat: format })

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Map columns</CardTitle>
          <CardDescription>{fileName}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="space-y-2">
            <Label>Target account</Label>
            {accounts.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                No importable accounts. Enable importing on an account first.
              </p>
            ) : (
              <Select value={targetAccountId} onValueChange={onTargetAccount}>
                <SelectTrigger>
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name} ({account.currency})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="text-xs text-muted-foreground">
              Every row in this file imports into this one account. Amounts are
              read in {currency}.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Date format</Label>
            <Select
              value={dateFormat}
              onValueChange={(value) => setDateFormat(value as DateFormat)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATE_FORMATS.map((format) => (
                  <SelectItem key={format} value={format}>
                    {format}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {fileKind === "csv" && mapping && (
            <>
              <Separator />
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Date column</Label>
                  <HeaderSelect
                    value={mapping.dateColumn}
                    onChange={(value) => onPatchMapping({ dateColumn: value })}
                    headers={headers}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Description column</Label>
                  <HeaderSelect
                    value={mapping.descriptionColumn}
                    onChange={(value) =>
                      onPatchMapping({ descriptionColumn: value })
                    }
                    headers={headers}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Amount mode</Label>
                <Select
                  value={mapping.amount.kind}
                  onValueChange={(value) =>
                    onChangeAmountKind(value as AmountMapping["kind"])
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="signed">
                      Single signed amount column
                    </SelectItem>
                    <SelectItem value="split">
                      Separate outflow / inflow columns
                    </SelectItem>
                    <SelectItem value="typed">Amount + type column</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <AmountModeEditor
                amount={mapping.amount}
                headers={headers}
                onChange={(amount) => onPatchMapping({ amount })}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card className="flex flex-col">
        <CardHeader>
          <CardTitle>Preview</CardTitle>
          <CardDescription>
            {readyCount} ready
            {skippedCount > 0 ? ` · ${skippedCount} skipped` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-4">
          <div className="flex-1 overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead className="w-24">Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.slice(0, 15).map((row, index) => (
                  <TableRow
                    key={index}
                    className={row.error ? "bg-destructive/5" : undefined}
                  >
                    <TableCell className="text-xs whitespace-nowrap">
                      {row.date ? row.date.toISOString().slice(0, 10) : "—"}
                    </TableCell>
                    <TableCell className="max-w-[180px] truncate">
                      {row.error ? (
                        <span className="text-xs text-destructive">
                          {row.error}
                        </span>
                      ) : (
                        row.description
                      )}
                    </TableCell>
                    <TableCell
                      className={`text-right text-xs whitespace-nowrap ${
                        row.type === "expense"
                          ? "text-red-500"
                          : "text-emerald-500"
                      }`}
                    >
                      {row.amountMinor === null
                        ? "—"
                        : formatMoney(
                            row.type === "expense"
                              ? -row.amountMinor
                              : row.amountMinor,
                            currency
                          )}
                    </TableCell>
                  </TableRow>
                ))}
                {preview.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      Select a target account to preview rows.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeft size={16} className="mr-2" />
              Back
            </Button>
            <Button onClick={onStage} disabled={!canStage || staging}>
              {staging ? (
                <Loader2 size={16} className="mr-2 animate-spin" />
              ) : (
                <ArrowRight size={16} className="mr-2" />
              )}
              Stage &amp; preview
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function AmountModeEditor({
  amount,
  headers,
  onChange,
}: {
  amount: AmountMapping
  headers: string[]
  onChange: (amount: AmountMapping) => void
}) {
  if (amount.kind === "signed") {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Amount column</Label>
          <HeaderSelect
            value={amount.column}
            onChange={(column) => onChange({ ...amount, column })}
            headers={headers}
          />
        </div>
        <div className="space-y-2">
          <Label>Negative means</Label>
          <Select
            value={amount.negativeMeans}
            onValueChange={(value) =>
              onChange({
                ...amount,
                negativeMeans: value as "expense" | "income",
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="expense">Expense (money out)</SelectItem>
              <SelectItem value="income">Income (money in)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    )
  }

  if (amount.kind === "split") {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Outflow column (expense)</Label>
          <HeaderSelect
            value={amount.outflowColumn}
            onChange={(outflowColumn) => onChange({ ...amount, outflowColumn })}
            headers={headers}
          />
        </div>
        <div className="space-y-2">
          <Label>Inflow column (income)</Label>
          <HeaderSelect
            value={amount.inflowColumn}
            onChange={(inflowColumn) => onChange({ ...amount, inflowColumn })}
            headers={headers}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label>Amount column</Label>
        <HeaderSelect
          value={amount.amountColumn}
          onChange={(amountColumn) => onChange({ ...amount, amountColumn })}
          headers={headers}
        />
      </div>
      <div className="space-y-2">
        <Label>Type column</Label>
        <HeaderSelect
          value={amount.typeColumn}
          onChange={(typeColumn) => onChange({ ...amount, typeColumn })}
          headers={headers}
        />
      </div>
      <div className="space-y-2">
        <Label>Expense values</Label>
        <Input
          value={amount.expenseValues.join(", ")}
          onChange={(event) =>
            onChange({
              ...amount,
              expenseValues: splitValues(event.target.value),
            })
          }
          placeholder="debit"
        />
      </div>
      <div className="space-y-2">
        <Label>Income values</Label>
        <Input
          value={amount.incomeValues.join(", ")}
          onChange={(event) =>
            onChange({
              ...amount,
              incomeValues: splitValues(event.target.value),
            })
          }
          placeholder="credit"
        />
      </div>
    </div>
  )
}

function splitValues(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

// ===========================================================================
// Step 3 — review & promote
// ===========================================================================

function PreviewStep({
  loading,
  batch,
  currency,
  verdictOf,
  onToggle,
  confirmCount,
  onBack,
  onPromote,
  promoting,
}: {
  loading: boolean
  batch: BatchData | undefined
  currency: CurrencyCode
  verdictOf: (row: BatchRow) => Verdict
  onToggle: (row: BatchRow) => void
  confirmCount: number
  onBack: () => void
  onPromote: () => void
  promoting: boolean
}) {
  if (loading || !batch) {
    return (
      <Card>
        <CardContent className="space-y-3 p-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Review &amp; promote</CardTitle>
            <CardDescription>
              Confirmed rows become ledger transactions. Duplicates are rejected
              by default.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary">{batch.batch.totalRows} rows</Badge>
            {batch.batch.duplicateRows > 0 && (
              <Badge variant="outline">
                {batch.batch.duplicateRows} duplicate
              </Badge>
            )}
            {batch.batch.promotedRows > 0 && (
              <Badge>{batch.batch.promotedRows} promoted</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="w-16">Import</TableHead>
                <TableHead className="w-24">Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batch.rows.map((row) => {
                const promoted = row.rowStatus === "promoted"
                const verdict = verdictOf(row)
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Checkbox
                        checked={promoted ? true : verdict === "confirm"}
                        disabled={promoted}
                        onCheckedChange={() => onToggle(row)}
                        aria-label="Import this row"
                      />
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {row.date
                        ? new Date(row.date).toISOString().slice(0, 10)
                        : "—"}
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate">
                      {row.description}
                    </TableCell>
                    <TableCell>
                      <RowStatusBadges row={row} />
                    </TableCell>
                    <TableCell
                      className={`text-right text-xs whitespace-nowrap ${
                        row.type === "expense"
                          ? "text-red-500"
                          : "text-emerald-500"
                      }`}
                    >
                      {row.amount === null
                        ? "—"
                        : formatMoney(
                            BigInt(row.amount),
                            (row.currency ?? currency) as CurrencyCode
                          )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={onBack} disabled={promoting}>
            <ArrowLeft size={16} className="mr-2" />
            Back
          </Button>
          <Button
            onClick={onPromote}
            disabled={promoting || confirmCount === 0}
          >
            {promoting ? (
              <Loader2 size={16} className="mr-2 animate-spin" />
            ) : (
              <CheckCheck size={16} className="mr-2" />
            )}
            Promote {confirmCount} confirmed
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function RowStatusBadges({ row }: { row: BatchRow }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {row.rowStatus === "promoted" && <Badge>Promoted</Badge>}
      {row.rowStatus === "duplicate" && (
        <Badge variant="destructive" className="gap-1">
          <CopyCheck size={11} /> Duplicate
        </Badge>
      )}
      {row.possibleDuplicate && row.rowStatus !== "duplicate" && (
        <Badge
          variant="outline"
          className="gap-1 border-amber-400 text-amber-600 dark:text-amber-400"
        >
          <CircleAlert size={11} /> Possible dup
        </Badge>
      )}
      {row.suggestedCategoryId && (
        <Badge variant="secondary" className="gap-1">
          <Sparkles size={11} /> Auto
        </Badge>
      )}
    </div>
  )
}
