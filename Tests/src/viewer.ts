// A plain test page for watching runs live. The stream is server-sent events from the run's
// trace file, and it resumes from the last event the browser saw, so a refresh loses nothing.
//   pnpm --dir Tests viewer   ->   http://127.0.0.1:8790
import { readdir, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import "./env";
import { runsDir } from "./env";
import { readEvents } from "./events";

const PORT = Number(process.env.LAB_VIEWER_PORT ?? 8790);
const RUN = /^[0-9a-f-]{36}$/i;

const page = (
  title: string,
  body: string,
) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
:root{color-scheme:light dark;--bg:#f8f9f6;--fg:#1f2a22;--soft:#5b665e;--line:#d9ddd5;--pass:#2f7d4f;--fail:#b4443a;--warn:#a26b0a;--run:#2b6cb0;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#141815;--fg:#e8ece6;--soft:#9aa59c;--line:#2c332d;--card:#1b201c}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 4px}
.soft{color:var(--soft)}table{width:100%;border-collapse:collapse;margin-top:16px;background:var(--card)}
td,th{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;font-size:12px;color:var(--soft)}td.t{white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--soft)}
.s{font-weight:600}.pass{color:var(--pass)}.fail,.error{color:var(--fail)}.skipped,.cancelled{color:var(--warn)}.running{color:var(--run)}
a{color:inherit}code{font-size:12px}pre{white-space:pre-wrap;margin:4px 0 0;font-size:12px;color:var(--soft)}
</style></head><body><main>${body}</main></body></html>`;

function send(res: ServerResponse, status: number, type: string, body: string) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

async function listRuns() {
  const names = (await readdir(runsDir).catch(() => [])).filter((n) =>
    RUN.test(n),
  );
  const runs = await Promise.all(
    names.map(async (n) => {
      const first = (await readEvents(n))[0];
      return {
        n,
        at: (await stat(`${runsDir}/${n}`)).mtimeMs,
        title: first?.title ?? "",
      };
    }),
  );
  return runs.sort((a, b) => b.at - a.at);
}

const RUN_PAGE = (run: string) =>
  page(
    "Rox Lab run",
    `<p><a href="/">All runs</a></p><h1 id="title">Run</h1><p class="soft" id="state">Connecting…</p>
<table><thead><tr><th>Time</th><th>Step</th><th>Event</th><th>Status</th><th>Took</th></tr></thead><tbody id="rows"></tbody></table>
<script>
const rows=document.getElementById("rows"),state=document.getElementById("state");
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
let last=0;
function add(e){last=e.seq;if(e.kind==="run.started")document.getElementById("title").textContent=e.title;
 const d=e.data||{};const extra=d.summary?esc(d.summary):d.reason?esc(d.reason):"";
 const reports=(d.reports||[]).map(r=>'<code>'+esc(r)+'</code>').join(" ");
 const tr=document.createElement("tr");
 tr.innerHTML='<td class="t">'+new Date(e.at).toLocaleTimeString()+'</td><td>'+esc(e.step)+'</td><td>'+esc(e.title)
  +(e.attempt>1?' <span class="soft">(attempt '+e.attempt+')</span>':'')+(extra?'<pre>'+extra+'</pre>':'')+(reports?'<pre>'+reports+'</pre>':'')
  +'</td><td class="s '+esc(e.status)+'">'+esc(e.status||"")+'</td><td class="t">'+(e.ms!=null?(e.ms/1000).toFixed(1)+"s":"")+'</td>';
 rows.appendChild(tr);
 if(e.kind.startsWith("run.")&&e.kind!=="run.started")state.textContent=e.title;}
function connect(){const s=new EventSource("/api/runs/${run}/events?after="+last);
 s.onopen=()=>state.textContent="Live";s.addEventListener("lab",m=>add(JSON.parse(m.data)));
 s.onerror=()=>{state.textContent="Reconnecting…";s.close();setTimeout(connect,2000)};}
connect();
</script>`,
  );

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://lab.local");
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/") {
    const runs = await listRuns();
    return send(
      res,
      200,
      "text/html; charset=utf-8",
      page(
        "Rox Lab runs",
        `<h1>Rox Lab runs</h1><p class="soft">Newest first.</p><table><tbody>${runs
          .map(
            (r) =>
              `<tr><td class="t">${new Date(r.at).toLocaleString()}</td><td><a href="/runs/${r.n}">${r.title.replace(/[<>&]/g, "")}</a></td><td><code>${r.n}</code></td></tr>`,
          )
          .join("")}</tbody></table>`,
      ),
    );
  }
  if (parts[0] === "runs" && RUN.test(parts[1] ?? ""))
    return send(
      res,
      200,
      "text/html; charset=utf-8",
      RUN_PAGE(parts[1] as string),
    );

  if (
    parts[0] === "api" &&
    parts[1] === "runs" &&
    RUN.test(parts[2] ?? "") &&
    parts[3] === "events"
  ) {
    const run = parts[2] as string;
    let after = Math.max(
      0,
      Number(url.searchParams.get("after") ?? 0) ||
        Number(req.headers["last-event-id"] ?? 0) ||
        0,
    );
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    let open = true;
    req.on("close", () => {
      open = false;
    });
    while (open) {
      for (const e of await readEvents(run, after)) {
        after = e.seq;
        res.write(`id: ${e.seq}\nevent: lab\ndata: ${JSON.stringify(e)}\n\n`);
      }
      res.write(": ping\n\n");
      await new Promise((r) => setTimeout(r, 500));
    }
    return;
  }
  send(res, 404, "text/plain", "Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Rox Lab viewer on http://127.0.0.1:${PORT}`);
});
