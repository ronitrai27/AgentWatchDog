-- GitHub's public email, when the person has one. Rox does not ask GitHub for
-- the "read email addresses" permission, so this is often empty.
ALTER TABLE users ADD COLUMN email text;
