-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Account_familyId_deletedAt_idx" ON "Account"("familyId", "deletedAt");

-- CreateIndex
CREATE INDEX "Account_familyId_externalProvider_externalAccountId_idx" ON "Account"("familyId", "externalProvider", "externalAccountId");
