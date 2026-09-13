import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Plus, Trash2, ArrowRight, Wand2 } from "lucide-react"

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
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import {
  getSmartRulesFn,
  createSmartRuleFn,
  deleteSmartRuleFn,
} from "@/server/smart-rules"
import { getTransactionFormData } from "@/server/transactions"

const RULES_KEY = ["smartRules"] as const
const NONE = "__none__"

type SmartRule = Awaited<ReturnType<typeof getSmartRulesFn>>[number]

export const Route = createFileRoute("/_protected/settings/rules")({
  ssr: false,
  staticData: { title: "Import rules" },
  component: RulesPage,
})

function RulesPage() {
  const queryClient = useQueryClient()

  const { data: rules = [] } = useQuery({
    queryKey: RULES_KEY,
    queryFn: () => getSmartRulesFn(),
  })
  const { data: formData } = useQuery({
    queryKey: ["transactionFormData"],
    queryFn: () => getTransactionFormData(),
  })

  const [keyword, setKeyword] = React.useState("")
  const [categoryId, setCategoryId] = React.useState(NONE)
  const [merchantId, setMerchantId] = React.useState(NONE)

  const createMutation = useMutation({
    mutationFn: (data: Parameters<typeof createSmartRuleFn>[0]["data"]) =>
      createSmartRuleFn({ data }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RULES_KEY })
      toast.success("Rule added.")
      setKeyword("")
      setCategoryId(NONE)
      setMerchantId(NONE)
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Could not add rule."
      ),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSmartRuleFn({ data: { id } }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: RULES_KEY }),
  })

  const submit = () =>
    createMutation.mutate({
      keyword,
      categoryId: categoryId === NONE ? undefined : categoryId,
      merchantId: merchantId === NONE ? undefined : merchantId,
    })

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar variant="inset" />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col gap-6 p-4 md:p-6 lg:p-8">
            <header className="flex flex-col gap-2">
              <h1 className="text-3xl font-bold tracking-tight">
                Import rules
              </h1>
              <p className="text-muted-foreground">
                Keyword rules auto-suggest a category and merchant for imported
                transactions during review. They never promote a transaction on
                their own.
              </p>
            </header>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Wand2 className="text-blue-600 dark:text-blue-400" />
                    <div>
                      <CardTitle>Create rule</CardTitle>
                      <CardDescription>
                        If a description contains a keyword, suggest the chosen
                        category and merchant.
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="space-y-2">
                    <Label>
                      If description contains (comma separated keywords)
                    </Label>
                    <Input
                      placeholder="e.g. Starbucks, Fore, Spotify"
                      value={keyword}
                      onChange={(event) => setKeyword(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Then set category</Label>
                      <Select value={categoryId} onValueChange={setCategoryId}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>No category</SelectItem>
                          {formData?.categories?.map((category) => (
                            <SelectItem key={category.id} value={category.id}>
                              {category.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Then set merchant</Label>
                      <Select value={merchantId} onValueChange={setMerchantId}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>No merchant</SelectItem>
                          {formData?.merchants?.map((merchant) => (
                            <SelectItem key={merchant.id} value={merchant.id}>
                              {merchant.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <Button
                    onClick={submit}
                    disabled={!keyword || createMutation.isPending}
                  >
                    <Plus size={16} className="mr-2" />
                    Add rule
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Active rules ({rules.length})</CardTitle>
                  <CardDescription>
                    Evaluated in order; the first matching keyword wins.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {rules.length === 0 && (
                    <p className="text-sm text-muted-foreground italic">
                      No rules configured yet.
                    </p>
                  )}
                  {rules.map((rule: SmartRule) => (
                    <div
                      key={rule.id}
                      className="group flex flex-col gap-2 rounded-lg border bg-card p-3 shadow-sm transition-colors hover:bg-muted/50"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-sm font-semibold text-amber-600 dark:text-amber-400">
                          IF “{rule.keyword}”
                        </span>
                        <button
                          type="button"
                          onClick={() => deleteMutation.mutate(rule.id)}
                          className="text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-destructive"
                          aria-label="Delete rule"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <ArrowRight size={14} />
                        {rule.category ? (
                          <Badge variant="secondary">
                            {rule.category.name}
                          </Badge>
                        ) : (
                          <span className="italic">No category</span>
                        )}
                        <span>+</span>
                        {rule.merchant ? (
                          <Badge variant="secondary">
                            {rule.merchant.name}
                          </Badge>
                        ) : (
                          <span className="italic">No merchant</span>
                        )}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
