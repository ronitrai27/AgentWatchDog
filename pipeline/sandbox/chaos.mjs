// Toxiproxy scenarios for one service. Faults are put on the path through the proxy, while a
// second, direct path checks that the service itself stays healthy and fast, and that it
// recovers fully once the faults are gone. Writes report.json and junit.xml to OUT.
//   TOXI=http://toxi:8474 TARGET=api:4100 OUT=/out/toxiproxy node chaos.mjs
import { writeFileSync } from "node:fs";

const TOXI = process.env.TOXI ?? "http://toxi:8474";
const TARGET = process.env.TARGET ?? "api:4100";
const HEALTH = process.env.HEALTH ?? "/healthz";
const HEAVY = process.env.HEAVY ?? "/v1/products?limit=50";
const OUT = process.env.OUT ?? "/out/toxiproxy";
const VIA = "http://toxi:4101";
const DIRECT = `http://${TARGET}`;

const toxi = async (method, path, body) => {
  const res = await fetch(`${TOXI}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404)
    throw new Error(
      `toxiproxy ${method} ${path}: ${res.status} ${await res.text()}`,
    );
};

async function call(base, path, timeoutMs) {
  const started = performance.now();
  try {
    const res = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer();
    return { ok: res.ok, status: res.status, ms: performance.now() - started };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: performance.now() - started,
      error: error.name,
    };
  }
}

const p95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
    : Number.POSITIVE_INFINITY;
};
const round = (n) => Math.round(n);

/** The direct path, measured while a fault is active on the proxied path. */
async function directProbe(n = 10) {
  const results = [];
  for (let i = 0; i < n; i++) results.push(await call(DIRECT, HEALTH, 2000));
  return {
    allOk: results.every((r) => r.ok),
    p95: round(p95(results.map((r) => r.ms))),
  };
}

const addToxic = (name, type, attributes, stream = "downstream") =>
  toxi("POST", "/proxies/api/toxics", {
    name,
    type,
    stream,
    toxicity: 1,
    attributes,
  });
const removeToxic = (name) => toxi("DELETE", `/proxies/api/toxics/${name}`);

const scenarios = [];
async function scenario(name, fn) {
  const started = performance.now();
  try {
    const r = await fn();
    scenarios.push({ name, ...r, ms: round(performance.now() - started) });
  } catch (error) {
    scenarios.push({
      name,
      pass: false,
      detail: `scenario crashed: ${error.message}`,
      ms: round(performance.now() - started),
    });
  }
}

await toxi("DELETE", "/proxies/api");
await toxi("POST", "/proxies", {
  name: "api",
  listen: "0.0.0.0:4101",
  upstream: TARGET,
  enabled: true,
});

await scenario("baseline through the proxy", async () => {
  const rs = await Promise.all(
    Array.from({ length: 20 }, () => call(VIA, HEALTH, 2000)),
  );
  const ok = rs.filter((r) => r.ok).length;
  return {
    pass: ok === 20,
    detail: `${ok}/20 ok, p95 ${round(p95(rs.map((r) => r.ms)))} ms`,
  };
});

await scenario("1 s latency on responses", async () => {
  await addToxic("latency", "latency", { latency: 1000, jitter: 100 });
  const rs = await Promise.all(
    Array.from({ length: 10 }, () => call(VIA, HEALTH, 5000)),
  );
  const direct = await directProbe();
  await removeToxic("latency");
  const ok = rs.filter((r) => r.ok).length;
  return {
    pass: ok === 10 && direct.allOk && direct.p95 < 300,
    detail: `${ok}/10 slow calls completed (p95 ${round(p95(rs.map((r) => r.ms)))} ms); direct p95 ${direct.p95} ms`,
  };
});

await scenario("connections reset by peer", async () => {
  await addToxic("reset", "reset_peer", { timeout: 0 });
  const rs = await Promise.all(
    Array.from({ length: 10 }, () => call(VIA, HEALTH, 3000)),
  );
  const direct = await directProbe();
  await removeToxic("reset");
  return {
    pass: direct.allOk && direct.p95 < 300,
    detail: `${rs.filter((r) => !r.ok).length}/10 proxied calls reset as expected; direct path ok ${direct.allOk}, p95 ${direct.p95} ms`,
  };
});

await scenario("30 hung connections for 5 s", async () => {
  await addToxic("hang", "timeout", { timeout: 0 });
  const hung = Array.from({ length: 30 }, () => call(VIA, HEAVY, 5000));
  await new Promise((r) => setTimeout(r, 1000));
  const direct = await directProbe(20);
  await Promise.all(hung);
  await removeToxic("hang");
  return {
    pass: direct.allOk && direct.p95 < 300,
    detail: `while 30 connections hung, direct p95 ${direct.p95} ms, all ok ${direct.allOk}`,
  };
});

await scenario("slow clients at 1 KB/s", async () => {
  await addToxic("slow", "bandwidth", { rate: 1 });
  const slow = Array.from({ length: 10 }, () => call(VIA, HEAVY, 6000));
  await new Promise((r) => setTimeout(r, 1000));
  const direct = await directProbe(20);
  await Promise.all(slow);
  await removeToxic("slow");
  return {
    pass: direct.allOk && direct.p95 < 500,
    detail: `while 10 clients read at 1 KB/s, direct p95 ${direct.p95} ms, all ok ${direct.allOk}`,
  };
});

await scenario("full recovery after the faults", async () => {
  const rs = await Promise.all(
    Array.from({ length: 20 }, () => call(VIA, HEALTH, 2000)),
  );
  const ok = rs.filter((r) => r.ok).length;
  const worst = round(p95(rs.map((r) => r.ms)));
  return {
    pass: ok === 20 && worst < 500,
    detail: `${ok}/20 ok, p95 ${worst} ms`,
  };
});

const failed = scenarios.filter((s) => !s.pass);
writeFileSync(
  `${OUT}/report.json`,
  JSON.stringify({ target: TARGET, scenarios }, null, 2),
);
const esc = (s) =>
  String(s).replace(
    /[<>&"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c],
  );
writeFileSync(
  `${OUT}/junit.xml`,
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="toxiproxy" tests="${scenarios.length}" failures="${failed.length}">\n<testsuite name="toxiproxy" tests="${scenarios.length}" failures="${failed.length}" errors="0">\n${scenarios
    .map(
      (s) =>
        `<testcase classname="toxiproxy" name="${esc(s.name)}" time="${(s.ms / 1000).toFixed(3)}">${s.pass ? "" : `<failure message="${esc(s.detail)}"/>`}</testcase>`,
    )
    .join("\n")}\n</testsuite>\n</testsuites>\n`,
);
for (const s of scenarios)
  console.log(`${s.pass ? "PASS" : "FAIL"}  ${s.name}: ${s.detail}`);
process.exit(failed.length ? 1 : 0);
