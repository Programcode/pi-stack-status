// Pi-Stack status: a cron checks each public site every 5 minutes and keeps
// 24 hours of results in one KV key; the fetch handler renders them.

const SITES = [
  { name: "Pi-Stack", url: "https://pi-stack.org/" },
  { name: "DebateLab", url: "https://debate.pi-stack.org/" },
  { name: "Athel", url: "https://athel.pi-stack.org/" },
  { name: "Escucha", url: "https://escucha.pi-stack.org/" },
  { name: "ProtoPi", url: "https://proto.pi-stack.org/" },
  { name: "YubiNotes", url: "https://notes.pi-stack.org/" },
  { name: "Chorely", url: "https://chorely.pi-stack.org/" },
  { name: "Wordle", url: "https://wordle.pi-stack.org/" },
];

const STATE_KEY = "state";
const HISTORY_LENGTH = 288; // 24 hours at one check every 5 minutes
const BUCKETS = 48; // half-hour bars on the page
const TIMEOUT_MS = 10_000;

async function check(site) {
  const started = Date.now();
  try {
    // Login redirects count as up, so redirects are not followed.
    const res = await fetch(site.url, {
      redirect: "manual",
      headers: { "user-agent": "PiStackStatus/1.0 (+https://status.pi-stack.org)" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ok = res.status < 400;
    return { ok, code: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, code: 0, ms: Date.now() - started, error: err.name };
  }
}

async function runChecks(env) {
  const results = await Promise.all(SITES.map(check));
  const state = (await env.STATE.get(STATE_KEY, "json")) ?? { sites: {} };
  const now = Date.now();
  SITES.forEach((site, i) => {
    const r = results[i];
    const prev = state.sites[site.url] ?? { history: [] };
    const history = [...prev.history, r.ok ? 1 : 0].slice(-HISTORY_LENGTH);
    state.sites[site.url] = { last: { ...r, at: now }, history };
  });
  state.checkedAt = now;
  await env.STATE.put(STATE_KEY, JSON.stringify(state));
  return state;
}

function summarize(state) {
  return SITES.map((site) => {
    const s = state?.sites?.[site.url];
    const history = s?.history ?? [];
    const uptime = history.length ? (history.reduce((a, b) => a + b, 0) / history.length) * 100 : null;
    const perBucket = HISTORY_LENGTH / BUCKETS;
    const padded = Array(Math.max(0, HISTORY_LENGTH - history.length)).fill(null).concat(history);
    const bars = [];
    for (let b = 0; b < BUCKETS; b++) {
      const slice = padded.slice(b * perBucket, (b + 1) * perBucket).filter((v) => v !== null);
      bars.push(!slice.length ? "none" : slice.every(Boolean) ? "up" : slice.some(Boolean) ? "partial" : "down");
    }
    return {
      name: site.name,
      host: new URL(site.url).host,
      url: site.url,
      ok: s?.last?.ok ?? null,
      code: s?.last?.code ?? null,
      ms: s?.last?.ms ?? null,
      uptime,
      bars,
    };
  });
}

const escape = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function ago(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return "less than a minute ago";
  if (min === 1) return "1 minute ago";
  if (min < 60) return `${min} minutes ago`;
  const h = Math.round(min / 60);
  return h === 1 ? "1 hour ago" : `${h} hours ago`;
}

function renderPage(state) {
  const rows = summarize(state);
  const known = rows.filter((r) => r.ok !== null);
  const down = known.filter((r) => !r.ok);
  const headline = !known.length
    ? "Waiting for the first check"
    : down.length === 0
      ? "Everything is running"
      : down.length === 1
        ? `${down[0].name} is down`
        : `${down.length} sites are down`;
  const checked = state?.checkedAt ? `Last checked ${ago(Date.now() - state.checkedAt)}.` : "";

  const rowHtml = rows
    .map((r) => {
      const label = r.ok === null ? "No data" : r.ok ? "Up" : "Down";
      const cls = r.ok === null ? "none" : r.ok ? "up" : "down";
      const uptime = r.uptime === null ? "–" : `${r.uptime.toFixed(r.uptime === 100 ? 0 : 2)}%`;
      const detail = r.ok === null ? "" : r.ok ? `${r.ms} ms` : r.code ? `HTTP ${r.code}` : "No response";
      return `
      <li class="site">
        <div class="site-head">
          <a class="site-name" href="${escape(r.url)}">${escape(r.name)}</a>
          <span class="host">${escape(r.host)}</span>
          <span class="state ${cls}"><i></i>${label}</span>
        </div>
        <div class="bars" role="img" aria-label="${escape(r.name)}: ${uptime} uptime over the last 24 hours">
          ${r.bars.map((b) => `<span class="${b}"></span>`).join("")}
        </div>
        <div class="site-foot"><span>24 hours ago</span><span>${uptime} uptime${detail ? `, ${escape(detail)}` : ""}</span><span>Now</span></div>
      </li>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${escape(headline)} | Pi-Stack status</title>
<meta name="description" content="Live status of every Pi-Stack product, checked every 5 minutes.">
<link rel="icon" href="https://pi-stack.org/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
  :root { --paper:#F2F4F8; --white:#fff; --ink:#0F1A3A; --ink-soft:#4A5476; --cobalt:#2C46F5; --line:#D8DDEA; --up:#17A673; --partial:#E8A33D; --down:#D64545; --none:#DDE2EE; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font-family:"Schibsted Grotesk", system-ui, sans-serif; font-size:17px; line-height:1.5; -webkit-font-smoothing:antialiased; }
  a { color: inherit; }
  a:focus-visible { outline:3px solid var(--cobalt); outline-offset:3px; border-radius:4px; }
  .wrap { width:min(820px, 100% - 40px); margin-inline:auto; }
  header { display:flex; align-items:center; justify-content:space-between; padding:22px 0; }
  .brand { display:flex; align-items:center; gap:10px; font-weight:900; font-size:20px; letter-spacing:-0.02em; text-decoration:none; }
  .brand b { width:32px; height:32px; border-radius:9px; background:var(--cobalt); color:#fff; display:grid; place-items:center; font-size:20px; }
  header nav a { color:var(--ink-soft); font-weight:500; font-size:15px; text-decoration:none; }
  header nav a:hover { color:var(--ink); }
  .hero { padding:48px 0 36px; }
  h1 { font-size:clamp(36px, 7vw, 60px); line-height:1; letter-spacing:-0.04em; font-weight:900; margin:0 0 14px; }
  .hero p { margin:0; color:var(--ink-soft); }
  .hero.has-down h1 { color:var(--down); }
  ul { list-style:none; padding:0; margin:0 0 56px; background:var(--white); border-radius:18px; box-shadow:0 0 0 1px var(--line); }
  .site { padding:22px 24px; border-bottom:1px solid var(--line); }
  .site:last-child { border-bottom:0; }
  .site-head { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
  .site-name { font-weight:700; font-size:19px; text-decoration:none; }
  .site-name:hover { text-decoration:underline; text-underline-offset:3px; }
  .host { color:var(--ink-soft); font-size:15px; }
  .state { margin-left:auto; display:inline-flex; align-items:center; gap:8px; font-weight:700; font-size:15px; }
  .state i { width:10px; height:10px; border-radius:50%; background:var(--none); }
  .state.up i { background:var(--up); box-shadow:0 0 0 3px rgba(23,166,115,.2); }
  .state.down { color:var(--down); }
  .state.down i { background:var(--down); box-shadow:0 0 0 3px rgba(214,69,69,.2); }
  .bars { display:grid; grid-template-columns:repeat(${BUCKETS}, 1fr); gap:3px; height:34px; }
  .bars span { border-radius:3px; background:var(--none); }
  .bars .up { background:var(--up); }
  .bars .partial { background:var(--partial); }
  .bars .down { background:var(--down); }
  .site-foot { display:flex; justify-content:space-between; gap:12px; margin-top:8px; font-size:13px; color:var(--ink-soft); }
  footer { padding:0 0 48px; color:var(--ink-soft); font-size:15px; }
  @media (max-width:560px) { .bars { gap:2px; height:28px; } .site { padding:18px 16px; } .site-foot span:first-child, .site-foot span:last-child { display:none; } }
</style>
</head>
<body>
<header class="wrap">
  <a class="brand" href="https://pi-stack.org"><b aria-hidden="true">π</b>Pi-Stack status</a>
  <nav><a href="https://pi-stack.org">pi-stack.org</a></nav>
</header>
<main class="wrap">
  <section class="hero${down.length ? " has-down" : ""}">
    <h1>${escape(headline)}</h1>
    <p>Every site is checked from Cloudflare's network every 5 minutes. ${escape(checked)}</p>
  </section>
  <ul>${rowHtml}</ul>
</main>
<footer class="wrap">Bars show the last 24 hours in half-hour blocks. Green means every check passed, amber means some failed, red means all failed.</footer>
</body>
</html>`;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runChecks(env));
  },

  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    let state = await env.STATE.get(STATE_KEY, "json");
    if (!state) state = await runChecks(env);

    if (pathname === "/api/status") {
      const body = { checkedAt: state.checkedAt, sites: summarize(state).map(({ bars, ...rest }) => rest) };
      return Response.json(body, { headers: { "cache-control": "public, max-age=30", "access-control-allow-origin": "*" } });
    }
    if (pathname !== "/") return new Response("Not found", { status: 404 });
    return new Response(renderPage(state), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=30" },
    });
  },
};
