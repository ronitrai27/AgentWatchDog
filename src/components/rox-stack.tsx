const INK = "#2b3a30";
const GREEN = "#2f7d4f";

// Isometric plane transform: text lies on the top face of a slab.
const FACE = "matrix(0.958 0.287 -0.958 0.287 0 0)";

const LAYERS = [
  {
    title: "Signal",
    sub: "Verified, deduped alerts",
    caption: "ingest · Sentry webhook verified, fingerprint a41c",
    guard: false,
  },
  {
    title: "Reproduce",
    sub: "Air-gapped, zero secrets",
    caption: "reproduce · test fails before the patch, same stack ✓",
    guard: false,
  },
  {
    title: "Guardrails",
    sub: "Budgets, paths, kill switch",
    caption: "guardrails · injected “push to main” denied, no such tool",
    guard: true,
  },
  {
    title: "Verify",
    sub: "Tests, k6, SAST, DAST",
    caption: "verify · mutation 94% · p95 +2 ms · 0 new findings",
    guard: false,
  },
  {
    title: "Publish",
    sub: "Draft PR, Linear, Slack",
    caption: "publish · draft PR opened, waiting for you to merge",
    guard: false,
  },
] as const;

const TOP_Y = 160;
const STEP = 94;

function Slab({ title, sub }: { title: string; sub: string }) {
  return (
    <>
      <path
        d="M-150 0L0 45V71L-150 26Z"
        fill="#e3e8de"
        stroke={INK}
        strokeOpacity="0.3"
      />
      <path
        d="M150 0L0 45V71L150 26Z"
        fill="#d1d8cb"
        stroke={INK}
        strokeOpacity="0.3"
      />
      <path
        className="stack-slab"
        d="M0 -45L150 0L0 45L-150 0Z"
        fill="#fbfbf8"
        stroke={INK}
        strokeOpacity="0.38"
        strokeWidth="1.2"
      />
      <g transform={FACE}>
        <text
          y="-4"
          textAnchor="middle"
          fontSize="16"
          fontWeight="700"
          fill={INK}
          style={{ fontFamily: "var(--sans)" }}
        >
          {title}
        </text>
        <text
          y="13"
          textAnchor="middle"
          fontSize="10.5"
          fill="#4a5a4f"
          style={{ fontFamily: "var(--sans)" }}
        >
          {sub}
        </text>
      </g>
    </>
  );
}

export function RoxStack() {
  const order = LAYERS.map((layer, i) => ({ layer, i })).reverse();

  return (
    <div className="w-full max-w-[400px]">
      <svg
        viewBox="0 0 520 650"
        role="img"
        aria-label="Rox pipeline: signal, reproduce, guardrails, verify, publish"
        className="h-auto w-full overflow-visible"
      >
        <ellipse cx="260" cy="628" rx="200" ry="16" fill={INK} opacity="0.08" />

        {/* Beam through the stack */}
        <path
          d="M260 90V620"
          stroke={GREEN}
          strokeOpacity="0.45"
          strokeDasharray="3 6"
        />

        {/* Layers, lowest first so upper rims overlap lower faces */}
        {order.map(({ layer, i }) => (
          <g
            key={layer.title}
            transform={`translate(260 ${TOP_Y + i * STEP})`}
            style={{ "--i": i } as React.CSSProperties}
          >
            {layer.guard ? (
              <>
                <path
                  className="stack-guard"
                  d="M0 -45L150 0L0 45L-150 0Z"
                  fill={GREEN}
                  fillOpacity="0.06"
                  stroke={GREEN}
                  strokeWidth="1.6"
                  strokeDasharray="7 5"
                />
                <g transform={FACE}>
                  <text
                    y="-4"
                    textAnchor="middle"
                    fontSize="16"
                    fontWeight="700"
                    fill={GREEN}
                    style={{ fontFamily: "var(--sans)" }}
                  >
                    {layer.title}
                  </text>
                  <text
                    y="13"
                    textAnchor="middle"
                    fontSize="10.5"
                    fill="#3d6b50"
                    style={{ fontFamily: "var(--sans)" }}
                  >
                    {layer.sub}
                  </text>
                </g>
              </>
            ) : (
              <Slab title={layer.title} sub={layer.sub} />
            )}
          </g>
        ))}

        {/* Rox cube */}
        <g transform="translate(260 50)">
          <g className="stack-cube">
            <ellipse
              cx="0"
              cy="48"
              rx="54"
              ry="13"
              fill={GREEN}
              opacity="0.12"
            />
            <path
              d="M-46 0L0 14V62L-46 48Z"
              fill="#cfe9da"
              stroke={INK}
              strokeOpacity="0.35"
            />
            <path
              d="M46 0L0 14V62L46 48Z"
              fill="#b6dbc5"
              stroke={INK}
              strokeOpacity="0.35"
            />
            <path
              d="M0 -14L46 0L0 14L-46 0Z"
              fill="#e6f5ec"
              stroke={GREEN}
              strokeWidth="1.4"
            />
            <g transform={FACE}>
              <text
                y="5"
                textAnchor="middle"
                fontSize="16"
                fontWeight="800"
                fill={GREEN}
                style={{ fontFamily: "var(--sans)", letterSpacing: "0.08em" }}
              >
                ROX
              </text>
            </g>
          </g>
        </g>
      </svg>

      {/* What Rox is doing right now, in step with the highlighted layer */}
      <div
        className="relative mt-2 h-10 text-center font-mono text-[11px] text-ink-soft"
        aria-live="off"
      >
        {LAYERS.map((layer, i) => (
          <p
            key={layer.title}
            className="stack-caption absolute inset-0"
            style={{ "--i": i } as React.CSSProperties}
          >
            {layer.caption}
          </p>
        ))}
      </div>
    </div>
  );
}
