CREATE TYPE "FunnelRunStatus" AS ENUM ('ACTIVE', 'WAITING_REPLY', 'WAITING_TIMER', 'COMPLETED', 'EXPIRED', 'FAILED');

CREATE TABLE "Funnel" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "draft" JSONB NOT NULL,
  "publishedVersion" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Funnel_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Funnel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Funnel_workspaceId_idx" ON "Funnel"("workspaceId");

CREATE TABLE "FunnelVersion" (
  "funnelId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "graph" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FunnelVersion_pkey" PRIMARY KEY ("funnelId", "version"),
  CONSTRAINT "FunnelVersion_funnelId_fkey" FOREIGN KEY ("funnelId") REFERENCES "Funnel"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "FunnelRun" (
  "id" TEXT NOT NULL,
  "funnelId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "automationId" TEXT NOT NULL,
  "instagramAccountId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "username" TEXT,
  "commentId" TEXT,
  "triggerKey" TEXT,
  "currentNodeId" TEXT NOT NULL,
  "status" "FunnelRunStatus" NOT NULL DEFAULT 'ACTIVE',
  "variables" JSONB NOT NULL DEFAULT '{}',
  "lastReply" TEXT,
  "firstMessageSent" BOOLEAN NOT NULL DEFAULT false,
  "lastInteractionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "windowExpiresAt" TIMESTAMP(3) NOT NULL,
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FunnelRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FunnelRun_funnelId_fkey" FOREIGN KEY ("funnelId") REFERENCES "Funnel"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FunnelRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "FunnelRun_automationId_userId_idx" ON "FunnelRun"("automationId", "userId");
CREATE INDEX "FunnelRun_funnelId_idx" ON "FunnelRun"("funnelId");
-- One unfinished run per person and campaign. Prisma cannot express this.
CREATE UNIQUE INDEX "FunnelRun_one_unfinished_per_person"
  ON "FunnelRun"("automationId", "userId")
  WHERE "status" IN ('ACTIVE', 'WAITING_REPLY', 'WAITING_TIMER');

ALTER TABLE "Automation" ADD COLUMN "funnelId" TEXT;
CREATE INDEX "Automation_funnelId_idx" ON "Automation"("funnelId");
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_funnelId_fkey" FOREIGN KEY ("funnelId") REFERENCES "Funnel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
