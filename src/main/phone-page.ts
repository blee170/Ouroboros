/**
 * The phone page: static HTML, CSS and JS served by the phone server under /m. No build step, no CDN, no inline
 * script (the CSP is default-src 'self'); everything from the board is put on the page as text, never as HTML.
 * Laid out as a small app in the desktop's greys with frosted-glass panels: Board (a list, the canvas map or a 3D
 * orbit of the cards and their connections, the owner's pick), Inbox (what waits on the owner) and Report tabs, and
 * a bottom sheet per card with its last reply and a message box.
 */

const ICONS = {
  board: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/></svg>',
  report: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>'
}

export const PHONE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0a0a">
<meta name="color-scheme" content="dark">
<link rel="manifest" href="/m/manifest.json">
<link rel="icon" href="/m/icon.png" type="image/png">
<link rel="apple-touch-icon" href="/m/icon.png">
<link rel="stylesheet" href="/m/app.css">
<title>Ouroboros</title>
</head>
<body>
<div class="backdrop" aria-hidden="true"></div>
<header class="bar glass">
  <img class="logo" src="/m/icon.png" alt="">
  <div class="who"><div class="name">Ouroboros</div><div id="sub" class="sub">Connecting…</div></div>
  <span id="live" class="live" role="status" aria-label="Connection"></span>
</header>
<main id="view"></main>
<nav id="tabs" class="tabs glass" hidden>
  <button type="button" class="tab on" data-tab="board">${ICONS.board}<span>Board</span></button>
  <button type="button" class="tab" data-tab="inbox">${ICONS.inbox}<span>Inbox</span><b id="badge" class="badge" hidden></b></button>
  <button type="button" class="tab" data-tab="report">${ICONS.report}<span>Report</span></button>
</nav>
<div id="sheet" class="sheet" hidden><div class="scrim" data-close="1"></div><div class="panel glass" role="dialog" aria-modal="true"><div class="grab" data-close="1"></div><div id="sheet-body"></div></div></div>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script src="/m/app.js"></script>
</body>
</html>
`

export const PHONE_CSS = `:root {
  color-scheme: dark;
  --bg: #0a0a0a; --text: #fafafa; --muted: #a1a1a1; --faint: #737373;
  --glass: rgba(38,38,38,.42); --glass-strong: rgba(48,48,48,.62); --glass-line: rgba(255,255,255,.09); --glass-hi: rgba(255,255,255,.10);
  --fill: rgba(255,255,255,.06); --fill2: rgba(255,255,255,.1);
  --primary: #e5e5e5; --primary-fg: #171717;
  --working: #f0b100; --needs: #ff6900; --ok: #00bc7d; --danger: #ff6568; --idle: #737373;
  --r: 20px; --safe-b: env(safe-area-inset-bottom, 0px); --safe-t: env(safe-area-inset-top, 0px);
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body { font: 15px/1.45 'Pretendard Variable', Pretendard, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased; overscroll-behavior-y: contain; letter-spacing: -.005em; }
/* soft grey light behind the glass, so the frosting has something to blur */
.backdrop { position: fixed; inset: -20%; z-index: -1; pointer-events: none;
  background: radial-gradient(40% 30% at 15% 10%, rgba(255,255,255,.09), transparent 70%), radial-gradient(45% 35% at 90% 35%, rgba(180,180,190,.07), transparent 70%), radial-gradient(50% 40% at 30% 95%, rgba(255,255,255,.06), transparent 70%), var(--bg); }
button { font: inherit; color: inherit; border: 0; background: none; cursor: pointer; }
button:focus-visible, textarea:focus-visible { outline: 2px solid rgba(255,255,255,.5); outline-offset: 2px; }
svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

.glass { background: var(--glass); border: 1px solid var(--glass-line); box-shadow: inset 0 1px 0 var(--glass-hi), 0 10px 30px rgba(0,0,0,.35);
  backdrop-filter: blur(24px) saturate(150%); -webkit-backdrop-filter: blur(24px) saturate(150%); }

.bar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 12px; margin: 0; padding: calc(10px + var(--safe-t)) 18px 10px; border-width: 0 0 1px; border-radius: 0; box-shadow: inset 0 -1px 0 rgba(255,255,255,.03); }
.logo { width: 36px; height: 36px; border-radius: 10px; }
.who { flex: 1; min-width: 0; }
.name { font-weight: 700; font-size: 17px; letter-spacing: -.02em; }
.sub { color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.live { width: 9px; height: 9px; border-radius: 50%; background: var(--faint); flex: none; }
.live.on { background: var(--ok); box-shadow: 0 0 0 4px rgba(0,188,125,.15); }
.live.off { background: var(--danger); box-shadow: 0 0 0 4px rgba(255,101,104,.15); }

main { padding: 14px 16px calc(100px + var(--safe-b)); max-width: 680px; margin: 0 auto; }
.section { margin: 22px 6px 10px; display: flex; align-items: baseline; justify-content: space-between; }
.section h2 { margin: 0; font-size: 12.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
.section .count { color: var(--faint); font-size: 13px; }

.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.stat { border-radius: var(--r); padding: 13px 14px; text-align: left; }
.stat .n { font-size: 26px; font-weight: 700; letter-spacing: -.03em; line-height: 1.1; }
.stat .l { color: var(--muted); font-size: 12.5px; margin-top: 3px; display: flex; align-items: center; gap: 6px; }
.stat .l::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--idle); }
.stat.needs .l::before { background: var(--needs); } .stat.working .l::before { background: var(--working); }

.seg { display: grid; grid-template-columns: repeat(3, 1fr); padding: 4px; border-radius: 14px; margin-top: 12px; }
.seg button { min-height: 36px; border-radius: 10px; color: var(--muted); font-size: 13.5px; font-weight: 600; transition: background .2s, color .2s; }
.seg button.on { background: var(--fill2); color: var(--text); box-shadow: inset 0 1px 0 rgba(255,255,255,.08); }

.banner { display: flex; align-items: center; gap: 10px; width: 100%; margin-top: 12px; padding: 13px 16px; border-radius: var(--r); text-align: left; }
.banner .pip { width: 8px; height: 8px; border-radius: 50%; background: var(--needs); box-shadow: 0 0 0 4px rgba(255,105,0,.15); flex: none; }
.banner .go { margin-left: auto; color: var(--muted); font-size: 20px; }

