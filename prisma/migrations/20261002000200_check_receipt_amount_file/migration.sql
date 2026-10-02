ALTER TABLE "Check" ADD COLUMN "receiptAmount" DECIMAL(18,2);

CREATE TABLE "CheckReceiptFile" (
    "checkId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CheckReceiptFile_pkey" PRIMARY KEY ("checkId")
);
ALTER TABLE "CheckReceiptFile" ADD CONSTRAINT "CheckReceiptFile_checkId_fkey"
    FOREIGN KEY ("checkId") REFERENCES "Check"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckReceiptFile" ADD CONSTRAINT "CheckReceiptFile_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
