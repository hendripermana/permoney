-- PER-214 — backfill the person as merchant on existing debt-transfer legs.
--
-- Since PER-214, lend/borrow/repay transfers stamp the person (a
-- Merchant kind="person") as `merchantId` on BOTH legs, so the ledger Merchant
-- column shows the person and the merchant filter surfaces them. Transfers
-- posted BEFORE this change have `merchantId IS NULL`. This one-shot backfill
-- attributes those historical legs to the same person the account already
-- points at via `Account.counterpartyMerchantId`.
--
-- A "debt-transfer leg" is any non-deleted Transaction whose SOURCE
-- (`accountId`) or DESTINATION (`toAccountId`) account is a person-debt account
-- (an Account with a non-null `counterpartyMerchantId`). Both legs of a debt
-- transfer qualify: one references the debt account via `accountId`, the other
-- via `toAccountId`.
--
-- Tenant safety: the update is naturally scoped — a Transaction and the Account
-- it references always share the same `familyId` (enforced by the tenant
-- composite FKs), so setting `merchantId` from that account's
-- `counterpartyMerchantId` can never cross a family boundary. The target
-- merchant is likewise the account's own family merchant. We only touch rows
-- that are still NULL, so re-running is a no-op and it never clobbers a
-- merchant a user set by hand.

UPDATE "Transaction" AS t
SET "merchantId" = a."counterpartyMerchantId"
FROM "Account" AS a
WHERE t."merchantId" IS NULL
  AND t."deletedAt" IS NULL
  AND a."counterpartyMerchantId" IS NOT NULL
  AND a."familyId" = t."familyId"
  AND (t."accountId" = a.id OR t."toAccountId" = a.id);
