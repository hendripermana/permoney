-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_familyId_createdAt_id_idx" ON "AuditLog"("familyId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_requestId_idx" ON "AuditLog"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_createdAt_id_key" ON "AuditLog"("createdAt", "id");

-- RLS & Grants for AuditLog
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'permoney_audit_retention') THEN
    CREATE ROLE permoney_audit_retention;
  END IF;
END
$$;

ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_log_tenant_select ON "AuditLog"
  FOR SELECT
  USING ("familyId" = current_setting('app.family_id', true)::text);

CREATE POLICY audit_log_tenant_insert ON "AuditLog"
  FOR INSERT
  WITH CHECK ("familyId" = current_setting('app.family_id', true)::text);

CREATE POLICY audit_log_retention_delete ON "AuditLog"
  FOR DELETE TO permoney_audit_retention
  USING ("createdAt" < now() - interval '7 years');

CREATE POLICY audit_log_retention_select ON "AuditLog"
  FOR SELECT TO permoney_audit_retention
  USING (true);

ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Konfigurasi role permoney_app jika ada
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'permoney_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM permoney_app;
    GRANT INSERT, SELECT ON "AuditLog" TO permoney_app;
  END IF;

  -- Konfigurasi role retention
  GRANT SELECT, DELETE ON "AuditLog" TO permoney_audit_retention;
END
$$;
