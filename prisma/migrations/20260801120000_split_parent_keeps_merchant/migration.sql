-- PER-210: A split PARENT retains its single merchantId.
--
-- Domain semantic (Model 1): merchant = WHERE a purchase happened (one
-- receipt/store); category = WHAT each line item is. A split transaction is
-- still one receipt at one merchant, so the parent keeps its single
-- `merchantId`. Only `categoryId` is nulled on the parent because categories
-- live on the SplitEntry children.
--
-- The original constraint (see
-- prisma/migrations/20260523065000_data_integrity_constraints/migration.sql)
-- conflated merchant with category and forced BOTH to null on split, which
-- silently dropped the merchant. Relax it to category-only.
ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS split_parent_details_live_on_children;
ALTER TABLE "Transaction" ADD CONSTRAINT split_parent_details_live_on_children CHECK (
  NOT "isSplit" OR "categoryId" IS NULL
);
