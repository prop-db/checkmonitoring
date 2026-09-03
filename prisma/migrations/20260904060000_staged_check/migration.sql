-- CreateEnum
CREATE TYPE "StagedReason" AS ENUM ('NO_COMPANY', 'NO_CHECK_NUMBER', 'AMBIGUOUS_COMPANY');

-- CreateTable
CREATE TABLE "StagedCheck" (
    "id" TEXT NOT NULL,
    "sourceSheet" TEXT NOT NULL,
    "sourceRow" INTEGER NOT NULL,
    "reason" "StagedReason" NOT NULL,
    "checkNumber" TEXT,
    "cvNumber" TEXT,
    "apvNumbers" TEXT[],
    "poNumbers" TEXT[],
    "checkBookCode" TEXT,
    "cashAccountCode" TEXT,
    "companyCode" TEXT,
    "conflictingCompanies" TEXT[],
    "category" TEXT,
    "clearingRef" TEXT,
    "checkDate" TIMESTAMP(3),
    "amount" DECIMAL(18,2),
    "currency" TEXT,
    "payeeName" TEXT,
    "impliedStatus" "CheckStatus" NOT NULL,
    "promotedCheckId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StagedCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StagedCheck_checkNumber_idx" ON "StagedCheck"("checkNumber");

-- CreateIndex
CREATE INDEX "StagedCheck_reason_idx" ON "StagedCheck"("reason");

-- CreateIndex
CREATE UNIQUE INDEX "StagedCheck_sourceSheet_sourceRow_key" ON "StagedCheck"("sourceSheet", "sourceRow");

