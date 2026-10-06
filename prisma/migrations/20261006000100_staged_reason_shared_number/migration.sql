-- An Acumatica payment on a cheque number another payment already holds here
-- (full check 2026-10-06). Additive; nothing reads it until the deploy.
ALTER TYPE "StagedReason" ADD VALUE 'SHARED_NUMBER';
