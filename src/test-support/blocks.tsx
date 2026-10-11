import type { ReactNode } from "react"

import type { AccountRecord } from "@/lib/account-collections"

// =============================================================================
// Shared test support for account-surface component tests.
//
// Single source for the two blocks that used to be copy-pasted per test file
// (SonarCloud's new-code duplication gate flags repeated literals):
//   - `RouterLinkMock` — the router-less <Link> stand-in for
//     `vi.mock("@tanstack/react-router")`;
//   - `TEST_ACCOUNT` — the canonical wire-shape AccountRecord every
//     account-surface test mounts.
// =============================================================================

/** A router-less stand-in for <Link>: tests only need the destination. */
export function RouterLinkMock({
  to,
  params,
  children,
  className,
}: {
  to: string
  params?: Record<string, string>
  children?: ReactNode
  className?: string
}) {
  return (
    <a
      href={Object.entries(params ?? {}).reduce(
        (path, [key, value]) => path.replace(`$${key}`, value),
        to
      )}
      className={className}
    >
      {children}
    </a>
  )
}

export const TEST_ACCOUNT: AccountRecord = {
  id: "acc-1",
  name: "Bank Jago",
  accountClass: "ASSET",
  accountType: "DEPOSITORY",
  accountSubtype: "checking",
  balanceSource: "transaction_flow",
  balance: "100000",
  currency: "IDR",
  color: null,
  status: "active",
  archivedAt: null,
  institutionName: null,
  externalProvider: null,
  externalAccountId: null,
  mask: null,
  isImportable: true,
  creditLimit: null,
  statementDay: null,
  dueDay: null,
  interestRateBps: null,
  counterpartyMerchantId: null,
  reserveBalance: null,
  zakatPayerId: null,
  zakatJointPayerId: null,
  zakatJointSharePercent: null,
}
