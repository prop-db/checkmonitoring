-- CreateEnum
CREATE TYPE "AcumaticaTenant" AS ENUM ('GOLIVE', 'MANUFACTURING');

-- AlterEnum
ALTER TYPE "CheckStatus" ADD VALUE 'VOIDED';

-- AlterTable
ALTER TABLE "Check" ADD COLUMN     "acumaticaBranch" TEXT,
ADD COLUMN     "acumaticaDocType" TEXT,
ADD COLUMN     "acumaticaStatus" TEXT,
ADD COLUMN     "acumaticaTenant" "AcumaticaTenant",
ADD COLUMN     "lastModifiedOn" TIMESTAMP(3),
ADD COLUMN     "voidedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "branch" TEXT,
ADD COLUMN     "tenant" "AcumaticaTenant";

-- CreateIndex
CREATE UNIQUE INDEX "Company_tenant_branch_key" ON "Company"("tenant", "branch");
