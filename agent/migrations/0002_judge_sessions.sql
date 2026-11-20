-- Every Quick Judge Mode session now gets its own user row (random id, name
-- "User"), so more than one demo user must be allowed. The seeded 'judge'
-- row from 0001 stays as it is.
DROP INDEX users_one_demo;

-- Look up recent demo sessions and last activity quickly.
CREATE INDEX users_demo_created_idx ON users (created_at DESC) WHERE is_demo;
