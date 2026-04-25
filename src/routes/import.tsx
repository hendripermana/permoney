import * as React from "react"
import { createFileRoute, useRouter } from "@tanstack/react-router"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import Papa from "papaparse"
import { toast } from "sonner"

import {
  IconUpload,
  IconPlus,
  IconTrash,
  IconFileSpreadsheet,
  IconArrowRight,
  IconCheck,
} from "@tabler/icons-react"

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

import {
  getSmartRulesFn,
  createSmartRuleFn,
  deleteSmartRuleFn,
} from "@/server/smart-rules"
import {
  getTransactionFormData,
  bulkCreateTransactionsFn,
} from "@/server/transactions"
import { formatCurrency } from "@/lib/currency"

export const Route = createFileRoute("/import")({
  component: ImportPage,
  staticData: {
    title: "Import & Rules Engine",
  },
})

// === INTERFACES ===
interface ParsedRow {
  id: string
  date: Date
  description: string
  amount: number
  type: "expense" | "income"
  accountId: string
  categoryId?: string
  merchantId?: string
  // For preview info
  assignedByRule?: boolean
}

function ImportPage() {
  const router = useRouter()
  const queryClient = useQueryClient()

  // === DATA FETCHING ===
  const { data: formData } = useQuery({
    queryKey: ["transactionFormData"],
    queryFn: () => getTransactionFormData(),
  })

  const { data: rules = [] } = useQuery({
    queryKey: ["smartRules"],
    queryFn: () => getSmartRulesFn(),
  })

  // === MUTATIONS ===
  const createRuleMutation = useMutation({
    mutationFn: (data: Parameters<typeof createSmartRuleFn>[0]["data"]) =>
      createSmartRuleFn({ data }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["smartRules"] })
      toast.success("Rule added successfully")
      setNewRuleKeyword("")
      setNewRuleCategory("")
      setNewRuleMerchant("")
    },
  })

  const deleteRuleMutation = useMutation({
    mutationFn: (id: string) => deleteSmartRuleFn({ data: { id } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["smartRules"] })
    },
  })

  const bulkCreateMutation = useMutation({
    mutationFn: (
      data: Parameters<typeof bulkCreateTransactionsFn>[0]["data"]
    ) => bulkCreateTransactionsFn({ data }),
    onSuccess: () => {
      toast.success("Transactions imported successfully!")
      void router.navigate({ to: "/transactions" })
    },
    onError: (err) => {
      toast.error("Failed to import transactions.")
      console.error(err)
    },
  })

  // === RULES ENGINE STATE ===
  const [newRuleKeyword, setNewRuleKeyword] = React.useState("")
  const [newRuleCategory, setNewRuleCategory] = React.useState("")
  const [newRuleMerchant, setNewRuleMerchant] = React.useState("")

  // === CSV ENGINE STATE ===
  const [parsedRows, setParsedRows] = React.useState<ParsedRow[]>([])
  const [targetAccountId, setTargetAccountId] = React.useState("")
  const [isParsing, setIsParsing] = React.useState(false)

  // Function to apply Rules Engine on strings
  const applyRules = (description: string, rulesList: typeof rules) => {
    const lowerDesc = description.toLowerCase()

    // Evaluate if any rule's keyword comma-split fragments match the description
    for (const rule of rulesList) {
      const keywords = rule.keyword
        .split(",")
        .map((k: string) => k.trim().toLowerCase())
      for (const kw of keywords) {
        if (kw && lowerDesc.includes(kw)) {
          return { categoryId: rule.categoryId, merchantId: rule.merchantId }
        }
      }
    }
    return { categoryId: null, merchantId: null }
  }

  // File Upload Handler
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!targetAccountId) {
      toast.error("Please select a Target Account first!")
      return
    }

    setIsParsing(true)

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows: ParsedRow[] = []

        results.data.forEach((row: any, index: number) => {
          // This relies on generic standard columns.
          // You may customize these mappings based on typical banking CSV exports.
          const rawDate = row["Date"] || row["Tanggal"] || row.date
          const rawDesc =
            row["Description"] || row["Keterangan"] || row.description
          const rawAmount = row["Amount"] || row["Nominal"] || row.amount
          // Optional columns for pure debit/credit bank statements:
          const rawCredit = row["Credit"] || row["Kredit"]
          const rawDebit = row["Debit"] || row["Debet"]

          if (!rawDate || !rawDesc) return

          let finalAmount =
            parseFloat(String(rawAmount).replace(/[^0-9.-]+/g, "")) || 0
          let type: "income" | "expense" =
            finalAmount < 0 ? "expense" : "income"

          if (rawCredit) {
            finalAmount =
              parseFloat(String(rawCredit).replace(/[^0-9.-]+/g, "")) || 0
            type = "income"
          } else if (rawDebit) {
            finalAmount =
              parseFloat(String(rawDebit).replace(/[^0-9.-]+/g, "")) || 0
            type = "expense"
          }

          if (finalAmount === 0) return

          // Execute Smart Rules Engine
          const matched = applyRules(rawDesc, rules)

          rows.push({
            id: `row-${index}-${Date.now()}`,
            date: new Date(rawDate),
            description: String(rawDesc),
            amount: Math.abs(finalAmount),
            type,
            accountId: targetAccountId,
            categoryId: matched.categoryId ?? undefined,
            merchantId: matched.merchantId ?? undefined,
            assignedByRule: !!(matched.categoryId || matched.merchantId),
          })
        })

        setParsedRows(rows)
        setIsParsing(false)
        e.target.value = "" // Reset
        toast.success(
          `Successfully parsed ${rows.length} transactions via Rules Engine.`
        )
      },
      error: (error) => {
        setIsParsing(false)
        console.error(error)
        toast.error("Failed to parse CSV file.")
      },
    })
  }

  const handleInjectToLedger = () => {
    if (parsedRows.length === 0) return
    bulkCreateMutation.mutate({ transactions: parsedRows })
  }

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col gap-6 p-4 md:p-6 lg:p-8">
            <div className="flex flex-col gap-2">
              <h1 className="text-3xl font-bold tracking-tight">
                Data Integration
              </h1>
              <p className="text-muted-foreground">
                Configure Machine-Readable IF-THEN Rules and process mass bank
                CSV extracts.
              </p>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              {/* === LEFT PANEL: RULES ENGINE === */}
              <Card className="flex flex-col">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <IconFileSpreadsheet className="text-blue-600 dark:text-blue-400" />
                    <div>
                      <CardTitle>The Smart Rules Engine</CardTitle>
                      <CardDescription>
                        Keyword matching rules applied automatically upon CSV
                        payload parsing.
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-6">
                  <div className="rounded-xl border bg-muted/20 p-4">
                    <h3 className="mb-4 text-sm font-semibold tracking-wider text-muted-foreground uppercase">
                      Create New Rule
                    </h3>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2 sm:col-span-2">
                        <Label>IF Description Contains (comma separated)</Label>
                        <Input
                          placeholder="e.g. Starbucks, Fore, Spotify, Steam"
                          value={newRuleKeyword}
                          onChange={(e) => setNewRuleKeyword(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>THEN Set Category</Label>
                        <select
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                          value={newRuleCategory}
                          onChange={(e) => setNewRuleCategory(e.target.value)}
                        >
                          <option value="">No Auto-Category</option>
                          {formData?.categories?.map((c: any) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label>THEN Set Merchant</Label>
                        <select
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                          value={newRuleMerchant}
                          onChange={(e) => setNewRuleMerchant(e.target.value)}
                        >
                          <option value="">No Auto-Merchant</option>
                          {formData?.merchants?.map((m: any) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <Button
                      onClick={() =>
                        createRuleMutation.mutate({
                          keyword: newRuleKeyword,
                          categoryId: newRuleCategory || undefined,
                          merchantId: newRuleMerchant || undefined,
                        })
                      }
                      disabled={!newRuleKeyword || createRuleMutation.isPending}
                      className="mt-4 w-full"
                    >
                      <IconPlus size={16} className="mr-2" />
                      Commit Rule to Engine
                    </Button>
                  </div>

                  <div className="flex-1 space-y-3 overflow-y-auto pr-2">
                    <h3 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
                      Active Directives ({rules.length})
                    </h3>
                    {rules.length === 0 && (
                      <p className="text-sm text-muted-foreground italic">
                        No rules configured yet.
                      </p>
                    )}
                    {rules.map((rule: any) => (
                      <div
                        key={rule.id}
                        className="group flex flex-col gap-2 rounded-lg border bg-card p-3 shadow-sm transition-colors hover:bg-muted/50"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-sm font-semibold text-amber-600 dark:text-amber-400">
                            IF "{rule.keyword}"
                          </span>
                          <button
                            onClick={() => deleteRuleMutation.mutate(rule.id)}
                            className="text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-red-600"
                          >
                            <IconTrash size={16} />
                          </button>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <IconArrowRight size={14} />
                          {rule.category ? (
                            <span className="rounded-sm bg-blue-100 px-1.5 py-0.5 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                              {rule.category.name}
                            </span>
                          ) : (
                            <span className="italic">N/A</span>
                          )}
                          <span>+</span>
                          {rule.merchant ? (
                            <span className="rounded-sm bg-purple-100 px-1.5 py-0.5 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
                              {rule.merchant.name}
                            </span>
                          ) : (
                            <span className="italic">N/A</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* === RIGHT PANEL: DROPZONE & REVIEW === */}
              <Card className="flex flex-col">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <IconUpload className="text-emerald-600 dark:text-emerald-400" />
                    <div>
                      <CardTitle>CSV Ingestion Chamber</CardTitle>
                      <CardDescription>
                        Upload bank statements to parse and map records against
                        active directives.
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-6">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>1. Select Target Account Ledger</Label>
                      <select
                        className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors"
                        value={targetAccountId}
                        onChange={(e) => setTargetAccountId(e.target.value)}
                      >
                        <option value="" disabled>
                          --- Select Account ---
                        </option>
                        {formData?.accounts?.map((acc: any) => (
                          <option key={acc.id} value={acc.id}>
                            {acc.name} ({acc.currency})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-2">
                      <Label>2. Upload Bank CSV</Label>
                      <Input
                        type="file"
                        accept=".csv"
                        onChange={handleFileUpload}
                        disabled={isParsing || !targetAccountId}
                        className="cursor-pointer"
                      />
                      <p className="text-xs text-muted-foreground">
                        Expected columns: Date, Description, Amount. (Format
                        flexibly auto-detected).
                      </p>
                    </div>
                  </div>

                  {parsedRows.length > 0 && (
                    <div className="flex flex-1 flex-col gap-4 overflow-hidden border-t pt-4">
                      <div className="flex items-center justify-between">
                        <h3 className="font-semibold text-emerald-600 dark:text-emerald-400">
                          {parsedRows.length} Entries Ready
                        </h3>
                        <Button
                          onClick={handleInjectToLedger}
                          disabled={bulkCreateMutation.isPending}
                          className="bg-emerald-600 text-white hover:bg-emerald-700"
                        >
                          {bulkCreateMutation.isPending
                            ? "Executing..."
                            : "Inject to Ledger"}
                        </Button>
                      </div>

                      <div className="flex-1 overflow-auto rounded-md border">
                        <Table>
                          <TableHeader>
                            <TableRow className="bg-muted/50">
                              <TableHead className="w-24">Date</TableHead>
                              <TableHead>Description</TableHead>
                              <TableHead>Amount</TableHead>
                              <TableHead>Category</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {parsedRows.slice(0, 50).map((row) => (
                              <TableRow key={row.id}>
                                <TableCell className="text-xs whitespace-nowrap">
                                  {isNaN(row.date.getTime())
                                    ? "Invalid"
                                    : row.date.toLocaleDateString()}
                                </TableCell>
                                <TableCell className="max-w-[150px] truncate">
                                  {row.description}
                                </TableCell>
                                <TableCell
                                  className={`text-right font-medium whitespace-nowrap ${row.type === "expense" ? "text-red-500" : "text-emerald-500"}`}
                                >
                                  {row.type === "expense" ? "-" : "+"}
                                  {formatCurrency(row.amount, "IDR")}
                                </TableCell>
                                <TableCell>
                                  {row.assignedByRule ? (
                                    <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-900 dark:text-amber-300">
                                      <IconCheck size={10} /> Auto-Mapped
                                    </span>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">
                                      -
                                    </span>
                                  )}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      {parsedRows.length > 50 && (
                        <p className="text-center text-xs text-muted-foreground italic">
                          Showing first 50 rows of {parsedRows.length} total
                          generated entries.
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
