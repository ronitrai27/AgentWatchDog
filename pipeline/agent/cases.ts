// Seeded bugs for the agent: ordinary mistakes in the demo app, each caught by an existing test.
// `find` and `put` change one place in the code; `fix` is the known good answer, used to prove the
// gates without any AI. The repository itself is never changed.

export type Case = {
  id: string;
  ws: string;
  file: string;
  find: string;
  put: string;
  /** The test this bug breaks. */
  test: string;
};

export const CASES: Case[] = [
  {
    id: "paging-skips",
    ws: "apps/api",
    file: "apps/api/src/modules/catalog/catalog.service.ts",
    find: "items.at(-1)?.id",
    put: "rows.at(-1)?.id",
    test: "catalog > pages through every product exactly once",
  },
  {
    id: "stock-zero",
    ws: "apps/api",
    file: "apps/api/src/modules/catalog/catalog.repository.ts",
    find: "stock: patch.stock ?? null,",
    put: "stock: patch.stock || null,",
    test: "catalog > lets an admin create, change and archive a product",
  },
  {
    id: "expired-session",
    ws: "apps/api",
    file: "apps/api/src/modules/identity/identity.repository.ts",
    find: "WHERE s.token_hash = ? AND s.expires_at > ?`",
    put: "WHERE s.token_hash = ? AND s.expires_at <> ?`",
    test: "identity > ignores an expired session",
  },
];
