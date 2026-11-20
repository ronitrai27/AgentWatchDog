const INK = "#2b3a30";
const PAPER = "#ebeee7";

const ARCH_CENTERS = [100, 300, 500, 700, 900, 1100, 1300, 1500];
const POSTS = Array.from({ length: 24 }, (_, i) => 20 + i * 68);

function Wheel({ cx, r }: { cx: number; r: number }) {
  return (
    <g className="wheel">
      <circle
        cx={cx}
        cy={-r}
        r={r}
        fill={PAPER}
        stroke={INK}
        strokeWidth="1.8"
      />
      <path
        d={`M${cx - r + 2} ${-r}H${cx + r - 2}M${cx} ${-2 * r + 2}V-2`}
        stroke={INK}
        strokeWidth="1.2"
      />
      <circle cx={cx} cy={-r} r="1.6" fill={INK} />
    </g>
  );
}

function Carriage({ x }: { x: number }) {
  return (
    <g>
      <rect
        x={x}
        y={-38}
        width="110"
        height="28"
        rx="3"
        fill={PAPER}
        stroke={INK}
        strokeWidth="1.8"
      />
      {[0, 1, 2, 3].map((n) => (
        <rect
          key={n}
          x={x + 10 + n * 24}
          y={-32}
          width="14"
          height="11"
          fill={INK}
          opacity="0.8"
        />
      ))}
      <path d={`M${x} -14H${x + 110}`} stroke={INK} strokeWidth="1" />
      <Wheel cx={x + 20} r={7} />
      <Wheel cx={x + 90} r={7} />
    </g>
  );
}

export function ViaductScene() {
  return (
    <svg
      className="footer__scene"
      viewBox="0 0 1600 600"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <pattern
          id="brick"
          width="28"
          height="14"
          patternUnits="userSpaceOnUse"
        >
          <rect width="28" height="14" fill={PAPER} />
          <path
            d="M0 0.5H28M0 7.5H28M0.5 0V7M14.5 7.5V14"
            stroke={INK}
            strokeWidth="0.9"
            opacity="0.45"
            fill="none"
          />
        </pattern>
        <linearGradient id="void" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={PAPER} />
          <stop offset="1" stopColor={INK} stopOpacity="0.22" />
        </linearGradient>
      </defs>

      {/* Night sky: moon and stars */}
      <path
        d="M1300 64a30 30 0 1 0 24 50a24 24 0 1 1 -24 -50z"
        fill={INK}
        opacity="0.85"
      />
      {[
        [1180, 120],
        [1410, 70],
        [1470, 170],
        [1120, 60],
        [1360, 190],
      ].map(([x, y], i) => (
        <path
          key={`${x}-${y}`}
          className="twinkle"
          style={{ animationDelay: `${i * 0.7}s` }}
          d={`M${x} ${y - 6}V${y + 6}M${x - 6} ${y}H${x + 6}`}
          stroke={INK}
          strokeWidth="1.4"
        />
      ))}

      {/* Parapet */}
      <path d="M0 372H1600" stroke={INK} strokeWidth="2.4" />
      <path d="M0 384H1600" stroke={INK} strokeWidth="1.2" />
      {POSTS.map((x) => (
        <rect key={x} x={x} y={372} width="7" height="24" fill={INK} />
      ))}

      {/* Deck and body */}
      <rect
        x="0"
        y="396"
        width="1600"
        height="32"
        fill="url(#brick)"
        stroke={INK}
        strokeWidth="2"
      />
      <rect x="0" y="428" width="1600" height="180" fill="url(#brick)" />

      {/* Arches */}
      {ARCH_CENTERS.map((cx) => (
        <g key={cx}>
          <path
            d={`M${cx - 70} 610V500A70 70 0 0 1 ${cx + 70} 500V610Z`}
            fill="url(#void)"
            stroke={INK}
            strokeWidth="3"
          />
          <path
            d={`M${cx - 78} 500A78 78 0 0 1 ${cx + 78} 500`}
            fill="none"
            stroke={INK}
            strokeWidth="11"
            strokeDasharray="7 3"
            opacity="0.85"
          />
          <path
            d={`M${cx - 86} 500A86 86 0 0 1 ${cx + 86} 500`}
            fill="none"
            stroke={INK}
            strokeWidth="1.6"
          />
        </g>
      ))}

      {/* Train, crossing left to right */}
      <g className="train">
        <g transform="translate(0 396)">
          <Carriage x={-290} />
          <Carriage x={-170} />
          <path d="M-60 -16H-40" stroke={INK} strokeWidth="2" />

          {/* Tender */}
          <rect
            x="-40"
            y="-32"
            width="52"
            height="26"
            rx="2"
            fill={PAPER}
            stroke={INK}
            strokeWidth="1.8"
          />
          <path d="M-36 -26H8M-36 -20H8" stroke={INK} strokeWidth="1" />
          <Wheel cx={-26} r={6} />
          <Wheel cx={-2} r={6} />

          {/* Cab */}
          <path
            d="M12 -6V-48H46V-6Z"
            fill={PAPER}
            stroke={INK}
            strokeWidth="1.8"
          />
          <path
            d="M8 -48H50"
            stroke={INK}
            strokeWidth="3"
            strokeLinecap="round"
          />
          <rect
            x="22"
            y="-40"
            width="14"
            height="14"
            fill={INK}
            opacity="0.8"
          />

          {/* Boiler */}
          <path
            d="M46 -34H112Q122 -34 122 -22V-8H46Z"
            fill={PAPER}
            stroke={INK}
            strokeWidth="1.8"
          />
          <path
            d="M62 -34V-8M86 -34V-8M104 -34V-8"
            stroke={INK}
            strokeWidth="1"
          />
          <path
            d="M70 -34Q70 -44 78 -44Q86 -44 86 -34"
            fill={PAPER}
            stroke={INK}
            strokeWidth="1.8"
          />
          <path
            d="M98 -34V-52H112V-34M94 -52H116"
            fill={PAPER}
            stroke={INK}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M122 -8L138 0H122Z"
            fill={INK}
            stroke={INK}
            strokeWidth="1.2"
          />
          <Wheel cx={62} r={12} />
          <Wheel cx={90} r={12} />
          <Wheel cx={112} r={6} />

          {/* Smoke, trailing behind the chimney */}
          {[0, 1, 2, 3].map((n) => (
            <circle
              key={n}
              className="puff"
              style={{ animationDelay: `${n * 0.8}s` }}
              cx="105"
              cy="-58"
              r="9"
              fill="none"
              stroke={INK}
              strokeWidth="1.4"
            />
          ))}
        </g>
      </g>
    </svg>
  );
}
