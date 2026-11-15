ALTER TABLE projects ADD COLUMN management TEXT NOT NULL DEFAULT 'direct' CHECK(management IN ('direct','existing'));
ALTER TABLE projects ADD COLUMN provider TEXT NOT NULL DEFAULT 'cloudflare';
CREATE TABLE project_links (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 category TEXT NOT NULL CHECK(category IN ('hosting','source')), role TEXT NOT NULL,
 provider TEXT NOT NULL, account_id TEXT REFERENCES accounts(id), resource_kind TEXT NOT NULL,
 external_id TEXT NOT NULL, data TEXT NOT NULL, verified_at TEXT NOT NULL
);
CREATE UNIQUE INDEX project_hosting_owner ON project_links(provider,account_id,resource_kind,external_id) WHERE category='hosting';
CREATE INDEX project_links_project ON project_links(project_id);
CREATE TABLE project_observations (
 project_id TEXT NOT NULL REFERENCES projects(id), subject TEXT NOT NULL, data TEXT,
 error TEXT, checked_at TEXT NOT NULL, succeeded_at TEXT,
 PRIMARY KEY(project_id,subject)
);
