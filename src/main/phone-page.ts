/**
 * The phone page: static HTML, CSS and JS served by the phone server under /m. No build step, no CDN, no inline
 * script (the CSP is default-src 'self'); everything from the board is put on the page as text, never as HTML.
 */

export const PHONE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0a0a">
<link rel="manifest" href="/m/manifest.json">
<link rel="stylesheet" href="/m/app.css">
<title>Ouroboros</title>
</head>
<body>
<header><b>Ouroboros</b><span id="state" class="muted"></span></header>
<main>
  <section id="pair" hidden>
    <p>Open Ouroboros on your PC: Settings → Phone → <b>Pair a phone</b>, and scan the code with this phone's camera.</p>
  </section>
  <section id="questions" hidden><h2>Questions</h2><div id="question-list"></div></section>
  <section id="approvals" hidden><h2>Approvals</h2><div id="approval-list"></div></section>
  <section id="cards"><div id="card-list"></div></section>
  <section id="report-box" hidden><h2>Morning report</h2><pre id="report"></pre></section>
</main>
<footer><button id="report-btn" type="button">Latest report</button><button id="forget" type="button" class="quiet">Unpair this phone</button></footer>
<script src="/m/app.js"></script>
</body>
</html>
`

export const PHONE_CSS = `:root { color-scheme: dark; --bg: #0a0a0a; --panel: #171717; --panel2: #262626; --text: #e5e5e5; --muted: #a3a3a3; --needs: #ff6900; --working: #3b82f6; --ok: #22c55e; --danger: #ef4444; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; padding-bottom: env(safe-area-inset-bottom); }
header { position: sticky; top: 0; display: flex; gap: 10px; align-items: baseline; padding: 12px 16px; background: var(--bg); border-bottom: 1px solid var(--panel2); z-index: 1; }
main { padding: 8px 16px 80px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 18px 0 8px; }
.muted { color: var(--muted); font-size: 13px; }
.card { background: var(--panel); border-radius: 10px; padding: 12px; margin: 8px 0; border-left: 3px solid var(--panel2); }
.card.needs { border-left-color: var(--needs); }
.card.working { border-left-color: var(--working); }
.card .head { display: flex; justify-content: space-between; gap: 8px; }
.card .title { font-weight: 600; }
.card .detail { color: var(--muted); font-size: 13px; margin-top: 2px; word-break: break-word; }
.card pre, #report { white-space: pre-wrap; word-break: break-word; background: var(--bg); padding: 8px; border-radius: 6px; font-size: 12.5px; max-height: 40vh; overflow: auto; }
textarea { width: 100%; min-height: 64px; background: var(--panel2); color: var(--text); border: 1px solid transparent; border-radius: 8px; padding: 8px; font: inherit; }
button { min-height: 44px; min-width: 44px; padding: 0 14px; border-radius: 8px; border: 0; background: var(--panel2); color: var(--text); font: inherit; }
button.primary { background: var(--text); color: var(--bg); font-weight: 600; }
button.danger { color: var(--danger); }
button.quiet { background: transparent; color: var(--muted); }
.row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
footer { position: fixed; bottom: 0; left: 0; right: 0; display: flex; justify-content: space-between; gap: 8px; padding: 8px 16px calc(8px + env(safe-area-inset-bottom)); background: var(--bg); border-top: 1px solid var(--panel2); }
code { word-break: break-all; font-size: 12.5px; }
.error { color: var(--danger); font-size: 13px; }
`

export const PHONE_MANIFEST = JSON.stringify({ name: 'Ouroboros', short_name: 'Ouroboros', start_url: '/m', display: 'standalone', background_color: '#0a0a0a', theme_color: '#0a0a0a' })

export const PHONE_JS = `'use strict'
var KEY = 'ouroboros-phone-token'
var open = {}
var drafts = {}
function token() { try { return localStorage.getItem(KEY) || '' } catch (e) { return '' } }
function setToken(t) { try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY) } catch (e) {} }
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
function $(id) { return document.getElementById(id) }
function api(method, path, body) {
  return fetch('/m/api/' + path, { method: method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token() }, body: body ? JSON.stringify(body) : undefined })
    .then(function (r) {
      if (r.status === 401) { setToken(''); render(null); throw new Error('This phone is no longer paired') }
      return r.text().then(function (s) {
        var j = {}
        try { j = s ? JSON.parse(s) : {} } catch (e) {}
        if (!r.ok) throw new Error(j.error || (r.status === 403 || r.status === 421 ? 'The PC refused this phone (network or address changed in Settings)' : 'error ' + r.status))
        return j
      })
    })
}
function pairFromHash() {
  var m = /pair=([^&]+)/.exec(location.hash)
  if (!m) return Promise.resolve()
  var code = decodeURIComponent(m[1])
  history.replaceState(null, '', '/m')
  var name = prompt('Name this phone (shown in Ouroboros Settings):', 'Phone') || 'Phone'
  return fetch('/m/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code, name: name }) })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'pairing failed'); setToken(j.token) }) })
    .catch(function (e) { alert(e.message) })
}
function cardClass(c) { return c.status === 'needs-you' ? 'card needs' : c.status === 'working' ? 'card working' : 'card' }
function renderCard(c) {
  var box = el('div', cardClass(c))
  var head = el('div', 'head')
  head.appendChild(el('span', 'title', c.title))
  head.appendChild(el('span', 'muted', c.status))
  box.appendChild(head)
  if (c.detail) box.appendChild(el('div', 'detail', c.detail))
  head.addEventListener('click', function () { open[c.id] = !open[c.id]; tick() })
  if (c.permission) {
    var row = el('div', 'row')
    ;[['1', 'Yes'], ['3', 'No'], ['esc', 'Esc']].forEach(function (k) {
      var b = el('button', k[0] === '1' ? 'primary' : '', k[1])
      b.addEventListener('click', function () {
        row.querySelectorAll('button').forEach(function (x) { x.disabled = true })
        send('cards/' + encodeURIComponent(c.id) + '/answer', { key: k[0], promptAt: c.promptAt })
      })
      row.appendChild(b)
    })
    box.appendChild(row)
  }
  if (open[c.id]) {
    if (c.last) box.appendChild(el('pre', '', c.last))
    if (c.promptable) {
      var ta = el('textarea')
      ta.placeholder = 'Message ' + c.title
      ta.value = drafts[c.id] || ''
      ta.addEventListener('input', function () { drafts[c.id] = ta.value })
      box.appendChild(ta)
      var row2 = el('div', 'row')
      var sendBtn = el('button', 'primary', 'Send')
      sendBtn.addEventListener('click', function () {
        var text = ta.value.trim()
        if (!text) return
        send('cards/' + encodeURIComponent(c.id) + '/prompt', { text: text }).then(function (ok) { if (ok) { drafts[c.id] = ''; ta.value = '' } })
      })
      row2.appendChild(sendBtn)
      box.appendChild(row2)
    }
  }
  return box
}
function renderApproval(a) {
  var box = el('div', 'card needs')
  var head = el('div', 'head')
  head.appendChild(el('span', 'title', a.title))
  head.appendChild(el('span', 'muted', a.id))
  box.appendChild(head)
  box.appendChild(el('code', '', a.command))
  var row = el('div', 'row')
  var deny = el('button', 'danger', 'Deny')
  deny.addEventListener('click', function () { send('approvals/' + encodeURIComponent(a.id), { approve: false }) })
  var ok = el('button', 'primary', 'Approve once')
  ok.addEventListener('click', function () { if (confirm('Allow once: ' + a.command)) send('approvals/' + encodeURIComponent(a.id), { approve: true }) })
  row.appendChild(deny)
  row.appendChild(ok)
  box.appendChild(row)
  return box
}
function renderQuestion(q) {
  var box = el('div', 'card needs')
  var head = el('div', 'head')
  head.appendChild(el('span', 'title', q.title))
  head.appendChild(el('span', 'muted', (q.project ? q.project + ' · ' : '') + q.id))
  box.appendChild(head)
  box.appendChild(el('div', 'last', q.question))
  var note = el('input', '')
  note.placeholder = 'Note (optional)'
  note.maxLength = 1000
  box.appendChild(note)
  var row = el('div', 'row')
  q.answers.forEach(function (a, i) {
    var b = el('button', i === 0 ? 'primary' : '', a)
    b.addEventListener('click', function () { send('decisions/' + encodeURIComponent(q.id), { answer: a, note: note.value.trim() || undefined }) })
    row.appendChild(b)
  })
  box.appendChild(row)
  return box
}
function send(path, body) {
  return api('POST', path, body).then(function () { tick(); return true }).catch(function (e) { alert(e.message); return false })
}
function render(board) {
  $('pair').hidden = !!token()
  $('cards').hidden = !token()
  $('forget').hidden = !token()
  $('report-btn').hidden = !token()
  if (!board) { $('approvals').hidden = true; $('questions').hidden = true; $('card-list').textContent = ''; return }
  $('state').textContent = board.project ? board.project + (board.autonomous ? ' · autonomous' : '') : ''
  var qs = $('question-list')
  var typing = document.activeElement && document.activeElement.tagName === 'INPUT' && qs.contains(document.activeElement)
  if (!typing) {
    qs.textContent = ''
    ;(board.decisions || []).forEach(function (q) { qs.appendChild(renderQuestion(q)) })
  }
  $('questions').hidden = !(board.decisions || []).length
  var list = $('approval-list')
  list.textContent = ''
  board.approvals.forEach(function (a) { list.appendChild(renderApproval(a)) })
  $('approvals').hidden = board.approvals.length === 0
  var cards = $('card-list')
  if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return
  cards.textContent = ''
  board.cards.forEach(function (c) { cards.appendChild(renderCard(c)) })
  if (!board.cards.length) cards.appendChild(el('p', 'muted', 'No cards on the board.'))
}
var timer = null
var inFlight = false
function tick() {
  if (!token()) { render(null); return }
  if (inFlight) return
  inFlight = true
  api('GET', 'board').then(render).catch(function (e) { $('state').textContent = e.message }).then(function () { inFlight = false })
}
$('report-btn').addEventListener('click', function () {
  api('GET', 'report/latest').then(function (r) { $('report-box').hidden = false; $('report').textContent = r.markdown || 'No morning report yet.' }).catch(function (e) { alert(e.message) })
})
$('forget').addEventListener('click', function () { if (confirm('Unpair this phone? You will need a new code from the PC.')) { setToken(''); render(null) } })
pairFromHash().then(function () { tick(); timer = setInterval(tick, 3000) })
document.addEventListener('visibilitychange', function () { if (!document.hidden) tick() })
`
