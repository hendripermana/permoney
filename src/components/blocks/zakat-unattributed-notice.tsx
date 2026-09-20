import { Link } from "@tanstack/react-router"
import { AlertTriangle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/**
 * ADR-0058: once a household has 2+ payers, an account with no owner is left
 * out of EVERY payer's total rather than guessed. That must never be silent, so
 * this lists each such account by name, once, above the results.
 */
export function UnattributedAccountsNotice({
  accounts,
}: {
  accounts: Array<{ id: string; name: string }>
}) {
  return (
    <Card
      role="status"
      aria-label="Accounts without an owner"
      className="border-amber-500/50"
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="size-4 text-amber-500" aria-hidden />
          {accounts.length === 1
            ? "1 account has no owner and is not counted"
            : `${accounts.length} accounts have no owner and are not counted`}
        </CardTitle>
        <CardDescription>
          With more than one payer, Zakat is calculated per person, so an
          account nobody owns is left out of every total below instead of being
          guessed. Set an owner on each one (open the account, Edit, Owner) to
          include it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ul className="flex flex-wrap gap-2">
          {accounts.map((account) => (
            <li key={account.id}>
              <Link
                to="/accounts/$accountId"
                params={{ accountId: account.id }}
                className="inline-flex"
              >
                <Badge variant="outline">{account.name}</Badge>
              </Link>
            </li>
          ))}
        </ul>
        <Button asChild variant="outline" size="sm" className="self-start">
          <Link to="/accounts">Go to accounts</Link>
        </Button>
      </CardContent>
    </Card>
  )
}
