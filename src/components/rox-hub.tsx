import type { CSSProperties, ReactNode } from "react";

const INK = "#2b3a30";
const GREEN = "#2f7d4f";

// Maps flat text and icons onto an isometric top face.
const FACE_SLAB = "matrix(0.958 0.287 -0.958 0.287 0 0)"; // slope 0.3
const FACE_BLOCK = "matrix(0.894 0.447 -0.894 0.447 0 0)"; // slope 0.5

const TOWER = [
  { title: "Investigate", sub: "read-only tools" },
  { title: "Reproduce", sub: "air-gapped sandbox" },
  { title: "Fix", sub: "inside path policy" },
  { title: "Verify", sub: "tests, k6, scans" },
];

const TOWER_X = 320;
const TOWER_TOP = 120;
const TOWER_STEP = 62;

function Slab({ i, title, sub }: { i: number; title: string; sub: string }) {
  return (
    <g
      transform={`translate(${TOWER_X} ${TOWER_TOP + i * TOWER_STEP})`}
      style={{ "--i": i } as CSSProperties}
    >
      <path
        d="M-100 0L0 30V46L-100 16Z"
        fill="#e3e9de"
        stroke={INK}
        strokeOpacity="0.3"
      />
      <path
        d="M100 0L0 30V46L100 16Z"
        fill="#d2dacb"
        stroke={INK}
        strokeOpacity="0.3"
      />
      <path
        className="hub-slab"
        d="M0 -30L100 0L0 30L-100 0Z"
        fill="#ffffff"
        stroke={INK}
        strokeOpacity="0.4"
        strokeWidth="1.2"
      />
      <g transform={FACE_SLAB}>
        <text
          y="2"
          textAnchor="middle"
          fontSize="13"
          fontWeight="700"
          fill={INK}
          style={{ fontFamily: "var(--sans)" }}
        >
          {title}
        </text>
        <text
          y="14"
          textAnchor="middle"
          fontSize="9"
          fill="#4a5a4f"
          style={{ fontFamily: "var(--sans)" }}
        >
          {sub}
        </text>
      </g>
    </g>
  );
}

type SatelliteProps = {
  x: number;
  y: number;
  i: number;
  title: string;
  sub: string;
  icon: ReactNode;
};

function Satellite({ x, y, i, title, sub, icon }: SatelliteProps) {
  return (
    <g transform={`translate(${x} ${y})`} style={{ "--i": i } as CSSProperties}>
      <path
        d="M-46 0L0 23V43L-46 20Z"
        fill="#e3ede7"
        stroke={INK}
        strokeOpacity="0.3"
      />
      <path
        d="M46 0L0 23V43L46 20Z"
        fill="#cfe0d6"
        stroke={INK}
        strokeOpacity="0.3"
      />
      <path
        d="M0 -23L46 0L0 23L-46 0Z"
        fill="#ffffff"
        stroke={INK}
        strokeOpacity="0.45"
        strokeWidth="1.2"
      />
      <g transform={FACE_BLOCK}>
        <g
          fill="none"
          stroke={GREEN}
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {icon}
        </g>
      </g>
      <text
        y="66"
        textAnchor="middle"
        fontSize="13"
        fontWeight="700"
        fill={INK}
        style={{ fontFamily: "var(--sans)" }}
      >
        {title}
      </text>
      <text
        y="81"
        textAnchor="middle"
        fontSize="10.5"
        fill="#5a6a5f"
        style={{ fontFamily: "var(--sans)" }}
      >
        {sub}
      </text>
    </g>
  );
}

const ICONS = {
  shield: (
    <>
      <path d="M0 -11L9 -7V1C9 7 4 10 0 12C-4 10 -9 7 -9 1V-7Z" />
      <path d="M-4 1L-1 4L5 -3" />
    </>
  ),
  gauge: (
    <>
      <path d="M-10 5A10 10 0 0 1 10 5" />
      <path d="M0 5L6 -4" />
      <circle cx="0" cy="5" r="1.6" fill={GREEN} />
    </>
  ),
  plan: (
    <>
      <path d="M-8 -10H8V10H-8Z" />
      <path d="M-4 -4H4M-4 0H4" />
      <path d="M-4 5L-2 7L3 3" />
    </>
  ),
  alert: (
    <>
      <path d="M0 -10L10 8H-10Z" />
      <path d="M0 -3V2" />
      <circle cx="0" cy="5" r="0.8" fill={GREEN} />
    </>
  ),
  plug: (
    <>
      <path d="M-9 -9H-2V-2H-9ZM2 -9H9V-2H2ZM-9 2H-2V9H-9ZM2 2H9V9H2Z" />
    </>
  ),
};

