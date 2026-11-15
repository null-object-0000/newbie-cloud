CREATE TABLE projects (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
 name TEXT NOT NULL, remote_name TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'new',
 current_release TEXT, active_task TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 request_key TEXT NOT NULL UNIQUE
);
CREATE TABLE releases (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL DEFAULT 'publish',
 target_release TEXT, status TEXT NOT NULL DEFAULT 'uploading', external_id TEXT,
 url TEXT, message TEXT NOT NULL, error TEXT, verification TEXT, verified_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, request_key TEXT NOT NULL,
 UNIQUE(project_id,request_key)
);
CREATE INDEX releases_project ON releases(project_id,created_at DESC);
CREATE TABLE release_files (
 release_id TEXT NOT NULL REFERENCES releases(id), path TEXT NOT NULL, hash TEXT NOT NULL,
 sha256 TEXT NOT NULL, size INTEGER NOT NULL, content_type TEXT NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(release_id,path)
);
CREATE TABLE agent_tokens (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE, allow_rollback INTEGER NOT NULL DEFAULT 0,
 expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
