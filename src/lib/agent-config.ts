// What the user sets under Settings > Agent Config. Shared by the browser, the server and the agent.

export const TONES = [
  {
    id: "strict",
    label: "Strict senior engineer",
    prompt:
      "Talk like a strict senior engineer: direct, demanding and exact. Point out weak work plainly and say what would be acceptable.",
  },
  {
    id: "friendly",
    label: "Polite and friendly",
    prompt: "Be polite, warm and patient. Stay honest about problems.",
  },
  {
    id: "savage",
    label: "Savage",
    prompt:
      "Be savage and funny: roast bad code, missing tests and risky setups without mercy. Roast the work, never the person, and no slurs. The facts must stay exact, and drop the jokes when there is an active incident or a security problem.",
  },
] as const;

export type Tone = (typeof TONES)[number]["id"];

export const SCHEDULES = [
  { id: "off", label: "Off" },
  { id: "daily", label: "Every day" },
  { id: "every_3_days", label: "Every 3 days" },
  { id: "weekly", label: "Every week" },
] as const;

export type Schedule = (typeof SCHEDULES)[number]["id"];

export type AgentConfig = {
  /** The most all runs of one day (UTC) may cost together, in US dollars. */
  dayBudgetUsd: number;
  maxMinutes: number;
  tone: Tone;
  instructions: string;
  schedule: Schedule;
};

export const DEFAULT_CONFIG: AgentConfig = {
  dayBudgetUsd: 5,
  maxMinutes: 5,
  tone: "strict",
  instructions: "",
  schedule: "off",
};

export const MAX_INSTRUCTIONS = 2000;

export type ConfigRow = {
  day_budget_usd: string;
  max_minutes: number;
  tone: Tone;
  instructions: string;
  report_schedule: Schedule;
};

export const CONFIG_COLUMNS =
  "day_budget_usd, max_minutes, tone, instructions, report_schedule";

export const toConfig = (row: ConfigRow | undefined): AgentConfig =>
  row
    ? {
        dayBudgetUsd: Number(row.day_budget_usd),
        maxMinutes: row.max_minutes,
        tone: row.tone,
        instructions: row.instructions,
        schedule: row.report_schedule,
      }
    : DEFAULT_CONFIG;

/** Tokens used since midnight UTC, per model. Row-level security limits it to one user. */
export const TODAY_SQL = `SELECT model, coalesce(sum(input_tokens), 0) AS input, coalesce(sum(output_tokens), 0) AS output
  FROM session_turns
 WHERE started_at >= date_trunc('day', now(), 'UTC') AND model IS NOT NULL
 GROUP BY model`;

export type TodayRow = { model: string; input: string; output: string };

/** The first problem with a config the browser sent, in plain words, or null. */
export function configProblem(c: AgentConfig): string | null {
  const between = (n: number, min: number, max: number) =>
    Number.isFinite(n) && n >= min && n <= max;
  if (!between(c.dayBudgetUsd, 0.05, 500))
    return "The budget per day must be between $0.05 and $500.";
  if (!Number.isInteger(c.maxMinutes) || !between(c.maxMinutes, 1, 120))
    return "The time limit must be a whole number from 1 to 120 minutes.";
  if (!TONES.some((t) => t.id === c.tone)) return "Choose a tone.";
  if (!SCHEDULES.some((s) => s.id === c.schedule)) return "Choose a schedule.";
  if (
    typeof c.instructions !== "string" ||
    c.instructions.length > MAX_INSTRUCTIONS
  )
    return `Instructions can be up to ${MAX_INSTRUCTIONS} characters.`;
  return null;
}
