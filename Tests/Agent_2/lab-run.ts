// Prepares a run for the agent tests: the demo app at `main`, dependencies installed, and
// optionally one seeded bug. The install is done once per session and shared, so a case takes
// seconds, not a minute.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { install } from "../src/checks";
import { destroyRun, docker, ensureVolume, sandbox } from "../src/docker";
import { commitSha } from "../src/github";
import { checkout, loadVolume, readFacts, volumes } from "../src/source";
import type { Case } from "./cases";
import { Workspace } from "./workspace";

export const REPO = "ronitrai27/Testing_SRE_Demo_App";
const GOLDEN = "rox-golden-work";

/** The installed demo app at `main`, kept between sessions (per commit). */
async function golden(): Promise<{ volume: string; sha: string }> {
  const sha = await commitSha(REPO, "main");
  const volume = `${GOLDEN}-${sha.slice(0, 12)}`;
  const exists = await docker(["volume", "inspect", volume])
    .then(() => true)
    .catch(() => false);
  if (exists) return { volume, sha };

  const run = randomUUID();
  try {
    const dir = await checkout(REPO, sha, null, run);
    const v = volumes(run);
    await loadVolume(dir, v.src, run);
    for (const name of [v.work, v.out, v.base]) await ensureVolume(name, run);
    await ensureVolume(v.npmCache);
    const facts = await readFacts(dir, REPO, []);
    const r = await install(
      { run, repo: REPO, head: sha, base: null, pr: null },
      { ...facts, vitest: false },
    );
    if (!r.head) throw new Error(r.summary);
    await ensureVolume(volume);
    const copy = await sandbox({
      name: `rox-golden-${run}`,
      run,
      script: "cp -a /work/. /verify/",
      mounts: [
        { volume: v.work, at: "/work", readOnly: true },
        { volume, at: "/verify", readOnly: false },
      ],
      network: "none",
      workdir: "/tmp",
      timeoutMs: 5 * 60_000,
    });
    if (copy.code !== 0) throw new Error(copy.stderr.slice(-300));
    await rm(dir, { recursive: true, force: true });
  } finally {
    await destroyRun(run);
  }
  return { volume, sha };
}

const SEED = `node -e "const fs=require('fs');const c=JSON.parse(Buffer.from(process.env.CASE,'base64'));const s=fs.readFileSync(c.file,'utf8');if(s.split(c.find).length!==2)throw new Error('seed text not found once');fs.writeFileSync(c.file,s.replace(c.find,()=>c.put))"`;

export type LabCase = {
  run: string;
  sha: string;
  /** The installed volume every copy of this run is made from. */
  source: string;
  ws: Workspace;
  /** Opens a second, fresh copy with the same bug (for Verify). */
  fresh: () => Promise<Workspace>;
  end: () => Promise<void>;
};

/** A fresh run: `main` plus the seeded bug. Call `end` when done. */
export async function startCase(
  c: Case | null,
  run: string = randomUUID(),
): Promise<LabCase> {
  const g = await golden();
  const env: Record<string, string> = c
    ? { CASE: Buffer.from(JSON.stringify(c)).toString("base64") }
    : {};
  const open = async (kind: "agent" | "verify") => {
    const ws = new Workspace(run, kind);
    await ws.open(g.volume, c ? SEED : "true", env);
    return ws;
  };
  return {
    run,
    sha: g.sha,
    source: g.volume,
    ws: await open("agent"),
    fresh: async () => {
      const ws = new Workspace(run, "verify");
      await ws.close();
      return open("verify");
    },
    end: async () => void (await destroyRun(run)),
  };
}
