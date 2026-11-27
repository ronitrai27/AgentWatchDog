// The only way out of a sandbox, and only for installing dependencies. A tiny HTTPS proxy:
// it opens a tunnel (CONNECT) to an allowed registry on port 443 and refuses everything else.
// Every decision is printed as one JSON line, so the trace shows what was allowed and denied.
import { createServer } from "node:http";
import { connect } from "node:net";

const ALLOWED = new Set(
  (process.env.EGRESS_ALLOW ?? "registry.npmjs.org")
    .split(",")
    .map((h) => h.trim().toLowerCase()),
);
const PORT = Number(process.env.EGRESS_PORT ?? 3128);
const log = (entry) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

const server = createServer((req, res) => {
  // Plain HTTP is never allowed: nothing can be sent unencrypted or to an unchecked host.
  log({
    verdict: "DENY",
    method: req.method,
    target: req.url,
    why: "plain HTTP is not allowed",
  });
  res.writeHead(403).end("Rox egress: plain HTTP is not allowed\n");
});

server.on("connect", (req, client, head) => {
  const [host = "", port = ""] = String(req.url).toLowerCase().split(":");
  if (!ALLOWED.has(host) || port !== "443") {
    log({
      verdict: "DENY",
      method: "CONNECT",
      target: req.url,
      why: "host not allowed",
    });
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  log({ verdict: "ALLOW", method: "CONNECT", target: req.url });
  const upstream = connect(443, host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    client.destroy();
  };
  upstream.on("error", close);
  client.on("error", close);
});

server.listen(PORT, "0.0.0.0", () =>
  log({ ready: true, port: PORT, allowed: [...ALLOWED] }),
);
