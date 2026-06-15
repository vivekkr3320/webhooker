-- init-db.sql
-- Database schema bootstrapping for WebhookEngine

-- 1. Organizations
CREATE TABLE IF NOT EXISTS organizations (
  id VARCHAR(255) PRIMARY KEY,
  "ownerEmail" VARCHAR(255) UNIQUE NOT NULL,
  "razorpayCustomerId" VARCHAR(255),
  "razorpaySubscriptionId" VARCHAR(255),
  "planTier" VARCHAR(50) DEFAULT 'free',
  "subscriptionStatus" VARCHAR(50) DEFAULT 'active',
  "monthlyUsageCount" INTEGER DEFAULT 0,
  "quotaResetDate" VARCHAR(255)
);

-- 2. API Keys
CREATE TABLE IF NOT EXISTS "apiKeys" (
  "pubId" VARCHAR(255) PRIMARY KEY,
  hash VARCHAR(255) NOT NULL,
  "orgId" VARCHAR(255) REFERENCES organizations(id) ON DELETE CASCADE,
  "createdAt" VARCHAR(255)
);

-- 3. Sessions
CREATE TABLE IF NOT EXISTS sessions (
  "sessionId" VARCHAR(255) PRIMARY KEY,
  "orgId" VARCHAR(255) REFERENCES organizations(id) ON DELETE CASCADE,
  "expiresAt" VARCHAR(255)
);

-- 4. Endpoints
CREATE TABLE IF NOT EXISTS endpoints (
  id VARCHAR(255) PRIMARY KEY,
  "orgId" VARCHAR(255) REFERENCES organizations(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret VARCHAR(255),
  events JSONB,
  active BOOLEAN DEFAULT TRUE,
  "createdAt" VARCHAR(255)
);

-- 5. Deliveries
CREATE TABLE IF NOT EXISTS deliveries (
  id VARCHAR(255) PRIMARY KEY,
  "orgId" VARCHAR(255) REFERENCES organizations(id) ON DELETE CASCADE,
  "endpointId" VARCHAR(255),
  url TEXT NOT NULL,
  event VARCHAR(255) NOT NULL,
  "payloadId" VARCHAR(255) NOT NULL,
  payload JSONB NOT NULL,
  headers JSONB,
  attempt INTEGER NOT NULL,
  timestamp VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL,
  "statusCode" INTEGER,
  "responseTime" INTEGER,
  "responseBody" TEXT,
  error TEXT
);

-- 5b. Webhook Logs (Consumer dashboard event logs)
CREATE TABLE IF NOT EXISTS webhook_logs (
  id VARCHAR(255) PRIMARY KEY,
  "orgId" VARCHAR(255) REFERENCES organizations(id) ON DELETE CASCADE,
  "endpointId" VARCHAR(255),
  url TEXT NOT NULL,
  event VARCHAR(255) NOT NULL,
  payload JSONB NOT NULL,
  "statusCode" INTEGER,
  timestamp VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL,
  error TEXT
);

-- 6. Queue Tasks
CREATE TABLE IF NOT EXISTS queue_tasks (
  id SERIAL PRIMARY KEY,
  task JSONB NOT NULL,
  "executeAt" BIGINT NOT NULL,
  status VARCHAR(50) DEFAULT 'active'
);

-- 7. Seed Default Dev Org
INSERT INTO organizations (
  id, 
  "ownerEmail", 
  "razorpayCustomerId", 
  "razorpaySubscriptionId", 
  "planTier", 
  "subscriptionStatus", 
  "monthlyUsageCount", 
  "quotaResetDate"
) 
VALUES (
  'org_dev_default', 
  'admin@localhost', 
  'cust_mock', 
  'sub_mock', 
  'pro', 
  'active', 
  0, 
  '2026-07-14T10:27:26.316Z'
)
ON CONFLICT (id) DO NOTHING;
