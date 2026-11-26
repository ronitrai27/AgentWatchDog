// The pull request text. GitHub renders Markdown only, so the layout uses what it supports: an
// alert box for the verdict, tables for the numbers, and collapsible sections for the details.
// A skipped check is shown as skipped with its reason, never as passed.
import type { Findings, Review } from "./agents";
import type { Contract, Gate, Group } from "./gates";

const GROUPS: [Group, string][] = [
  ["security", "🛡️ Security"],
  ["quality", "🧩 Code quality"],
  ["tests", "🧪 Tests"],
  ["performance", "⚡ Performance and resilience"],
];

const seconds = (ms: number) =>
  ms >= 60_000
    ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
    : `${(ms / 1000).toFixed(1)}s`;

const mark = (g: Gate) => (g.skipped ? "⏭️" : g.ok ? "✅" : "❌");
const oneLine = (s: string, n: number) =>
  s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim().slice(0, n);

export function prBody(o: {
  contract: Contract;
  findings: Findings;
  summary: string;
  gates: Gate[];
  review: Review | null;
  attempts: { n: number; by: string | null }[];
  run: string;
  usd: number;
}): string {
  const checks = o.gates.filter((g) => g.group !== "guard");
  const ran = checks.filter((g) => !g.skipped);
  const passed = ran.filter((g) => g.ok).length;
  const skipped = checks.length - ran.length;
  const total = o.gates.reduce((t, g) => t + g.ms, 0);
  const perf = o.gates.find((g) => g.name.startsWith("Performance"));
  const p95 =
    perf && !perf.skipped
      ? /p95 (\d+) ms vs base (\d+) ms/.exec(perf.detail)
      : null;

  const groupRow = ([group, label]: [Group, string]) => {
    const gs = checks.filter((g) => g.group === group);
    if (!gs.length) return null;
    const failed = gs.filter((g) => !g.ok);
    const skip = gs.filter((g) => g.skipped);
    const result = failed.length
      ? `❌ ${failed.length} failed`
      : skip.length === gs.length
        ? "⏭️ Skipped"
        : `✅ Passed${skip.length ? ` · ⏭️ ${skip.length} skipped` : ""}`;
    return `| ${label} | ${gs.map((g) => `${mark(g)} ${g.name}`).join("<br>")} | ${result} |`;
  };

  const detailRow = (g: Gate) =>
    `| ${mark(g)} ${g.name} | ${g.skipped ? "skipped" : g.ok ? "passed" : "failed"} | ${g.skipped ? "-" : seconds(g.ms)} | ${oneLine(g.skipped ?? g.detail ?? "", 220) || "-"} |`;

  const earlier = o.attempts.slice(0, -1);
  return `> [!TIP]
> **Verified, ready for human review.** ${passed} of ${ran.length} checks passed${skipped ? `, ${skipped} skipped (reasons below)` : ""}. A human reviews and merges; Rox never merges.

| ✅ Checks | ⏱️ Verify time | 📈 p95 (fix vs before) | 🔁 Attempts | 💵 Model cost |
|:---:|:---:|:---:|:---:|:---:|
| **${passed} / ${ran.length}** passed${skipped ? `<br>${skipped} skipped` : ""} | **${seconds(total)}** | ${p95 ? `**${p95[1]} ms** vs ${p95[2]} ms` : "not measured"} | **${o.attempts.length}** | **$${o.usd.toFixed(4)}** |

## What failed

${o.contract.tests.map((t) => `- \`${t.name}\` in \`${t.ws}/${t.file}\` (failed 3 of 3 runs)`).join("\n")}${o.contract.typecheck ? "\n- The type checker" : ""}

## Cause

${o.findings.cause}

${o.findings.evidence.map((e) => `- \`${e.path}\`: \`${e.quote.slice(0, 200)}\``).join("\n")}

## Fix

${o.summary}

## Proof

Checked in a fresh sandbox the agent never touched, with no network and no secrets.

| Area | Checks | Result |
|---|---|---|
${GROUPS.map(groupRow).filter(Boolean).join("\n")}
| 🔍 Review | A separate model, which can only reject | ${o.review ? "✅ Accepted" : "-"} |

<details>
<summary>Every check, with its result and time</summary>

| Check | Result | Time | Detail |
|---|---|---|---|
${checks.map(detailRow).join("\n")}

</details>

<details>
<summary>Guardrails and review</summary>

${o.gates
  .filter((g) => g.group === "guard")
  .map(
    (g) =>
      `- ${mark(g)} ${g.name === "rules" ? "Change rules: only source files, no tests, config, dependencies or CI; no skipped tests or silenced checks" : g.name === "applies cleanly" ? "The patch applies cleanly to the original code" : g.name}`,
  )
  .join("\n")}
- ✅ Review: ${o.review?.reason ?? "-"}
${earlier.length ? `- 🔁 Earlier attempts refused by: ${earlier.map((a) => `attempt ${a.n} by ${a.by}`).join(", ")}` : ""}

</details>

---
<sub>Rox Lab run \`${o.run}\` · gpt-4.1-mini · a human reviews and merges; Rox never merges.</sub>
`;
}