.list { border-radius: var(--r); overflow: hidden; }
.row { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 14px; text-align: left; min-height: 64px; }
.row + .row { border-top: 1px solid var(--glass-line); }
.row:active { background: var(--fill); }
.avatar { width: 40px; height: 40px; border-radius: 12px; flex: none; display: grid; place-items: center; font-size: 19px; background: var(--fill); border: 1px solid var(--glass-line); position: relative; color: var(--text); font-weight: 600; }
.avatar.lead { border-color: rgba(255,255,255,.35); box-shadow: 0 0 0 3px rgba(255,255,255,.05); }
.avatar .dot { position: absolute; right: -3px; bottom: -3px; width: 12px; height: 12px; border-radius: 50%; border: 2.5px solid #1c1c1c; background: var(--idle); }
.dot.working, .pip.working { background: var(--working); } .dot.needs-you { background: var(--needs); } .dot.done { background: var(--ok); } .dot.ended { background: #404040; }
.dot.working { animation: beat 1.8s ease-in-out infinite; }
@keyframes beat { 0%,100% { box-shadow: 0 0 0 0 rgba(240,177,0,.5); } 50% { box-shadow: 0 0 0 5px rgba(240,177,0,0); } }
.body { flex: 1; min-width: 0; }
.t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.d { color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.meta { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: none; }
.pill { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; padding: 3px 9px; border-radius: 99px; background: var(--fill); color: var(--muted); }
.pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--idle); }
.pill.working::before { background: var(--working); } .pill.needs-you::before { background: var(--needs); } .pill.done::before { background: var(--ok); }
.ago { color: var(--faint); font-size: 12px; }
.more { width: 100%; padding: 12px; color: var(--muted); font-size: 14px; border-top: 1px solid var(--glass-line); }

/* the map: the canvas layout (Graph) or a turning 3D ring (Orbit) */
.map { position: relative; margin-top: 12px; border-radius: 24px; overflow: hidden; height: min(64vh, 560px); touch-action: none; user-select: none; -webkit-user-select: none; }
.map svg { width: 100%; height: 100%; display: block; stroke: none; }
.map .hint { position: absolute; left: 0; right: 0; bottom: 10px; text-align: center; color: var(--faint); font-size: 12px; pointer-events: none; }
.map .tools { position: absolute; right: 10px; top: 10px; display: flex; flex-direction: column; gap: 6px; }
.map .tools button { width: 36px; height: 36px; border-radius: 12px; color: var(--muted); font-size: 18px; font-weight: 600; }
.ln { stroke: rgba(255,255,255,.16); stroke-width: 1.4; fill: none; }
.ln.hub { stroke: rgba(255,255,255,.07); stroke-dasharray: 2 5; }
.ln.dispatch { stroke-dasharray: 5 5; }
.ln.live { stroke: rgba(255,255,255,.55); stroke-width: 1.8; stroke-dasharray: 3 9; animation: flow .9s linear infinite; filter: drop-shadow(0 0 3px rgba(255,255,255,.55)); }
.ln.fired { stroke: #fff; stroke-width: 2.4; stroke-dasharray: none; animation: fire 1.4s ease-out infinite; filter: drop-shadow(0 0 6px rgba(255,255,255,.8)); }
@keyframes flow { to { stroke-dashoffset: -24; } }
@keyframes fire { 0% { stroke-opacity: 1; } 70%,100% { stroke-opacity: .35; } }
/* cards are dots: grey when idle, status colour when they matter, a lit sphere once zoomed in */
.od { cursor: pointer; }
.od .hit { fill: transparent; }
.od .glow { fill: #fff; opacity: .1; }
.od .dot { fill: #d4d4d4; }
.od .shine { fill: #fff; opacity: 0; pointer-events: none; }
.od.lead .dot { fill: #fff; } .od.lead .glow { opacity: .22; }
.od.working .dot { fill: var(--working); } .od.needs-you .dot { fill: var(--needs); } .od.done .dot { fill: var(--ok); } .od.ended .dot { fill: #525252; }
.od.working .glow { fill: var(--working); opacity: .3; animation: breathe 1.8s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
.od.needs-you .glow { fill: var(--needs); opacity: .4; animation: ping 1.8s ease-out infinite; transform-box: fill-box; transform-origin: center; }
.od.sel .dot { stroke: #fff; stroke-width: 1.6; }
.od.sel .glow { opacity: .35; }
@keyframes breathe { 0%,100% { transform: scale(.85); } 50% { transform: scale(1.25); } }
@keyframes ping { 0% { transform: scale(.8); opacity: .6; } 100% { transform: scale(1.9); opacity: 0; } }
.od .tag.under { text-anchor: middle; }
.od .tag { font-size: 9.5px; fill: #e5e5e5; font-weight: 500; paint-order: stroke; stroke: rgba(10,10,10,.85); stroke-width: 2.5px; transition: opacity .25s; pointer-events: none; }
.dust { fill: #fff; pointer-events: none; }
.spark { fill: #fff; pointer-events: none; filter: drop-shadow(0 0 3px rgba(255,255,255,.9)); }
.ln, .ln.hl, .ln.dim { pointer-events: none; transition: stroke-opacity .25s; }
.map svg .ln.hl { stroke: #fff; stroke-opacity: 1; stroke-width: 1.8; filter: drop-shadow(0 0 4px rgba(255,255,255,.75)); }
.ln.dim { stroke-opacity: .2; }
/* Orbit: a round globe with a header and a status bar */
.map.orbit { height: auto; aspect-ratio: 1 / 1.12; max-height: 72vh; background: radial-gradient(circle at 50% 46%, rgba(255,255,255,.06), transparent 62%), var(--glass); }
.map.orbit .ln { stroke: rgba(255,255,255,.2); stroke-width: 1; }
.map.orbit .ln.live { stroke: rgba(255,255,255,.5); stroke-width: 1.3; }
.map.orbit .hint { bottom: 54px; }
.map .hint { animation: hintout .8s 5s forwards; }
@keyframes hintout { to { opacity: 0; } }
.map .head { position: absolute; left: 14px; top: 13px; display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; pointer-events: none; }
.map .head i { width: 13px; height: 13px; border-radius: 50%; border: 2.5px solid var(--text); box-shadow: 0 0 10px rgba(255,255,255,.35); }
.map .head small { font-size: 10.5px; font-weight: 600; color: var(--muted); background: var(--fill2); padding: 2px 7px; border-radius: 99px; }
.map .foot { position: absolute; left: 10px; right: 10px; bottom: 10px; display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 12px; background: rgba(10,10,10,.62); border: 1px solid var(--glass-line); font: 11px/1.3 'D2Coding', ui-monospace, 'SF Mono', Consolas, monospace; color: var(--muted); pointer-events: none; }
.map .foot b { color: var(--text); }
.map .foot .keys { display: flex; gap: 8px; white-space: nowrap; }
.map .foot > span:first-child { white-space: nowrap; } .map .foot .keys span { display: inline-flex; align-items: center; gap: 4px; }
.map .foot i, .map .tip i { width: 6px; height: 6px; border-radius: 50%; background: #d4d4d4; display: inline-block; }
.map i.working { background: var(--working); } .map i.needs-you { background: var(--needs); } .map i.done { background: var(--ok); } .map i.ended { background: #525252; }
.map .tip { position: absolute; z-index: 2; width: 170px; padding: 9px 11px; border-radius: 12px; background: rgba(23,23,23,.86); border: 1px solid rgba(255,255,255,.12); font-size: 12px; pointer-events: none;
  transform: translate(-50%, calc(-100% - 16px)); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); box-shadow: 0 10px 30px rgba(0,0,0,.5); }
.map .tip.below { transform: translate(-50%, 16px); }
.map .tip .tt { font-weight: 700; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.map .tip .ts { color: var(--muted); margin-top: 3px; display: flex; align-items: center; gap: 6px; }
.map .tip .th { color: var(--faint); margin-top: 4px; font-size: 11px; }
.legend { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; margin: 12px 0 0; color: var(--muted); font-size: 12.5px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 8px; height: 8px; border-radius: 50%; background: #d4d4d4; display: inline-block; }
.legend i.working { background: var(--working); } .legend i.needs { background: var(--needs); } .legend i.done { background: var(--ok); }
.legend i.line { width: 18px; height: 2px; border-radius: 2px; background: rgba(255,255,255,.6); }

.item { border-radius: var(--r); padding: 16px; margin-bottom: 12px; }
.kind { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
.kind::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--needs); }
.item .q { font-size: 16px; font-weight: 600; margin: 8px 0 4px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
.item .from { color: var(--muted); font-size: 13px; }
.cmd { font: 13px/1.5 'D2Coding', ui-monospace, 'SF Mono', Consolas, monospace; background: rgba(0,0,0,.35); border: 1px solid var(--glass-line); border-radius: 12px; padding: 10px 12px; margin: 10px 0 2px; white-space: pre-wrap; word-break: break-all; }
.actions { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
.btn { flex: 1 1 0; min-height: 48px; padding: 0 16px; border-radius: 14px; background: var(--fill); border: 1px solid var(--glass-line); font-weight: 600; box-shadow: inset 0 1px 0 rgba(255,255,255,.06); transition: transform .1s, background .2s; }
.btn.primary { background: var(--primary); color: var(--primary-fg); border-color: transparent; }
.btn.danger { color: var(--danger); }
.btn.wide { display: block; width: 100%; margin-top: 14px; }
.btn:disabled { opacity: .45; }
.btn:active:not(:disabled) { transform: scale(.98); }
.field { width: 100%; margin-top: 12px; background: rgba(0,0,0,.3); color: var(--text); border: 1px solid var(--glass-line); border-radius: 14px; padding: 12px 14px; font: inherit; resize: none; }
.field::placeholder { color: var(--faint); }

.empty { text-align: center; padding: 56px 24px; color: var(--muted); }
.empty .icon { width: 64px; height: 64px; margin: 0 auto 14px; border-radius: 20px; display: grid; place-items: center; background: var(--fill); color: var(--text); border: 1px solid var(--glass-line); }
.empty .icon svg { width: 30px; height: 30px; }
.empty h3 { color: var(--text); margin: 0 0 6px; font-size: 18px; }
.hero { text-align: center; padding: 44px 8px 24px; }
.hero img { width: 92px; height: 92px; border-radius: 24px; box-shadow: 0 20px 60px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08); }
.hero h1 { font-size: 24px; letter-spacing: -.03em; margin: 22px 0 6px; }
.hero p { color: var(--muted); margin: 0; }
.steps { list-style: none; padding: 0; margin: 28px 0 0; counter-reset: s; text-align: left; }
.steps li { counter-increment: s; display: flex; gap: 14px; align-items: center; border-radius: 18px; padding: 14px; margin-bottom: 10px; }
.steps li::before { content: counter(s); flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; background: var(--fill2); font-weight: 700; font-size: 14px; }

.doc { border-radius: var(--r); padding: 6px 18px 16px; word-break: break-word; }
.doc h3 { font-size: 16px; margin: 18px 0 6px; } .doc h4 { font-size: 12.5px; color: var(--faint); margin: 16px 0 4px; text-transform: uppercase; letter-spacing: .06em; }
.doc p { margin: 6px 0; color: #d4d4d4; } .doc li { margin: 4px 0 4px 18px; color: #d4d4d4; }
.doc pre { font: 12.5px/1.5 'D2Coding', ui-monospace, Consolas, monospace; background: rgba(0,0,0,.35); border-radius: 10px; padding: 10px; white-space: pre-wrap; }
.linkish { display: block; width: 100%; margin-top: 12px; min-height: 48px; border-radius: 14px; color: var(--danger); }

.tabs { position: fixed; left: 12px; right: 12px; bottom: calc(10px + var(--safe-b)); z-index: 6; display: flex; justify-content: space-around; padding: 6px; border-radius: 26px; max-width: 480px; margin: 0 auto; }
.tab { position: relative; flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 6px 0; min-height: 52px; color: var(--faint); font-size: 11.5px; font-weight: 600; border-radius: 20px; transition: background .2s, color .2s; }
.tab.on { color: var(--text); background: var(--fill2); box-shadow: inset 0 1px 0 rgba(255,255,255,.08); }
.badge { position: absolute; top: 3px; left: calc(50% + 7px); min-width: 18px; height: 18px; padding: 0 5px; border-radius: 99px; background: var(--needs); color: #fff; font-size: 11px; line-height: 18px; text-align: center; }

.sheet { position: fixed; inset: 0; z-index: 20; }
.scrim { position: absolute; inset: 0; background: rgba(0,0,0,.5); animation: fade .2s ease; }
.panel { position: absolute; left: 0; right: 0; bottom: 0; max-height: 88vh; overflow: auto; border-radius: 28px 28px 0 0; border-width: 1px 0 0; background: var(--glass-strong);
  padding: 8px 18px calc(18px + var(--safe-b)); animation: up .28s cubic-bezier(.2,.8,.2,1); max-width: 680px; margin: 0 auto; }
.grab { width: 40px; height: 5px; border-radius: 99px; background: rgba(255,255,255,.2); margin: 4px auto 14px; }
.sheet-head { display: flex; align-items: center; gap: 12px; }
.sheet-head .t { font-size: 18px; white-space: normal; }
.reply { margin-top: 10px; background: rgba(0,0,0,.3); border: 1px solid var(--glass-line); border-radius: 14px; padding: 12px 14px; font-size: 14px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; max-height: 42vh; overflow: auto; color: #d4d4d4; }
.label { color: var(--faint); font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; margin-top: 16px; }
.note { color: var(--muted); font-size: 13px; margin-top: 12px; }
@keyframes up { from { transform: translateY(100%); } to { transform: none; } }
@keyframes fade { from { opacity: 0; } }

.toast { position: fixed; left: 50%; top: calc(14px + var(--safe-t)); z-index: 30; transform: translate(-50%, -20px); opacity: 0; pointer-events: none;
  background: rgba(229,229,229,.92); color: #171717; font-weight: 600; font-size: 14px; padding: 11px 18px; border-radius: 99px; max-width: calc(100% - 32px); transition: .22s ease;
  box-shadow: 0 10px 30px rgba(0,0,0,.45); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.toast.bad { background: rgba(255,101,104,.92); color: #fff; }
.skeleton { height: 64px; border-radius: var(--r); background: linear-gradient(90deg, rgba(255,255,255,.04) 0%, rgba(255,255,255,.08) 50%, rgba(255,255,255,.04) 100%); background-size: 200% 100%; animation: shimmer 1.2s infinite; margin-bottom: 10px; }
@keyframes shimmer { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; transition: none !important; } }
`

export const PHONE_MANIFEST = JSON.stringify({
  name: 'Ouroboros',
  short_name: 'Ouroboros',
  start_url: '/m',
  scope: '/m',
  display: 'standalone',
  background_color: '#0a0a0a',
  theme_color: '#0a0a0a',
  icons: [{ src: '/m/icon.png', sizes: '256x256', type: 'image/png', purpose: 'any' }]
})

export const PHONE_JS = `'use strict'
var KEY = 'ouroboros-phone-token'
var VIEW_KEY = 'ouroboros-phone-view'
var SVG = 'http://www.w3.org/2000/svg'
var state = { tab: 'board', board: null, json: '', sheet: null, showIdle: false, report: null, seenNeeds: -1, view: readView() }
var drafts = {}
var notes = {}

function readView() { try { var v = localStorage.getItem(VIEW_KEY); return v === 'graph' || v === 'orbit' ? v : 'list' } catch (e) { return 'list' } }
function token() { try { return localStorage.getItem(KEY) || '' } catch (e) { return '' } }
function setToken(t) { try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY) } catch (e) {} }
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
function sv(tag, cls) { var e = document.createElementNS(SVG, tag); if (cls) e.setAttribute('class', cls); return e }
function $(id) { return document.getElementById(id) }
function checkIcon() { var s = sv('svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); var p = sv('path'); p.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5'); s.appendChild(p); return s }
function glass(tag, cls, text) { return el(tag, (cls ? cls + ' ' : '') + 'glass', text) }

var toastTimer = null
function toast(msg, bad) {
  var t = $('toast')
  t.textContent = msg
  t.className = 'toast show' + (bad ? ' bad' : '')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(function () { t.className = 'toast' + (bad ? ' bad' : '') }, 2600)
}

function api(method, path, body) {
  return fetch('/m/api/' + path, { method: method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token() }, body: body ? JSON.stringify(body) : undefined })
    .then(function (r) {
      if (r.status === 401) { setToken(''); state.board = null; draw(); throw new Error('This phone is no longer paired') }
      return r.text().then(function (s) {
        var j = {}
        try { j = s ? JSON.parse(s) : {} } catch (e) {}
        if (!r.ok) throw new Error(j.error || (r.status === 403 || r.status === 421 ? 'The PC refused this phone (network or address changed in Settings)' : 'Error ' + r.status))
        return j
      })
    })
}
function send(path, body, okMsg) {
  return api('POST', path, body).then(function () { if (okMsg) toast(okMsg); tick(); return true }).catch(function (e) { toast(e.message, true); return false })
}

function pairFromHash() {
  var m = /pair=([^&]+)/.exec(location.hash)
  if (!m) return Promise.resolve()
  var code = decodeURIComponent(m[1])
  history.replaceState(null, '', '/m')
  var name = /Android/.test(navigator.userAgent) ? 'Android phone' : /iPhone/.test(navigator.userAgent) ? 'iPhone' : 'Phone'
  return fetch('/m/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code, name: name }) })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Pairing failed'); setToken(j.token); toast('Paired with your PC') }) })
    .catch(function (e) { toast(e.message, true) })
}

/* the leading emoji of a title becomes its avatar; otherwise its first letter */
var LEAD = /^(\\p{Extended_Pictographic}(?:\\uFE0F|\\u200D\\p{Extended_Pictographic})*)\\s*/u
function split(title) {
  var m = LEAD.exec(title || '')
  if (m) return { mark: m[1], name: title.slice(m[0].length) || title }
  var t = (title || '?').trim()
  return { mark: (Array.from(t)[0] || '?').toUpperCase(), name: t }
}
var LABEL = { 'needs-you': 'Needs you', working: 'Working', idle: 'Idle', done: 'Done', starting: 'Starting', ended: 'Ended' }
function ago(ms) {
  if (!ms) return ''
  var s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 45) return 'now'
  if (s < 3600) return Math.round(s / 60) + 'm'
  if (s < 86400) return Math.round(s / 3600) + 'h'
  return Math.round(s / 86400) + 'd'
}
function avatar(c) {
  var a = el('div', 'avatar' + (c.conductor ? ' lead' : ''), split(c.title).mark)
  if (c.conductor) a.title = 'Conductor'
  a.appendChild(el('span', 'dot ' + c.status))
  return a
}
function needs(b) {
  if (!b) return 0
  return (b.decisions || []).length + (b.approvals || []).length + b.cards.filter(function (c) { return c.permission }).length
}

/* ---------- board: list ---------- */
function cardRow(c) {
  var row = el('button', 'row')
  row.type = 'button'
  row.appendChild(avatar(c))
  var body = el('div', 'body')
  body.appendChild(el('div', 't', split(c.title).name))
  body.appendChild(el('div', 'd', c.detail || (c.last ? c.last.replace(/\\s+/g, ' ').slice(0, 120) : '—')))
  row.appendChild(body)
  var meta = el('div', 'meta')
  meta.appendChild(el('span', 'pill ' + c.status, LABEL[c.status] || c.status))
  var when = ago(c.promptAt)
  if (when) meta.appendChild(el('span', 'ago', when))
  row.appendChild(meta)
  row.addEventListener('click', function () { openCard(c.id) })
  return row
}
function group(title, cards, limit) {
  var frag = document.createDocumentFragment()
  if (!cards.length) return frag
  var head = el('div', 'section')
  head.appendChild(el('h2', '', title))
  head.appendChild(el('span', 'count', String(cards.length)))
  frag.appendChild(head)
  var list = glass('div', 'list')
  var shown = limit && cards.length > limit ? cards.slice(0, limit) : cards
  shown.forEach(function (c) { list.appendChild(cardRow(c)) })
  if (shown.length < cards.length) {
    var more = el('button', 'more', 'Show ' + (cards.length - shown.length) + ' more')
    more.type = 'button'
    more.addEventListener('click', function () { state.showIdle = true; draw() })
    list.appendChild(more)
  }
  frag.appendChild(list)
  return frag
}
function stat(cls, n, label, onTap) {
  var b = glass('button', 'stat ' + cls)
  b.type = 'button'
  b.appendChild(el('div', 'n', String(n)))
  b.appendChild(el('div', 'l', label))
  if (onTap) b.addEventListener('click', onTap)
  return b
}
function segmented() {
  var seg = glass('div', 'seg')
  seg.setAttribute('role', 'tablist')
  ;[['list', 'List'], ['graph', 'Graph'], ['orbit', 'Orbit']].forEach(function (m) {
    var b = el('button', state.view === m[0] ? 'on' : '', m[1])
    b.type = 'button'
    b.setAttribute('role', 'tab')
    b.setAttribute('aria-selected', String(state.view === m[0]))
    b.addEventListener('click', function () {
      state.view = m[0]
      try { localStorage.setItem(VIEW_KEY, m[0]) } catch (e) {}
      state.json = ''
      draw()
    })
    seg.appendChild(b)
  })
  return seg
}
function drawBoard(v, b) {
  var waiting = needs(b)
  var working = b.cards.filter(function (c) { return c.status === 'working' || c.status === 'starting' })
  var parked = b.cards.filter(function (c) { return c.status === 'needs-you' })
  var rest = b.cards.filter(function (c) { return working.indexOf(c) < 0 && parked.indexOf(c) < 0 })
  var stats = el('div', 'stats')
  stats.appendChild(stat('needs', waiting, 'Needs you', function () { go('inbox') }))
  stats.appendChild(stat('working', working.length, 'Working'))
  stats.appendChild(stat('', rest.length, 'Idle'))
  v.appendChild(stats)
  if (waiting) {
    var banner = glass('button', 'banner')
    banner.type = 'button'
    banner.appendChild(el('span', 'pip'))
    banner.appendChild(el('span', '', waiting + (waiting === 1 ? ' thing waits on you' : ' things wait on you')))
    banner.appendChild(el('span', 'go', '›'))
    banner.addEventListener('click', function () { go('inbox') })
    v.appendChild(banner)
  }
  v.appendChild(segmented())
  if (!b.cards.length) { stopMap(); v.appendChild(empty('No cards yet', 'Cards you open on the PC show up here.')); return }
  if (state.view === 'list') {
    stopMap()
    v.appendChild(group('Needs you', parked))
    v.appendChild(group('Working', working))
    v.appendChild(group('Idle', rest, state.showIdle ? 0 : 6))
    return
  }
  v.appendChild(mapView(b))
  // the globe carries its own key in its status bar
  if (state.view === 'orbit') return
  var legend = el('div', 'legend')
  ;[['working', 'Working'], ['needs', 'Needs you'], ['', 'Idle'], ['line', 'Active line']].forEach(function (l) {
    var s = el('span')
    s.appendChild(el('i', l[0]))
    s.appendChild(document.createTextNode(l[1]))
    legend.appendChild(s)
  })
  v.appendChild(legend)
}

/* ---------- board: Graph (the canvas layout) and Orbit (a turning globe of the cards and their links) ---------- */
var map = null
var hinted = {}
// a turned phone gets the map laid out again for its new size
window.addEventListener('resize', function () { if (map) map.painted = false })
function stopMap() { if (map && map.raf) cancelAnimationFrame(map.raf); map = null }
/* connections: handoff and dispatch lines; a board with none shows each card joined to the Conductor */
function linksOf(b) {
  var out = (b.edges || []).map(function (e) { return { from: e.from, to: e.to, kind: e.kind, firedAt: e.firedAt } })
  if (!out.length) {
    var hub = b.cards.find(function (c) { return c.conductor })
    if (hub) b.cards.forEach(function (c) { if (c !== hub) out.push({ from: hub.id, to: c.id, kind: 'hub' }) })
  }
  return out
}
/* evenly spread points on a unit sphere (a Fibonacci lattice) */
function sphere(n) {
  var out = []
  for (var i = 0; i < n; i++) {
    var y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2
    var r = Math.sqrt(1 - y * y), t = i * 2.399963
    out.push({ x: Math.cos(t) * r, y: y, z: Math.sin(t) * r })
  }
  return out
}
/* the faint points that give the globe its surface; decoration only */
var DUST = sphere(150)
/* each card's place in 3D: Graph flattens the canvas into the view; Orbit puts every card on the globe, the Conductor facing you */
function layout(b, mode) {
  var pos = {}
  var cards = b.cards
  if (mode === 'graph') {
    var placed = cards.filter(function (c) { return typeof c.x === 'number' && typeof c.y === 'number' })
    var xs = placed.map(function (c) { return c.x }), ys = placed.map(function (c) { return c.y })
    var spanX = placed.length ? Math.max.apply(null, xs) - Math.min.apply(null, xs) : 0
    var spanY = placed.length ? Math.max.apply(null, ys) - Math.min.apply(null, ys) : 0
    if (placed.length < cards.length || placed.length < 2 || (spanX < 1 && spanY < 1)) {
      // no canvas positions (an older app): a ring
      cards.forEach(function (c, i) { var a = i / cards.length * Math.PI * 2 - Math.PI / 2; pos[c.id] = { x: Math.cos(a), y: Math.sin(a), z: 0 } })
      return pos
    }
    // a wide canvas on a tall phone turns a quarter, so it fills the screen
    var turn = spanX > spanY * 1.2
    var cx = (Math.max.apply(null, xs) + Math.min.apply(null, xs)) / 2, cy = (Math.max.apply(null, ys) + Math.min.apply(null, ys)) / 2
    cards.forEach(function (c) {
      var x = c.x - cx, y = c.y - cy
      pos[c.id] = turn ? { x: -y, y: x, z: 0 } : { x: x, y: y, z: 0 }
    })
    return pos
  }
  var pts = sphere(cards.length)
  var hub = cards.find(function (c) { return c.conductor })
  if (hub) {
    var front = 0
    pts.forEach(function (p, i) { if (p.z < pts[front].z) front = i })
    pos[hub.id] = pts.splice(front, 1)[0]
  }
  cards.filter(function (c) { return c !== hub }).forEach(function (c, i) { pos[c.id] = pts[i] })
  return pos
}
/* a card is a dot: from afar a point of light, zoomed in a small lit sphere with its name */
function dotNode(c, flat) {
  var g = sv('g', 'od ' + c.status + (c.conductor ? ' lead' : ''))
  var r = c.conductor ? 5.5 : 3.8
  var hit = sv('circle', 'hit'); hit.setAttribute('r', '16')
  var glow = sv('circle', 'glow'); glow.setAttribute('r', String(r * 2.1))
  var dot = sv('circle', 'dot'); dot.setAttribute('r', String(r))
  var shine = sv('circle', 'shine'); shine.setAttribute('r', String(r * .42)); shine.setAttribute('cx', String(-r * .34)); shine.setAttribute('cy', String(-r * .34))
  // the flat Graph puts a short name under the dot so neighbours don't collide; the globe puts it beside
  var lbl = sv('text', flat ? 'tag under' : 'tag')
  if (flat) lbl.setAttribute('y', String(r + 12)); else { lbl.setAttribute('x', String(r + 4)); lbl.setAttribute('y', '3.5') }
  var name = split(c.title).name, max = flat ? 11 : 18
  lbl.textContent = name.length > max ? name.slice(0, max - 1) + '…' : name
  ;[hit, glow, dot, shine, lbl].forEach(function (x) { g.appendChild(x) })
  return { g: g, lbl: lbl, shine: shine }
}
function mapView(b) {
  var orbit = state.view === 'orbit'
  var keep = map && map.mode === state.view ? map : null
  stopMap()
  var box = glass('div', 'map' + (orbit ? ' orbit' : ''))
  var svg = sv('svg')
  box.appendChild(svg)
  var dustG = sv('g'), linesG = sv('g'), sparkG = sv('g'), nodesG = sv('g')
  ;[dustG, linesG, sparkG, nodesG].forEach(function (g) { svg.appendChild(g) })
  var tools = el('div', 'tools')
  ;[['+', 1.25, 'Zoom in'], ['−', 0.8, 'Zoom out'], ['⟲', 0, 'Reset the view']].forEach(function (t) {
    var btn = glass('button', '', t[0])
    btn.type = 'button'
    btn.setAttribute('aria-label', t[2])
    btn.addEventListener('click', function (e) {
      e.stopPropagation()
      if (t[1]) map.zoom = Math.max(.5, Math.min(5, map.zoom * t[1]))
      else { map.zoom = 1; map.panX = map.panY = 0; map.rx = -.35; map.ry = 0; map.spin = true; select(null) }
      paint()
    })
    tools.appendChild(btn)
  })
  box.appendChild(tools)
  var laid = layout(b, state.view)
  map = { mode: state.view, box: box, svg: svg, pos: laid, fit: bounds(laid), nodes: {}, lines: [], dust: [], cards: {}, tip: null, sel: null,
    zoom: keep ? keep.zoom : 1, panX: keep ? keep.panX : 0, panY: keep ? keep.panY : 0, rx: keep ? keep.rx : -.35, ry: keep ? keep.ry : 0,
    spin: keep ? keep.spin : true, raf: 0, painted: false, ptrs: {}, moved: 0 }
  b.cards.forEach(function (c) { map.cards[c.id] = c })
  if (orbit) DUST.forEach(function (p) { var d = sv('circle', 'dust'); d.setAttribute('r', '1'); dustG.appendChild(d); map.dust.push({ el: d, p: p }) })
  var now = Date.now()
  var links = linksOf(b).filter(function (l) { return map.cards[l.from] && map.cards[l.to] })
  links.forEach(function (l) {
    var a = map.cards[l.from], z = map.cards[l.to]
    var fired = l.firedAt && now - l.firedAt < 60000
    var live = a.status === 'working' || z.status === 'working'
    var line = sv('line', 'ln ' + l.kind + (fired ? ' fired' : live ? ' live' : ''))
    linesG.appendChild(line)
    // a light runs along a working or just-fired line, from the sender to the receiver
    var spark = null
    if (fired || live) { spark = sv('circle', 'spark' + (fired ? ' hot' : '')); spark.setAttribute('r', fired ? '3' : '2.2'); sparkG.appendChild(spark) }
    map.lines.push({ el: line, from: l.from, to: l.to, spark: spark, speed: fired ? 900 : 1600, phase: Math.random() })
  })
  b.cards.forEach(function (c) {
    var n = dotNode(c, !orbit)
    n.g.setAttribute('data-id', c.id)
    nodesG.appendChild(n.g)
    map.nodes[c.id] = n
  })
  // the how-to shows once per view per visit, not again on every board change
  if (!hinted[state.view]) { hinted[state.view] = true; box.appendChild(el('div', 'hint', orbit ? 'Drag to turn · pinch to zoom · tap a dot' : 'Drag to move · pinch to zoom · tap a dot')) }
  if (orbit) {
    var head = el('div', 'head')
    head.appendChild(el('i'))
    head.appendChild(document.createTextNode('Orbit'))
    head.appendChild(el('small', '', '3D'))
    box.appendChild(head)
    var foot = el('div', 'foot')
    var count = el('span')
    count.appendChild(el('b', '', String(b.cards.length)))
    count.appendChild(document.createTextNode(' cards · '))
    count.appendChild(el('b', '', String(links.length)))
    count.appendChild(document.createTextNode(links.length === 1 ? ' link' : ' links'))
    foot.appendChild(count)
    var keys = el('span', 'keys')
    ;[['working', 'Working'], ['needs-you', 'Needs you'], ['', 'Idle']].forEach(function (k) { var s = el('span'); s.appendChild(el('i', k[0])); s.appendChild(document.createTextNode(k[1])); keys.appendChild(s) })
    foot.appendChild(keys)
    box.appendChild(foot)
    map.tip = el('div', 'tip')
    map.tip.hidden = true
    box.appendChild(map.tip)
    if (keep && keep.sel && map.cards[keep.sel]) select(keep.sel)
  }
  bindGestures(box)
  var mine = map
  map.raf = requestAnimationFrame(function () { loop(mine) })
  return box
}
/* Orbit: the first tap names a card and lights its links; a second tap opens it */
function select(id) {
  if (!map || !map.tip) return
  if (map.sel && map.nodes[map.sel]) map.nodes[map.sel].g.classList.remove('sel')
  map.sel = id
  map.lines.forEach(function (l) {
    var on = !!id && (l.from === id || l.to === id)
    l.el.classList.toggle('hl', on)
    l.el.classList.toggle('dim', !!id && !on)
  })
  map.tip.hidden = !id
  if (!id) return
  map.nodes[id].g.classList.add('sel')
  var c = map.cards[id]
  map.tip.textContent = ''
  map.tip.appendChild(el('div', 'tt', split(c.title).name))
  var st = el('div', 'ts')
  st.appendChild(el('i', c.status))
  st.appendChild(document.createTextNode((LABEL[c.status] || c.status) + (c.conductor ? ' · Conductor' : '')))
  map.tip.appendChild(st)
  var n = map.lines.filter(function (l) { return l.from === id || l.to === id }).length
  map.tip.appendChild(el('div', 'th', n + (n === 1 ? ' link' : ' links') + ' · tap again to open'))
}
function tap(x, y) {
  var hit = document.elementFromPoint(x, y)
  var g = hit && hit.closest ? hit.closest('[data-id]') : null
  var id = g ? g.getAttribute('data-id') : null
  if (map.mode !== 'orbit') { if (id) openCard(id); return }
  if (id && id === map.sel) openCard(id)
  else select(id)
}
/* the half-extent of the laid-out cards on each axis, so Graph fills the box */
function bounds(pos) {
  var hx = 0, hy = 0
  Object.keys(pos).forEach(function (id) { hx = Math.max(hx, Math.abs(pos[id].x)); hy = Math.max(hy, Math.abs(pos[id].y)) })
  return { hx: hx || 1, hy: hy || 1 }
}
function project(p) {
  var m = map
  var x = p.x, y = p.y, z = p.z
  var orbit = m.mode === 'orbit'
  if (orbit) {
    var cy = Math.cos(m.ry), sy = Math.sin(m.ry)
    var x1 = x * cy + z * sy, z1 = -x * sy + z * cy
    var cx = Math.cos(m.rx), sx = Math.sin(m.rx)
    var y1 = y * cx - z1 * sx, z2 = y * sx + z1 * cx
    x = x1; y = y1; z = z2
  }
  var w = m.svg.clientWidth || 340, h = m.svg.clientHeight || 400
  // Graph: one scale that fits the canvas with room for the labels, the right edge clear of the zoom buttons; Orbit: a round globe above the footer
  var scale = (orbit ? Math.min(w / 2 - 26, h / 2 - 50) : Math.min((w / 2 - 64) / m.fit.hx, (h / 2 - 56) / m.fit.hy)) * m.zoom
  var persp = orbit ? 3.2 / (3.2 + z) : 1
  return { x: w / 2 + m.panX + x * scale * persp, y: h / 2 - (orbit ? 12 : 0) + m.panY + y * scale * persp, s: persp, z: z }
}
function paint() {
  if (!map || !map.svg.isConnected) return
  var orbit = map.mode === 'orbit'
  var pts = {}
  Object.keys(map.pos).forEach(function (id) { pts[id] = project(map.pos[id]) })
  map.dust.forEach(function (d) {
    var p = project(d.p)
    d.el.setAttribute('cx', p.x.toFixed(1)); d.el.setAttribute('cy', p.y.toFixed(1))
    d.el.style.opacity = String(Math.max(.08, .5 - p.z * .4))
  })
  var now = Date.now()
  map.lines.forEach(function (l) {
    var a = pts[l.from], b = pts[l.to]
    if (!a || !b) return
    l.el.setAttribute('x1', a.x.toFixed(1)); l.el.setAttribute('y1', a.y.toFixed(1))
    l.el.setAttribute('x2', b.x.toFixed(1)); l.el.setAttribute('y2', b.y.toFixed(1))
    l.el.style.opacity = orbit ? String(Math.max(.3, Math.min(1, 1 - (a.z + b.z) * .35))) : ''
    if (l.spark) {
      var k = (now / l.speed + l.phase) % 1
      l.spark.setAttribute('cx', (a.x + (b.x - a.x) * k).toFixed(1)); l.spark.setAttribute('cy', (a.y + (b.y - a.y) * k).toFixed(1))
      l.spark.style.opacity = String(Math.sin(k * Math.PI).toFixed(2))
    }
  })
  var order = []
  Object.keys(map.nodes).forEach(function (id) {
    var n = map.nodes[id], p = pts[id]
    if (!p) return
    // dots grow as you zoom in, and nearer ones are bigger on the globe
    var s = (orbit ? Math.max(.7, Math.min(1.4, p.s)) : 1) * Math.min(2.6, .75 + map.zoom * .35)
    n.g.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ') scale(' + s.toFixed(3) + ')')
    n.g.style.opacity = orbit ? String(Math.max(.28, Math.min(1, 1.05 - p.z * .6)).toFixed(2)) : ''
    n.shine.style.opacity = String(Math.max(0, Math.min(1, (map.zoom - 1.2) / .8)).toFixed(2))
    // names: always on the flat Graph; on the globe only near the front once zoomed in, plus the Conductor and the picked card
    var named = !orbit || id === map.sel || (p.z < .1 && (map.zoom >= 1.5 || map.cards[id].conductor))
    n.lbl.style.opacity = named ? '' : '0'
    order.push({ g: n.g, z: p.z })
  })
  // nearer cards on top; moved only when the order changes, since moving a node restarts its glow animation
  if (orbit) {
    order.sort(function (a, b) { return b.z - a.z })
    var kids = order.length ? order[0].g.parentNode.childNodes : []
    if (order.some(function (o, i) { return kids[i] !== o.g })) order.forEach(function (o) { o.g.parentNode.appendChild(o.g) })
  }
  if (map.tip && map.sel && pts[map.sel]) {
    var q = pts[map.sel], w = map.svg.clientWidth || 340
    map.tip.style.left = Math.max(90, Math.min(w - 90, q.x)).toFixed(0) + 'px'
    map.tip.style.top = q.y.toFixed(0) + 'px'
    map.tip.classList.toggle('below', q.y < 96)
  }
}
/* one animation loop per map: the globe turns (unless a card is picked or a finger holds it) and the lights run */
function loop(m) {
  if (map !== m) return
  if (!m.svg.isConnected) { stopMap(); return }
  var orbit = m.mode === 'orbit'
  if (orbit && m.spin && !m.sel && !Object.keys(m.ptrs).length) m.ry += .003
  if (!m.painted || orbit || m.lines.some(function (l) { return l.spark })) { paint(); m.painted = true }
  m.raf = requestAnimationFrame(function () { loop(m) })
}
function bindGestures(box) {
  var last = null, pinch = null
  box.addEventListener('pointerdown', function (e) {
    if (!map || (e.target.closest && e.target.closest('.tools'))) return
    // the box keeps the pointer even when it leaves, so a drag that ends outside never sticks
    try { box.setPointerCapture(e.pointerId) } catch (err) {}
    map.ptrs[e.pointerId] = { x: e.clientX, y: e.clientY }
    map.moved = 0
    last = { x: e.clientX, y: e.clientY }
    var ids = Object.keys(map.ptrs)
    if (ids.length === 2) { var a = map.ptrs[ids[0]], b = map.ptrs[ids[1]]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: map.zoom } }
  })
  box.addEventListener('pointermove', function (e) {
    if (!map || !map.ptrs[e.pointerId]) return
    map.ptrs[e.pointerId] = { x: e.clientX, y: e.clientY }
    var ids = Object.keys(map.ptrs)
    if (ids.length === 2 && pinch) {
      var a = map.ptrs[ids[0]], b = map.ptrs[ids[1]]
      map.zoom = Math.max(.5, Math.min(5, pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d))
      map.moved = 99
    } else if (last) {
      var dx = e.clientX - last.x, dy = e.clientY - last.y
      map.moved += Math.abs(dx) + Math.abs(dy)
      if (map.mode === 'orbit') { map.ry += dx * .008; map.rx = Math.max(-1.2, Math.min(1.2, map.rx + dy * .008)); if (map.moved >= 8) map.spin = false }
      else { map.panX += dx; map.panY += dy }
      last = { x: e.clientX, y: e.clientY }
    }
    if (map.mode !== 'orbit') paint()
  })
  function up(e) {
    if (!map || !map.ptrs[e.pointerId]) return
    delete map.ptrs[e.pointerId]
    if (Object.keys(map.ptrs).length < 2) pinch = null
    last = null
    // a tap is handled here, not by click: the pointer is captured by the box, and the globe re-orders its dots every frame
    if (e.type === 'pointerup' && map.moved < 8 && !Object.keys(map.ptrs).length) tap(e.clientX, e.clientY)
  }
  box.addEventListener('pointerup', up)
  box.addEventListener('pointercancel', up)
  box.addEventListener('wheel', function (e) { e.preventDefault(); if (!map) return; map.zoom = Math.max(.5, Math.min(5, map.zoom * (e.deltaY < 0 ? 1.1 : .9))); paint() }, { passive: false })
}

/* ---------- inbox ---------- */
function kind(text) { return el('div', 'kind', text) }
function drawQuestion(q) {
  var box = glass('div', 'item')
  box.appendChild(kind('Question'))
  box.appendChild(el('div', 'q', q.question))
  box.appendChild(el('div', 'from', split(q.title).name + (q.project ? ' · ' + q.project : '')))
  var note = el('textarea', 'field')
  note.rows = 1
  note.placeholder = 'Add a note (optional)'
  note.maxLength = 1000
  note.value = notes[q.id] || ''
  note.addEventListener('input', function () { notes[q.id] = note.value })
  box.appendChild(note)
  var row = el('div', 'actions')
  q.answers.forEach(function (a, i) {
    var btn = el('button', 'btn' + (i === 0 ? ' primary' : ''), a)
    btn.type = 'button'
    btn.addEventListener('click', function () {
      lock(row)
      send('decisions/' + encodeURIComponent(q.id), { answer: a, note: note.value.trim() || undefined }, 'Answered: ' + a).then(function () { delete notes[q.id] })
    })
    row.appendChild(btn)
  })
  box.appendChild(row)
  return box
}
function drawApproval(a) {
  var box = glass('div', 'item')
  box.appendChild(kind('Approval'))
  box.appendChild(el('div', 'from', split(a.title).name + (a.project ? ' · ' + a.project : '') + ' wants to run'))
  box.appendChild(el('div', 'cmd', a.command))
  var row = el('div', 'actions')
  var deny = el('button', 'btn danger', 'Deny')
  deny.type = 'button'
  deny.addEventListener('click', function () { lock(row); send('approvals/' + encodeURIComponent(a.id), { approve: false }, 'Denied') })
  var ok = el('button', 'btn primary', 'Approve once')
  ok.type = 'button'
  ok.addEventListener('click', function () {
    confirmSheet('Allow this once?', a.command, 'Approve once', function () { lock(row); send('approvals/' + encodeURIComponent(a.id), { approve: true }, 'Approved once') })
  })
  row.appendChild(deny)
  row.appendChild(ok)
  box.appendChild(row)
  return box
}
function permissionButtons(c, onDone) {
  var row = el('div', 'actions')
  ;[['1', 'Yes', 'btn primary'], ['3', 'No', 'btn'], ['esc', 'Esc', 'btn danger']].forEach(function (k) {
    var b = el('button', k[2], k[1])
    b.type = 'button'
    b.addEventListener('click', function () {
      lock(row)
      send('cards/' + encodeURIComponent(c.id) + '/answer', { key: k[0], promptAt: c.promptAt }, 'Sent ' + k[1]).then(function () { if (onDone) onDone() })
    })
    row.appendChild(b)
  })
  return row
}
function drawPermission(c) {
  var box = glass('div', 'item')
  box.appendChild(kind('Permission prompt'))
  box.appendChild(el('div', 'q', split(c.title).name))
  box.appendChild(el('div', 'from', c.detail || 'waiting on a prompt in its terminal'))
  box.appendChild(permissionButtons(c))
  return box
}
function drawInbox(v, b) {
  var qs = b.decisions || []
  var as = b.approvals || []
  var ps = b.cards.filter(function (c) { return c.permission })
  if (!qs.length && !as.length && !ps.length) { v.appendChild(empty('All clear', 'Nothing waits on you right now.', true)); return }
  qs.forEach(function (q) { v.appendChild(drawQuestion(q)) })
  as.forEach(function (a) { v.appendChild(drawApproval(a)) })
  ps.forEach(function (c) { v.appendChild(drawPermission(c)) })
}

/* ---------- report ---------- */
function markdown(md) {
  var doc = glass('div', 'doc')
  var list = null
  var code = null
  md.split('\\n').forEach(function (line) {
    if (/^\\s*\`\`\`/.test(line)) { if (code) { doc.appendChild(code); code = null } else code = el('pre'); return }
    if (code) { code.textContent += line + '\\n'; return }
    var m
    if ((m = /^\\s*[-*]\\s+(.*)$/.exec(line))) { if (!list) { list = el('ul'); doc.appendChild(list) } list.appendChild(el('li', '', strip(m[1]))); return }
    list = null
    if ((m = /^(#{1,2})\\s+(.*)$/.exec(line))) doc.appendChild(el('h3', '', strip(m[2])))
    else if ((m = /^#{3,6}\\s+(.*)$/.exec(line))) doc.appendChild(el('h4', '', strip(m[1])))
    else if (line.trim()) doc.appendChild(el('p', '', strip(line)))
  })
  if (code) doc.appendChild(code)
  return doc
}
function strip(s) { return s.replace(/\\*\\*([^*]+)\\*\\*/g, '$1').replace(/\`([^\`]+)\`/g, '$1').replace(/\\[([^\\]]+)\\]\\([^)]*\\)/g, '$1') }
function drawReport(v) {
  if (state.report === null) {
    v.appendChild(el('div', 'skeleton')); v.appendChild(el('div', 'skeleton'))
    api('GET', 'report/latest').then(function (r) { state.report = r.markdown || ''; draw() }).catch(function (e) { state.report = ''; toast(e.message, true); draw() })
  } else if (!state.report) v.appendChild(empty('No report yet', 'The morning report of an autonomous run shows up here.'))
  else v.appendChild(markdown(state.report))
  var refresh = glass('button', 'btn wide', 'Refresh report')
  refresh.type = 'button'
  refresh.addEventListener('click', function () { state.report = null; draw() })
  v.appendChild(refresh)
  var unpair = glass('button', 'linkish', 'Unpair this phone')
  unpair.type = 'button'
  unpair.addEventListener('click', function () {
    confirmSheet('Unpair this phone?', 'You will need a new code from Settings → Phone on the PC.', 'Unpair', function () { setToken(''); state.board = null; closeSheet(); draw() }, true)
  })
  v.appendChild(unpair)
}

/* ---------- sheets ---------- */
function openSheet(fill) {
  var body = $('sheet-body')
  body.textContent = ''
  fill(body)
  $('sheet').hidden = false
}
function closeSheet() { $('sheet').hidden = true; state.sheet = null }
function confirmSheet(title, detail, yes, onYes, danger) {
  state.sheet = { kind: 'confirm' }
  openSheet(function (b) {
    b.appendChild(el('div', 't', title))
    b.appendChild(el('div', 'cmd', detail))
    var row = el('div', 'actions')
    var no = el('button', 'btn', 'Cancel')
    no.type = 'button'
    no.addEventListener('click', closeSheet)
    var ok = el('button', 'btn ' + (danger ? 'danger' : 'primary'), yes)
    ok.type = 'button'
    ok.addEventListener('click', function () { closeSheet(); onYes() })
    row.appendChild(no)
    row.appendChild(ok)
    b.appendChild(row)
  })
}
function openCard(id) { state.sheet = { kind: 'card', id: id }; drawCardSheet(true) }
function drawCardSheet(fresh) {
  var c = state.board && state.board.cards.find(function (x) { return x.id === state.sheet.id })
  if (!c) { closeSheet(); return }
  var typing = document.activeElement && document.activeElement.id === 'composer'
  if (typing && !fresh) {
    var r = $('sheet-reply')
    if (r && r.textContent !== (c.last || 'No reply yet.')) r.textContent = c.last || 'No reply yet.'
    return
  }
  openSheet(function (b) {
    var head = el('div', 'sheet-head')
    head.appendChild(avatar(c))
    var hb = el('div', 'body')
    hb.appendChild(el('div', 't', split(c.title).name))
    hb.appendChild(el('div', 'd', (LABEL[c.status] || c.status) + (c.detail ? ' · ' + c.detail : '')))
    head.appendChild(hb)
    b.appendChild(head)
    if (c.permission) {
      b.appendChild(el('div', 'label', 'Permission prompt'))
      b.appendChild(permissionButtons(c, closeSheet))
    }
    b.appendChild(el('div', 'label', 'Last reply'))
    var reply = el('div', 'reply', c.last || 'No reply yet.')
    reply.id = 'sheet-reply'
    b.appendChild(reply)
    if (c.promptable) {
      var ta = el('textarea', 'field')
      ta.id = 'composer'
      ta.rows = 2
      ta.placeholder = 'Message ' + split(c.title).name
      ta.value = drafts[c.id] || ''
      ta.addEventListener('input', function () { drafts[c.id] = ta.value })
      b.appendChild(ta)
      var row = el('div', 'actions')
      var sendBtn = el('button', 'btn primary', 'Send')
      sendBtn.type = 'button'
      sendBtn.addEventListener('click', function () {
        var text = ta.value.trim()
        if (!text) return
        sendBtn.disabled = true
        send('cards/' + encodeURIComponent(c.id) + '/prompt', { text: text }, 'Sent to ' + split(c.title).name).then(function (ok) {
          sendBtn.disabled = false
          if (ok) { drafts[c.id] = ''; ta.value = ''; ta.blur() }
        })
      })
      row.appendChild(sendBtn)
      b.appendChild(row)
    } else if (!c.permission) b.appendChild(el('div', 'note', c.status === 'needs-you' ? 'It waits on a prompt; answer that first.' : 'This card is not running, so it cannot take a message.'))
  })
}
function lock(row) { row.querySelectorAll('button').forEach(function (x) { x.disabled = true }) }
function empty(title, text, ok) {
  var box = el('div', 'empty')
  if (ok) { var i = el('div', 'icon'); i.appendChild(checkIcon()); box.appendChild(i) }
  box.appendChild(el('h3', '', title))
  box.appendChild(el('div', '', text))
  return box
}

/* ---------- frame ---------- */
function go(tab) {
  // a finger left on the map does not hold the old tab on screen
  if (map) map.ptrs = {}
  state.tab = tab
  state.json = ''
  if (tab === 'report') state.report = null
  window.scrollTo(0, 0)
  draw()
}
function drawPair(v) {
  var hero = el('div', 'hero')
  var img = el('img')
  img.src = '/m/icon.png'
  img.alt = ''
  hero.appendChild(img)
  hero.appendChild(el('h1', '', 'Your board, in your pocket'))
  hero.appendChild(el('p', '', 'Pair this phone with Ouroboros on your PC.'))
  var steps = el('ol', 'steps')
  ;['Open Ouroboros on the PC', 'Settings → Phone → Pair a phone', "Scan the code with this phone's camera"].forEach(function (s) { steps.appendChild(glass('li', '', s)) })
  hero.appendChild(steps)
  v.appendChild(hero)
}
/* the tab bar, the Inbox badge and the page title */
function chrome() {
  $('tabs').hidden = !token()
  var n = needs(state.board)
  var badge = $('badge')
  badge.hidden = !n
  badge.textContent = n > 9 ? '9+' : String(n)
  document.title = (n ? '(' + n + ') ' : '') + 'Ouroboros'
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.classList.toggle('on', t.getAttribute('data-tab') === state.tab) })
}
function draw() {
  chrome()
  var v = $('view')
  var paired = !!token()
  var b = state.board
  // a half-typed note or message stays put while the board refreshes
  var active = document.activeElement
  // a skipped draw forgets the board it skipped, so the next poll draws it
  if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') && v.contains(active)) { state.json = ''; return }
  // the map is not redrawn while a finger is on it
  if (map && Object.keys(map.ptrs).length) { state.json = ''; return }
  if (state.tab !== 'board' || !b || !paired) stopMap()
  v.textContent = ''
  if (!paired) { $('sub').textContent = 'Not paired'; drawPair(v); return }
  if (!b) { v.appendChild(el('div', 'skeleton')); v.appendChild(el('div', 'skeleton')); v.appendChild(el('div', 'skeleton')); return }
  if (state.tab === 'board') drawBoard(v, b)
  else if (state.tab === 'inbox') drawInbox(v, b)
  else drawReport(v)
}
function setLive(ok, text) {
  $('live').className = 'live ' + (ok ? 'on' : 'off')
  $('sub').textContent = text
}
var inFlight = false
function tick() {
  if (!token()) { draw(); return }
  if (inFlight) return
  inFlight = true
  api('GET', 'board')
    .then(function (b) {
      // nothing new: leave the page alone (no flicker, a scrolled list or a turned orbit stays as it is)
      var json = JSON.stringify(b)
      var same = json === state.json
      state.json = json
      state.board = b
      var n = needs(b)
      if (state.seenNeeds >= 0 && n > state.seenNeeds && navigator.vibrate) navigator.vibrate([30, 60, 30])
      state.seenNeeds = n
      setLive(true, (b.project || 'No project') + (b.autonomous ? ' · autonomous' : ''))
      // the report does not change with the board; elsewhere only a change is drawn
      if (state.tab === 'report' || same) chrome()
      else draw()
      if (!same && state.sheet && state.sheet.kind === 'card' && !$('sheet').hidden) drawCardSheet(false)
    })
    .catch(function (e) { setLive(false, e.message) })
    .then(function () { inFlight = false })
}
Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.addEventListener('click', function () { go(t.getAttribute('data-tab')) }) })
$('sheet').addEventListener('click', function (e) { if (e.target.getAttribute && e.target.getAttribute('data-close')) closeSheet() })
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet() })
pairFromHash().then(function () { draw(); tick(); setInterval(tick, 3000) })
document.addEventListener('visibilitychange', function () { if (!document.hidden) tick() })
`
