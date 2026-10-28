package graph

// graph:table-writes-exempt: migrations own schema changes

const schemaV50 = `
ALTER TABLE questions ADD COLUMN route_stage TEXT CHECK(route_stage IN ('project','global','user'));
ALTER TABLE questions ADD COLUMN route_revision INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version=50;
`
