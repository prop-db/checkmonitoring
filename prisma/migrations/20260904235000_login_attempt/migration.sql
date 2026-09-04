-- The login throttle's counter.
--
-- Rate limiting was left out on the stated basis that this system would be
-- reachable only from inside the office. That basis is gone: the client has
-- chosen a public URL on Vercel, and this database holds every cheque the group
-- has issued. Nothing currently slows an attacker guessing passwords.
--
-- The counter is a TABLE, not a process-local map, and that is forced rather
-- than preferred. Vercel is serverless: each lambda has its own memory, a cold
-- start begins at zero, and requests spread across instances. A `Map` here
-- would look like a control in code review and stop nobody. See the model note
-- in schema.prisma.
--
-- No foreign key to "User". Throttling on an address that has no account is
-- most of the point — it is what stops one guess being sprayed across thousands
-- of names — and a foreign key would reject precisely those rows.
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- The two throttle reads. Both are (bucket, time) because both count failures
-- inside a rolling window, and the window is the selective half once an attack
-- has put a lot of rows under one email or one address.
CREATE INDEX "LoginAttempt_email_createdAt_idx" ON "LoginAttempt"("email", "createdAt");
CREATE INDEX "LoginAttempt_ip_createdAt_idx" ON "LoginAttempt"("ip", "createdAt");

-- The retention prune runs inside the same call that writes an attempt, so it
-- executes on every single sign-in. Without this index that is a sequential
-- scan of the table per login — which is worst exactly when the table is
-- largest, i.e. during the attack the prune exists to bound.
CREATE INDEX "LoginAttempt_createdAt_idx" ON "LoginAttempt"("createdAt");
