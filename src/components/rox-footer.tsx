import { ViaductScene } from "./viaduct-scene";

const NAV = [
  { label: "Product", href: "#product" },
  { label: "Guardrails", href: "#" },
  { label: "Integrations", href: "#integrations" },
  { label: "Audit trail", href: "#" },
  { label: "Trap pack", href: "#" },
  { label: "Docs", href: "#" },
  { label: "Judge mode", href: "/auth" },
  { label: "GitHub", href: "#" },
];

export function RoxFooter() {
  return (
    <footer className="footer" id="contact">
      <ViaductScene />

      <div className="footer__content">
        <svg
          className="footer__mark"
          viewBox="0 0 64 64"
          role="img"
          aria-label="Rox compass"
        >
          <circle
            cx="32"
            cy="32"
            r="30"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
          />
          <circle
            cx="32"
            cy="32"
            r="25.5"
            fill="none"
            stroke="currentColor"
            strokeWidth=".8"
            opacity=".5"
          />
          <g fill="currentColor" opacity=".85">
            <path d="M32 32 L46 18 L35.2 34.4 Z" />
            <path d="M32 32 L46 46 L29.6 35.2 Z" />
            <path d="M32 32 L18 46 L28.8 29.6 Z" />
            <path d="M32 32 L18 18 L34.4 28.8 Z" />
          </g>
          <g stroke="currentColor" strokeWidth="1" strokeLinejoin="round">
            <path d="M32 8 L35.5 28.5 L32 32 Z" fill="currentColor" />
            <path d="M32 8 L28.5 28.5 L32 32 Z" fill="none" />
            <path d="M56 32 L35.5 35.5 L32 32 Z" fill="currentColor" />
            <path d="M56 32 L35.5 28.5 L32 32 Z" fill="none" />
            <path d="M32 56 L28.5 35.5 L32 32 Z" fill="currentColor" />
            <path d="M32 56 L35.5 35.5 L32 32 Z" fill="none" />
            <path d="M8 32 L28.5 28.5 L32 32 Z" fill="currentColor" />
            <path d="M8 32 L28.5 35.5 L32 32 Z" fill="none" />
          </g>
          <circle
            cx="32"
            cy="32"
            r="1.8"
            fill="var(--paper)"
            stroke="currentColor"
            strokeWidth="1"
          />
        </svg>

        <p className="footer__brand">
          <a href="/web" aria-label="Rox home">
            rox
          </a>
        </p>

        <p className="footer__tagline">
          Built to run overnight. Reproduces real failures, audits every change,
          and closes the loop across your stack.
        </p>

        <nav className="footer__nav" aria-label="Footer">
          <ul>
            {NAV.map((item) => (
              <li key={item.label}>
                <a href={item.href}>{item.label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <p className="footer__copy">
          © <span suppressHydrationWarning>{new Date().getFullYear()}</span> Rox
        </p>
      </div>
    </footer>
  );
}
