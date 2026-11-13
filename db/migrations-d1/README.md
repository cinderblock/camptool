# D1 versions of migrations

A file here replaces the migration of the same name in `db/migrations/` when
`scripts/d1-migrations.ts` prepares migrations for Cloudflare D1. Everything
else is copied across unchanged, apart from the foreign-key pragmas.

Add one only when D1 can't run the original, and keep it meaning exactly the
same thing. Say at the top why it exists. The Bun host never reads this folder.

| Migration | Why |
| --- | --- |
| `0060_crazy_avengers.sql` | D1 caps compound `SELECT`s; the feature-key list becomes a `VALUES` list. |
