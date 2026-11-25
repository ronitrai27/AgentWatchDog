// Load test for the Saltmarket API, run by Rox Lab inside the sandbox.
// PHASES picks the scenarios (smoke, load, stress, soak); they run one after another.
// Short durations, so a lab run stays within a few minutes.
import { check } from "k6";
import http from "k6/http";

const BASE = __ENV.BASE_URL || "http://api:4100";
const PHASES = (__ENV.PHASES || "smoke,load,stress,soak").split(",");

const ALL = {
  smoke: { executor: "constant-vus", vus: 2, duration: "10s" },
  load: {
    executor: "ramping-vus",
    startVUs: 0,
    stages: [
      { duration: "10s", target: 20 },
      { duration: "20s", target: 20 },
    ],
  },
  stress: {
    executor: "ramping-vus",
    startVUs: 0,
    stages: [
      { duration: "10s", target: 60 },
      { duration: "20s", target: 60 },
    ],
  },
  soak: { executor: "constant-vus", vus: 10, duration: "60s" },
};

/** Latency and error limits per scenario. Stress is allowed to be slower than normal load. */
const LIMITS = {
  smoke: { p95: 200, p99: 500, errors: 0.01 },
  load: { p95: 300, p99: 800, errors: 0.01 },
  stress: { p95: 1000, p99: 2000, errors: 0.05 },
  soak: { p95: 300, p99: 800, errors: 0.01 },
};

const scenarios = {};
const thresholds = {};
let start = 0;
const seconds = { smoke: 10, load: 30, stress: 30, soak: 60 };
for (const phase of PHASES) {
  scenarios[phase] = { ...ALL[phase], startTime: `${start}s`, tags: { phase } };
  start += seconds[phase] + 2;
  const l = LIMITS[phase];
  thresholds[`http_req_duration{phase:${phase}}`] = [
    `p(95)<${l.p95}`,
    `p(99)<${l.p99}`,
  ];
  thresholds[`http_req_failed{phase:${phase}}`] = [`rate<${l.errors}`];
}

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
};

export default function () {
  const page = http.get(`${BASE}/v1/products?limit=24`, {
    tags: { name: "list" },
  });
  check(page, { "list is 200": (r) => r.status === 200 });
  const items = page.status === 200 ? page.json("items") : [];
  if (items && items.length) {
    const slug = items[Math.floor(Math.random() * items.length)].slug;
    const one = http.get(`${BASE}/v1/products/${slug}`, {
      tags: { name: "detail" },
    });
    check(one, { "detail is 200": (r) => r.status === 200 });
  }
  const health = http.get(`${BASE}/healthz`, { tags: { name: "health" } });
  check(health, { "health is 200": (r) => r.status === 200 });
}
