CREATE TABLE accounts (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('cloudflare','tencent','aliyun')),
 readonly INTEGER NOT NULL DEFAULT 1, credentials TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE zones (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 external_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(account_id, external_id)
);
CREATE INDEX zones_account ON zones(account_id);
CREATE TABLE operations (
 id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL, zone_id TEXT,
 kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL,
 payload TEXT, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT
);
CREATE INDEX operations_created ON operations(created_at DESC);
CREATE TABLE snapshots (
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, kind TEXT NOT NULL,
 data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(account_id,kind)
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