export function RoxHub() {
  return (
    <svg
      viewBox="0 0 640 590"
      role="img"
      aria-label="Rox investigates, reproduces, fixes and verifies, with security scans, k6 performance tests, remedial plans, escalation and integrations around it"
      className="h-auto w-full max-w-[600px] overflow-visible"
    >
      <defs>
        <pattern
          id="isogrid"
          width="80"
          height="40"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M0 0L80 40M0 40L80 0"
            stroke="#dbe5dd"
            strokeWidth="1"
            fill="none"
          />
        </pattern>
        <radialGradient id="gridfade" cx="50%" cy="48%" r="55%">
          <stop offset="0.35" stopColor="#fff" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <mask id="gridmask">
          <rect width="640" height="590" fill="url(#gridfade)" />
        </mask>
      </defs>

      <rect
        width="640"
        height="590"
        fill="url(#isogrid)"
        mask="url(#gridmask)"
      />

      {/* Connections, with a signal moving along each */}
      {[
        "M166 110H188L198 120H220",
        "M474 110H452L442 120H420",
        "M166 330H188L212 306H220",
        "M474 330H452L428 306H420",
        "M320 467V437",
      ].map((d) => (
        <g key={d} fill="none" strokeLinejoin="round" strokeLinecap="round">
          <path d={d} stroke="#cfe0d5" strokeWidth="2" />
          <path className="hub-flow" d={d} stroke={GREEN} strokeWidth="2" />
        </g>
      ))}

      {/* Base plate */}
      <g transform="translate(320 384)">
        <path
          d="M-130 0L0 39V53L-130 14Z"
          fill="#dfe6da"
          stroke={INK}
          strokeOpacity="0.3"
        />
        <path
          d="M130 0L0 39V53L130 14Z"
          fill="#cdd6c7"
          stroke={INK}
          strokeOpacity="0.3"
        />
        <path
          d="M0 -39L130 0L0 39L-130 0Z"
          fill="#f4f7f2"
          stroke={INK}
          strokeOpacity="0.4"
          strokeWidth="1.2"
        />
        <g transform={FACE_SLAB}>
          <text
            y="8"
            textAnchor="middle"
            fontSize="17"
            fontWeight="800"
            fill={GREEN}
            style={{ fontFamily: "var(--sans)", letterSpacing: "0.18em" }}
          >
            ROX
          </text>
        </g>
      </g>

      {/* Tower, lowest first so upper slabs overlap lower ones */}
      {TOWER.map((layer, i) => ({ layer, i }))
        .reverse()
        .map(({ layer, i }) => (
          <Slab key={layer.title} i={i} title={layer.title} sub={layer.sub} />
        ))}

      <Satellite
        x={120}
        y={110}
        i={0}
        title="Security scans"
        sub="SAST, secrets, deps, DAST"
        icon={ICONS.shield}
      />
      <Satellite
        x={520}
        y={110}
        i={1}
        title="Remedial plans"
        sub="Fix, prove, open the PR"
        icon={ICONS.plan}
      />
      <Satellite
        x={120}
        y={330}
        i={2}
        title="k6 performance"
        sub="p95 before and after"
        icon={ICONS.gauge}
      />
      <Satellite
        x={520}
        y={330}
        i={3}
        title="Escalation"
        sub="Stops and hands over to you"
        icon={ICONS.alert}
      />
      <Satellite
        x={320}
        y={490}
        i={4}
        title="Integrations"
        sub="GitHub, Sentry, Linear, Slack"
        icon={ICONS.plug}
      />
    </svg>
  );
}
