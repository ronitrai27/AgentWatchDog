// Proves the sandbox rules by trying to break each one from inside a sandbox started with the
// exact flags every check uses. Each line must say BLOCKED or OK.
//   pnpm --dir Tests proof:isolation
import { randomUUID } from "node:crypto";
import "./env";
import {
  createNetwork,
  destroyRun,
  ensureVolume,
  LIMITS,
  sandbox,
  serviceLogs,
  startEgress,
} from "./docker";

const CANARY = `rox-canary-${randomUUID()}`;
process.env.ROX_CANARY_SECRET = CANARY;

type Probe = {
  rule: string;
  script: string;
  passIf: (out: string, code: number | null) => boolean;
};

const PROBES: Probe[] = [
  {
    rule: "No DNS",
    script: "getent hosts github.com && echo RESOLVED || echo NO_DNS",
    passIf: (o) => o.includes("NO_DNS"),
  },
  {
    rule: "No outbound network",
    script:
      "node -e \"require('https').get('https://1.1.1.1',r=>{console.log('REACHED',r.statusCode)}).on('error',e=>console.log('BLOCKED',e.code))\"",
    passIf: (o) => o.includes("BLOCKED") && !o.includes("REACHED"),
  },
  {
    rule: "No secrets from the host",
    script: `env | grep -c '${CANARY}' || true; env | grep -ciE 'token|secret|api_key|password' || true`,
    passIf: (o) =>
      o
        .trim()
        .split("\n")
        .every((l) => l.trim() === "0"),
  },
  {
    rule: "No Docker socket",
    script:
      "ls -l /var/run/docker.sock 2>/dev/null && echo SOCKET || echo NO_SOCKET",
    passIf: (o) => o.includes("NO_SOCKET"),
  },
  {
    rule: "Not root, no capabilities",
    script: "id -u; grep CapEff /proc/self/status",
    passIf: (o) => o.includes("10001") && /CapEff:\s+0+\b/.test(o),
  },
  {
    rule: "No privilege escalation",
    script: "grep NoNewPrivs /proc/self/status",
    passIf: (o) => /NoNewPrivs:\s+1/.test(o),
  },
  {
    rule: "Root filesystem is read-only",
    script: "touch /usr/rox-test 2>/dev/null && echo WROTE || echo READ_ONLY",
    passIf: (o) => o.includes("READ_ONLY"),
  },
  {
    rule: "Source is read-only",
    script: "touch /src/rox-test 2>/dev/null && echo WROTE || echo READ_ONLY",
    passIf: (o) => o.includes("READ_ONLY"),
  },
  // Limits are proven by trying to pass them, which works on cgroup v1 and v2 alike.
  {
    rule: `Memory limit (${LIMITS.memory})`,
    script:
      'node -e "const a=[];for(;;)a.push(Buffer.alloc(256*1024*1024,1))" 2>/dev/null; echo EXIT=$?',
    passIf: (o) => o.includes("EXIT=137"),
  },
  {
    rule: `CPU limit (${LIMITS.cpus} CPUs)`,
    script:
      "cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo $(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us) $(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)",
    passIf: (o) => /^200000 100000/.test(o.trim()),
  },
  {
    rule: `Process limit (${LIMITS.pids})`,
    // The shell exits when it cannot start a process, so Node starts them and counts the failures.
    script: `node -e "const {spawn}=require('child_process');let failed=0;const ps=[];for(let i=0;i<${LIMITS.pids + 300};i++){const p=spawn('sleep',['30']);p.on('error',()=>failed++);ps.push(p)}setTimeout(()=>{console.log('TRIED='+ps.length+' FAILED='+failed);for(const p of ps)p.kill('SIGKILL');process.exit(0)},4000)"`,
    passIf: (o) => Number(/FAILED=(\d+)/.exec(o)?.[1] ?? 0) > 0,
  },
  {
    rule: "Time limit kills a stuck command",
    script: "sleep 60; echo STILL_RUNNING",
    passIf: (o) => !o.includes("STILL_RUNNING"),
  },
];

async function main() {
  const run = randomUUID();
  const src = `rox-src-${run}`;
  await ensureVolume(src, run);
  let failed = 0;
  try {
    for (const p of PROBES) {
      const r = await sandbox({
        name: `rox-proof-${run}`,
        run,
        script: p.script,
        mounts: [{ volume: src, at: "/src", readOnly: true }],
        network: "none",
        workdir: "/src",
        timeoutMs: p.rule.startsWith("Time limit") ? 3000 : 30_000,
      });
      const out = `${r.stdout}${r.stderr}`;
      const ok = p.passIf(out, r.code);
      if (!ok) failed++;
      console.log(
        `${ok ? "OK     " : "BROKEN "} ${p.rule.padEnd(36)} ${out.trim().split("\n").join(" | ").slice(0, 90)}`,
      );
    }

    // The dependency install network: out only through the egress proxy, only to the registry.
    console.log("\nDependency install network (egress proxy):");
    const net = `rox-inst-${run}`;
    await createNetwork(net, run);
    await startEgress(run, net);
    const proxy = "http://egress:3128";
    const EGRESS: Probe[] = [
      {
        rule: "npm registry through the proxy",
        script: `npm view left-pad version --registry https://registry.npmjs.org --https-proxy ${proxy} --proxy ${proxy} 2>&1 | tail -1`,
        passIf: (o) => /^\d+\.\d+\.\d+/.test(o.trim()),
      },
      {
        rule: "Other host through the proxy",
        script: `curl -s -o /dev/null -w '%{http_code}' -x ${proxy} -m 10 https://github.com 2>&1; echo " exit=$?"`,
        passIf: (o) => !/^200/.test(o.trim()) && !o.includes("exit=0"),
      },
      {
        rule: "Plain HTTP through the proxy",
        script: `curl -s -o /dev/null -w '%{http_code}' -x ${proxy} -m 10 http://example.com; echo`,
        passIf: (o) => o.trim().startsWith("403"),
      },
      {
        rule: "Registry without the proxy",
        script:
          "curl -s -o /dev/null -m 8 https://registry.npmjs.org && echo REACHED || echo BLOCKED",
        passIf: (o) => o.includes("BLOCKED"),
      },
    ];
    for (const p of EGRESS) {
      const r = await sandbox({
        name: `rox-proof-${run}`,
        run,
        script: p.script,
        mounts: [],
        network: { name: net },
        workdir: "/tmp",
        timeoutMs: 60_000,
      });
      const out = `${r.stdout}${r.stderr}`;
      const ok = p.passIf(out, r.code);
      if (!ok) failed++;
      console.log(
        `${ok ? "OK     " : "BROKEN "} ${p.rule.padEnd(36)} ${out.trim().split("\n").join(" | ").slice(0, 90)}`,
      );
    }
    const decisions = (await serviceLogs(`rox-${run}-egress`, 50))
      .split("\n")
      .filter((l) => l.includes('"verdict"'))
      .map((l) => {
        const d = JSON.parse(l) as { verdict: string; target: string };
        return `${d.verdict} ${d.target}`;
      });
    console.log(`        proxy log: ${decisions.join(", ")}`);
  } finally {
    const removed = await destroyRun(run);
    console.log(
      `\nDestroyed after the proof: ${removed.containers} containers, ${removed.networks} networks, ${removed.volumes} volumes`,
    );
  }
  console.log(failed ? `\n${failed} rule(s) BROKEN` : "\nEvery rule held.");
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
