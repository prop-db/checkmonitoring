-- CreateEnum
CREATE TYPE "Role" AS ENUM ('FINANCE_USER', 'FINANCE_ADMIN');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE', 'SCHEDULED', 'RELEASED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ClearingStatus" AS ENUM ('NONE', 'DEPOSITED', 'ENCASHED', 'CLEARED');

-- CreateEnum
CREATE TYPE "Eligibility" AS ENUM ('SUPPLIER', 'BROKER', 'INTERNAL');

-- CreateEnum
CREATE TYPE "PortalDomain" AS ENUM ('LOCAL', 'BROKER');

-- CreateEnum
CREATE TYPE "PortalSyncStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'SYNCED', 'FAILED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('SYSTEM', 'USER');

-- CreateEnum
CREATE TYPE "PortalDirection" AS ENUM ('OUT', 'IN');

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalNames" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bank" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Bank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashAccount" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "bankId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,

    CONSTRAINT "CashAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckBook" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "bankId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,

    CONSTRAINT "CheckBook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT,
    "canonicalName" TEXT NOT NULL,
    "aliases" TEXT[],
    "eligibilityDefault" "Eligibility",

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Check" (
    "id" TEXT NOT NULL,
    "acumaticaPaymentId" TEXT,
    "checkNumber" TEXT NOT NULL,
    "cvNumber" TEXT,
    "checkDate" TIMESTAMP(3),
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "companyId" TEXT NOT NULL,
    "cashAccountId" TEXT,
    "checkBookId" TEXT,
    "vendorId" TEXT,
    "payeeName" TEXT NOT NULL,
    "category" TEXT,
    "eligibility" "Eligibility" NOT NULL,
    "eligibilityOverriddenById" TEXT,
    "portalTradeId" INTEGER,
    "portalDomain" "PortalDomain",
    "portalSyncStatus" "PortalSyncStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "status" "CheckStatus" NOT NULL DEFAULT 'GENERATED',
    "signedById" TEXT,
    "signedAt" TIMESTAMP(3),
    "readyById" TEXT,
    "readyAt" TIMESTAMP(3),
    "availablePickupDate" TIMESTAMP(3),
    "scheduledPickupDate" TIMESTAMP(3),
    "scheduledPickupTime" TEXT,
    "pickupRep" TEXT,
    "portalConfirmedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "orNumber" TEXT,
    "orDate" TIMESTAMP(3),
    "remarks" TEXT,
    "pointPerson" TEXT,
    "checksPossession" TEXT,
    "clearingStatus" "ClearingStatus" NOT NULL DEFAULT 'NONE',
    "crNumber" TEXT,
    "clearedDate" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "sourceSheet" TEXT,
    "sourceRow" INTEGER,
    "isStale" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Check_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckBill" (
    "id" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "apvNumber" TEXT NOT NULL,
    "poNumber" TEXT,
    "rrNumber" TEXT,
    "statusRr" TEXT,
    "description" TEXT,
    "glAccount" TEXT,
    "dueDate" TIMESTAMP(3),
    "termsCode" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdByName" TEXT,

    CONSTRAINT "CheckBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "checkId" TEXT,
    "actorType" "ActorType" NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalEvent" (
    "id" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "direction" "PortalDirection" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "mode" TEXT NOT NULL,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "checkId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'FINANCE_USER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_code_key" ON "Company"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Bank_code_key" ON "Bank"("code");

-- CreateIndex
CREATE UNIQUE INDEX "CashAccount_code_key" ON "CashAccount"("code");

-- CreateIndex
CREATE UNIQUE INDEX "CheckBook_code_key" ON "CheckBook"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_vendorId_key" ON "Vendor"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_canonicalName_key" ON "Vendor"("canonicalName");

-- CreateIndex
CREATE UNIQUE INDEX "Check_acumaticaPaymentId_key" ON "Check"("acumaticaPaymentId");

-- CreateIndex
CREATE INDEX "Check_status_idx" ON "Check"("status");

-- CreateIndex
CREATE INDEX "Check_eligibility_idx" ON "Check"("eligibility");

-- CreateIndex
CREATE INDEX "Check_checkDate_idx" ON "Check"("checkDate");

-- CreateIndex
CREATE INDEX "Check_availablePickupDate_idx" ON "Check"("availablePickupDate");

-- CreateIndex
CREATE UNIQUE INDEX "Check_companyId_checkNumber_key" ON "Check"("companyId", "checkNumber");

-- CreateIndex
CREATE INDEX "CheckBill_apvNumber_idx" ON "CheckBill"("apvNumber");

-- CreateIndex
CREATE INDEX "CheckBill_poNumber_idx" ON "CheckBill"("poNumber");

-- CreateIndex
CREATE INDEX "AuditLog_checkId_createdAt_idx" ON "AuditLog"("checkId", "createdAt");

-- CreateIndex
CREATE INDEX "PortalEvent_status_createdAt_idx" ON "PortalEvent"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AddForeignKey
ALTER TABLE "CashAccount" ADD CONSTRAINT "CashAccount_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashAccount" ADD CONSTRAINT "CashAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckBook" ADD CONSTRAINT "CheckBook_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckBook" ADD CONSTRAINT "CheckBook_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "CashAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_checkBookId_fkey" FOREIGN KEY ("checkBookId") REFERENCES "CheckBook"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_signedById_fkey" FOREIGN KEY ("signedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_readyById_fkey" FOREIGN KEY ("readyById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_eligibilityOverriddenById_fkey" FOREIGN KEY ("eligibilityOverriddenById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckBill" ADD CONSTRAINT "CheckBill_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "Check"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "Check"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalEvent" ADD CONSTRAINT "PortalEvent_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "Check"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "Check"("id") ON DELETE SET NULL ON UPDATE CASCADE;
