"use client";

import { motion } from "motion/react";

// Small drawings for the Home boxes, drawn on 136 x 112 and shown at half size. The first three are drawn from real values.

const EASE = [0.2, 0.8, 0.2, 1] as const;

function Tile({ tint, children }: { tint: string; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 136 112"
      className="h-14 w-[68px] shrink-0 rounded-lg"
      style={{ background: tint }}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Columns of dots, one column per day. */
export function CommitsVector({ perDay }: { perDay: number[] }) {
  const max = Math.max(1, ...perDay);
  return (
    <Tile tint="#e4e0f7">
      {perDay.map((count, day) => {
        const lit =
          count === 0 ? 0 : Math.max(1, Math.round((count / max) * 8));
        return Array.from({ length: 8 }, (_, row) => (
          <motion.circle
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid
            key={`${day}-${row}`}
            cx={14 + day * 8.3}
            cy={92 - row * 9.6}
            r="2.9"
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: row < lit ? 1 : 0.16, scale: 1 }}
            fill="#6d5bd0"
            transition={{
              duration: 0.35,
              delay: 0.15 + day * 0.025 + row * 0.03,
              ease: EASE,
            }}
          />
        ));
      })}
    </Tile>
  );
}

/** A half ring, one segment per basic. */
export function SecurityVector({ oks }: { oks: boolean[] }) {
  const count = oks.length;
  const gap = 0.07;
  const span = Math.PI / count;
  const point = (angle: number) =>
    `${68 - Math.cos(angle) * 44} ${82 - Math.sin(angle) * 44}`;
  return (
    <Tile tint="#dcefe3">
      {oks.map((ok, i) => (
        <motion.path
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
          key={i}
          d={`M${point(i * span + gap)} A44 44 0 0 1 ${point((i + 1) * span - gap)}`}
          fill="none"
          stroke={ok ? "#2f7d4f" : "#fff"}
          strokeWidth="11"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.4, delay: 0.2 + i * 0.12, ease: EASE }}
        />
      ))}
      <motion.text
        x="68"
        y="80"
        textAnchor="middle"
        fontSize="26"
        fontWeight="600"
        className="fill-ink"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.6 }}
      >
        {oks.filter(Boolean).length}/{count}
      </motion.text>
    </Tile>
  );
}

const PULL_COLORS = { open: "#e08a1e", merged: "#2f7d4f", closed: "#b9a98d" };

/** One bar each for open, merged and closed. */
export function PullsVector(props: {
  open: number;
  merged: number;
  closed: number;
}) {
  const max = Math.max(1, props.open, props.merged, props.closed);
  return (
    <Tile tint="#fbeed7">
      {(["open", "merged", "closed"] as const).map((key, i) => {
        const height = props[key] === 0 ? 4 : 10 + (props[key] / max) * 52;
        const x = 22 + i * 34;
        return (
          <g key={key}>
            <motion.rect
              x={x}
              width="24"
              rx="5"
              fill={PULL_COLORS[key]}
              initial={{ height: 0, y: 92 }}
              animate={{ height, y: 92 - height }}
              transition={{ duration: 0.6, delay: 0.2 + i * 0.1, ease: EASE }}
            />
          </g>
        );
      })}
    </Tile>
  );
}

/** Demo: an error line. */
export function ErrorsVector() {
  return (
    <Tile tint="#f8dfdc">
      <motion.path
        d="M14 78 L30 66 L44 72 L60 44 L74 58 L90 30 L106 50 L122 40"
        fill="none"
        stroke="#b4443a"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.1, delay: 0.3, ease: "easeInOut" }}
      />
      <motion.circle
        cx="122"
        cy="40"
        r="5"
        fill="#b4443a"
        initial={{ scale: 0 }}
        animate={{ scale: [1, 1.35, 1] }}
        transition={{ duration: 1.8, delay: 1.3, repeat: Infinity }}
      />
    </Tile>
  );
}

const DEPLOYS = [34, 52, 28, 60, 44, 66, 50];

/** Demo: deploys as thin pills. */
export function DeploysVector() {
  return (
    <Tile tint="#d9eaf7">
      {DEPLOYS.map((height, i) => (
        <g key={height}>
          <rect
            x={17 + i * 15}
            y="22"
            width="7"
            height="70"
            rx="3.5"
            fill="#fff"
          />
          <motion.rect
            x={17 + i * 15}
            width="7"
            rx="3.5"
            fill="#2b7fc4"
            initial={{ height: 0, y: 92 }}
            animate={{ height, y: 92 - height }}
            transition={{ duration: 0.6, delay: 0.3 + i * 0.06, ease: EASE }}
          />
        </g>
      ))}
    </Tile>
  );
}

/** Demo: messages arriving in a thread. */
export function AlertsVector() {
  return (
    <Tile tint="#e4e8de">
      {[0, 1, 2].map((i) => (
        <motion.g
          key={i}
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, delay: 0.35 + i * 0.15, ease: EASE }}
        >
          <rect
            x="24"
            y={18 + i * 27}
            width="126"
            height="22"
            rx="7"
            fill="#fff"
            opacity={1 - i * 0.28}
          />
          <circle
            cx="36"
            cy={29 + i * 27}
            r="4.5"
            fill={["#2f7d4f", "#e08a1e", "#8a948d"][i]}
          />
          <rect
            x="47"
            y={26.5 + i * 27}
            width={62 - i * 12}
            height="5"
            rx="2.5"
            fill="rgb(43 58 48 / 0.18)"
          />
        </motion.g>
      ))}
    </Tile>
  );
}

/** Nothing to draw. Pulses while it is loading. */
export function IdleVector({ busy }: { busy: boolean }) {
  return (
    <Tile tint="#e3e7df">
      <motion.path
        d="M14 60 H46 L56 40 L70 76 L82 52 L88 60 H122"
        fill="none"
        stroke="rgb(43 58 48 / 0.3)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        animate={busy ? { opacity: [0.25, 1, 0.25] } : { opacity: 0.7 }}
        transition={busy ? { duration: 1.6, repeat: Infinity } : {}}
      />
    </Tile>
  );
}
