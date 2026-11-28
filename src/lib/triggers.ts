// Every trigger Rox can listen to, by app. The one list: Settings > Workflow shows it, the chat
// agent reads it to say what each checked trigger does, and runs record a trigger by its id.

export type TriggerItem = {
  id: string;
  label: string;
  detail: string;
  defaultEnabled?: boolean;
};

export type TriggerProvider = {
  id: string;
  name: string;
  src: string;
  dark?: boolean;
  fill?: boolean;
  triggers: TriggerItem[];
};

export const TRIGGER_PROVIDERS: TriggerProvider[] = [
  {
    id: "github",
    name: "GitHub",
    src: "/github-dark.svg",
    dark: true,
    triggers: [
      {
        id: "github:failed_ci",
        label: "Failed GitHub Actions CI",
        detail: "Investigates failing workflow checks",
        defaultEnabled: true,
      },
      {
        id: "github:pr_main",
        label: "PR opened against main",
        detail: "Verifies pull requests targeting main",
        defaultEnabled: true,
      },
      {
        id: "github:security_alert",
        label: "GitHub security alert",
        detail: "Triages Dependabot and code scanning alerts",
      },
    ],
  },
  {
    id: "sentry",
    name: "Sentry",
    src: "/sentry.svg",
    dark: true,
    triggers: [
      {
        id: "sentry:new_issue",
        label: "New issue detected",
        detail: "Investigates newly seen production exceptions",
      },
      {
        id: "sentry:error_spike",
        label: "Error spike detected",
        detail: "Responds to sudden exception volume surges",
      },
      {
        id: "sentry:regression",
        label: "Regression detected",
        detail: "Re-investigates previously resolved issues",
      },
    ],
  },
  {
    id: "vercel",
    name: "Vercel",
    src: "/vercel.png",
    dark: true,
    triggers: [
      {
        id: "vercel:deploy_failed",
        label: "Deployment failed",
        detail: "Diagnoses build or runtime deploy failures",
      },
      {
        id: "vercel:new_prod_deploy",
        label: "New production deployment",
        detail: "Runs post-deploy smoke checks",
      },
    ],
  },
  {
    id: "betterstack",
    name: "Better Stack",
    src: "/beter-stack.svg",
    fill: true,
    triggers: [
      {
        id: "betterstack:error_spike",
        label: "Error spike",
        detail: "Investigates abnormal log error bursts",
      },
      {
        id: "betterstack:error_threshold",
        label: "New error threshold reached",
        detail: "Wakes Rox when an error budget threshold trips",
      },
      {
        id: "betterstack:error_reoccurred",
        label: "Previously resolved error reoccurred",
        detail: "Checks why a closed error came back",
      },
      {
        id: "betterstack:monitor_incident",
        label: "Monitor incident started",
        detail: "Investigates service downtime",
      },
    ],
  },
  {
    id: "grafana",
    name: "Grafana",
    src: "/grafana.svg",
    triggers: [
      {
        id: "grafana:high_cpu_mem",
        label: "High CPU / memory usage",
        detail: "Profiles resource exhaustion and leaks",
      },
      {
        id: "grafana:high_latency",
        label: "High API latency",
        detail: "Investigates p95/p99 endpoint slowdowns",
      },
      {
        id: "grafana:service_unavailable",
        label: "Service unavailable",
        detail: "Responds to 5xx and health check outages",
      },
      {
        id: "grafana:db_saturation",
        label: "Database saturation",
        detail: "Checks slow queries and connection exhaustion",
      },
      {
        id: "grafana:alert_recovered",
        label: "Alert recovered",
        detail: "Verifies recovery and appends closure notes",
      },
    ],
  },
];

/** A trigger by its id, with the app it belongs to. */
export function findTrigger(id: string) {
  for (const provider of TRIGGER_PROVIDERS) {
    const item = provider.triggers.find((t) => t.id === id);
    if (item) return { provider, item };
  }
  return null;
}
