-- PER-17 / ADR-0006: transaction idempotency keys and replay records.

ALTER TABLE "Transaction"
  ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "tx_family_idempotency"
  ON "Transaction"("familyId", "idempotencyKey");

CREATE TABLE "IdempotencyRecord" (
  "id" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "statusCode" INTEGER NOT NULL,
  "responseJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IdempotencyRecord_familyId_endpoint_key_key"
  ON "IdempotencyRecord"("familyId", "endpoint", "key");

CREATE INDEX "IdempotencyRecord_expiresAt_idx"
  ON "IdempotencyRecord"("expiresAt");

ALTER TABLE "IdempotencyRecord"
  ADD CONSTRAINT "IdempotencyRecord_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "Family"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "IdempotencyRecord" ENABLE ROW LEVEL SECURITY;

CREATE POLICY idempotency_record_tenant_isolation ON "IdempotencyRecord"
  FOR ALL
  USING ("familyId" = current_setting('app.family_id', true)::text)
  WITH CHECK ("familyId" = current_setting('app.family_id', true)::text);

ALTER TABLE "IdempotencyRecord" FORCE ROW LEVEL SECURITY;
