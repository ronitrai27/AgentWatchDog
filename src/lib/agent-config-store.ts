// Reads and saves Agent Config, as the web role.
import {
  type AgentConfig,
  CONFIG_COLUMNS,
  type ConfigRow,
  RUNS_TODAY_SQL,
  TODAY_SQL,
  type TodayRow,
  toConfig,
} from "./agent-config";
import { withUser } from "./db";
import { costUsd } from "./models";

export async function getAgentConfig(
  userId: string,
): Promise<{ config: AgentConfig; spentTodayUsd: number }> {
  return withUser(userId, async (c) => {
    const config = await c.query<ConfigRow>(
      `SELECT ${CONFIG_COLUMNS} FROM agent_config WHERE user_id = $1`,
      [userId],
    );
    const today = await c.query<TodayRow>(TODAY_SQL);
    // Chat turns and pipeline runs share the one day budget.
    const runs = await c.query<{ usd: string }>(RUNS_TODAY_SQL, [userId]);
    return {
      config: toConfig(config.rows[0]),
      spentTodayUsd:
        Number(runs.rows[0]?.usd ?? 0) +
        today.rows.reduce(
          (sum, r) => sum + costUsd(r.model, Number(r.input), Number(r.output)),
          0,
        ),
    };
  });
}

export async function writeAgentConfig(userId: string, c: AgentConfig) {
  await withUser(userId, (client) =>
    client.query(
      `INSERT INTO agent_config (user_id, ${CONFIG_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE
         SET day_budget_usd = EXCLUDED.day_budget_usd,
             max_minutes = EXCLUDED.max_minutes,
             tone = EXCLUDED.tone,
             instructions = EXCLUDED.instructions,
             report_schedule = EXCLUDED.report_schedule,
             pr_action = EXCLUDED.pr_action,
             updated_at = now()`,
      [
        userId,
        c.dayBudgetUsd,
        c.maxMinutes,
        c.tone,
        c.instructions,
        c.schedule,
        c.prAction,
      ],
    ),
  );
}
