-- CreateIndex
CREATE INDEX "Account_familyId_idx" ON "Account"("familyId");

-- CreateIndex
CREATE INDEX "Category_familyId_idx" ON "Category"("familyId");

-- CreateIndex
CREATE INDEX "Merchant_familyId_idx" ON "Merchant"("familyId");

-- CreateIndex
CREATE INDEX "SmartRule_familyId_idx" ON "SmartRule"("familyId");

-- CreateIndex
CREATE INDEX "SplitEntry_transactionId_idx" ON "SplitEntry"("transactionId");

-- CreateIndex
CREATE INDEX "Transaction_deletedAt_date_idx" ON "Transaction"("deletedAt", "date" DESC);

-- CreateIndex
CREATE INDEX "Transaction_accountId_date_idx" ON "Transaction"("accountId", "date" DESC);

-- CreateIndex
CREATE INDEX "Transaction_userId_idx" ON "Transaction"("userId");

-- CreateIndex
CREATE INDEX "Transaction_categoryId_idx" ON "Transaction"("categoryId");

-- CreateIndex
CREATE INDEX "Transaction_merchantId_idx" ON "Transaction"("merchantId");
