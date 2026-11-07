// tests/pay_tax_test.mjs
//
// Tax Pack P8, the website half (DN60, DN66): pay.html's Sales tax row and
// pay-result.html's tax_unavailable copy.
//
//   node tests/pay_tax_test.mjs [--shots <dir>]
//
// Real headless Chrome, driven over DevTools with Node's own WebSocket, against
// STUBBED replies: fetch and Stripe are replaced, so nothing here reaches a
// Supabase project or Stripe, and no card field is ever mounted.
//
// Four things it proves:
//   1. With a prod-shaped reply the rendered page, minus its scripts, is byte
//      for byte what BASE_SHA rendered, and pixel for pixel at two widths.
//   2. Each tax reply renders the rows it should, and they add up to the Total.
//   3. Today's page (BASE_SHA) fails the tax checks, so they test something.
//   4. Every mutant is caught by the check named for it, and every check fails
//      under something. The run exits non-zero otherwise.
//
// taxUnknown is proved ONLY here, against a stub: a healthy server can't produce
// it, so no staging render covers that case. The staging render of the taxed and
// certificate replies is a separate step, not this file.
//
// No npm dependencies, on purpose. Do NOT add a package.json at the repo root to
// run this: the root is what Cloudflare Pages deploys, and a package.json could
// start an install in that build.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_SHA = '9c9b2a6'; // what the live site served when this was written
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LANE = process.env.GG_TAX_LANE ?? resolve(REPO, '../.claude/worktrees/tax-pack-stage-4');
const STAGING = 'https://atocyakoajynffvpeyis.supabase.co';
const STRIPE_TAG = '<script src="https://js.stripe.com/v3/"></script>';
const BANNED = /Taxes (&|&amp;|and) fees|Fees (&|&amp;) taxes|Estimated tax/i;

// Copied here so a change to a source of truth has to be made on purpose;
// sourcesOfTruth() below compares them with the files they come from.
const TAX_UNAVAILABLE = "We couldn't work out the sales tax for this farm, so your order wasn't placed. Please try again later.";
const FOOTER = 'Sales tax on marketplace orders is collected and remitted by Growing Green (Mana Softworks LLC, SC retail license on file). Fees are listed by name above; none of them is a government charge.';
const RESALE = 'Resale certificate on file';
const LABEL = 'SC/Anderson Co. · 0% on food · 7% on other items';
const ATTACK = '<img src=x onerror="window.__xss=true">';

// ── Replies ──────────────────────────────────────────────────────────────────

// The key set of prod's deployed payment-checkout (v14, read 2026-11-06).
const order = (over = {}) => ({
  ok: true, orderRef: 'ABCD1234', farmName: 'Test Farm', customerName: 'Test Buyer',
  totalCents: 5460, serviceFeeCents: 260, subtotalCents: 5200,
  items: [{ name: 'Tomatoes', qty: 2, priceCents: 1200 }, { name: 'Soap', qty: 2, priceCents: 1400 }],
  pk: 'pk_test_stub', stripeAccount: 'acct_stub', ...over,
});
const without = (o, key) => { const c = { ...o }; delete c[key]; return c; };
const delivery = (cents) => ({ deliveryFeeCents: cents, fulfillmentMethod: 'delivery' });
const REJECT = Symbol('network failure');

// Must render exactly as BASE_SHA does.
const SAME = [
  { id: 'p.fee', reply: order() },
  { id: 'p.nofee', reply: order({ totalCents: 5200, serviceFeeCents: 0 }) },
  { id: 'p.delivery', reply: order({ totalCents: 6460, ...delivery(1000) }) },
  { id: 'p.waived', reply: order(delivery(0)) },
  { id: 'p.wsdelivery', reply: order({ totalCents: 6200, serviceFeeCents: 0, ...delivery(1000) }) },
  { id: 'p.oldfn', reply: without(order(), 'subtotalCents') },
  { id: 'p.markup', reply: order({ farmName: `${ATTACK}Farm`, customerName: ATTACK }) },
  { id: 'p.notfound', reply: { ok: false, code: 'not_found' } },
  { id: 'p.cancelled', reply: { ok: false, code: 'cancelled' } },
  { id: 'p.already', reply: { ok: false, code: 'already' } },
  { id: 'p.unavailable', reply: { ok: false, code: 'unavailable' } },
  { id: 'p.unknowncode', reply: { ok: false, code: 'nope' } },
  { id: 'p.empty', reply: null },
  { id: 'p.network', reply: REJECT },
  { id: 'p.nosecret', reply: order(), query: { secret: '' } },
  { id: 'p.badapi', reply: order(), query: { api: 'https://theirs.supabase.co' } },
  { id: 'p.nulls', reply: order({ taxCents: null, taxNote: null, taxFooter: null, taxUnknown: null }) },
  { id: 'p.false', reply: order({ taxUnknown: false }) },
];

const SUB = ['Subtotal', '$52.00'];
const SVC = ['Service fee', '$2.60'];
const TAX = ['Sales tax', '$1.76'];
const PICKUP = 'Your card will not be charged now. It is charged when Test Farm confirms your order is ready.';
const DELIVERED = 'Your card will not be charged now. It is charged when Test Farm confirms your order is ready for delivery.';

// t11 to t14 are shapes the server never sends; the page stays safe on them anyway.
const TAXED = [
  { id: 't1', why: 'taxed, the M4.2 Quick Order figures',
    reply: order({ totalCents: 5636, taxCents: 176, taxNote: LABEL, taxFooter: FOOTER }),
    rows: [SUB, SVC, TAX, LABEL], total: '$56.36', footer: FOOTER },
  { id: 't2', why: 'taxed, no fee and no delivery (a wholesale pay link)',
    reply: order({ totalCents: 5564, serviceFeeCents: 0, taxCents: 364, taxNote: LABEL }),
    rows: [SUB, ['Sales tax', '$3.64'], LABEL], total: '$55.64', footer: null },
  { id: 't3', why: 'taxed, with a delivery fee',
    reply: order({ totalCents: 6636, ...delivery(1000), taxCents: 176, taxNote: LABEL, taxFooter: FOOTER }),
    rows: [SUB, SVC, ['Delivery fee', '$10.00'], TAX, LABEL], total: '$66.36', footer: FOOTER, sentence: DELIVERED },
  { id: 't4', why: 'taxed, delivery waived',
    reply: order({ totalCents: 5636, ...delivery(0), taxCents: 176, taxNote: LABEL, taxFooter: FOOTER }),
    rows: [SUB, SVC, ['Delivery', 'Free'], TAX, LABEL], total: '$56.36', footer: FOOTER, sentence: DELIVERED },
  { id: 't5', why: 'a certificate holder\'s $0, no fee',
    reply: order({ totalCents: 5200, serviceFeeCents: 0, taxCents: 0, taxNote: RESALE }),
    rows: [SUB, ['Sales tax', '$0.00'], RESALE], total: '$52.00', footer: null },
  { id: 't6', why: 'a certificate holder\'s $0, with a fee',
    reply: order({ taxCents: 0, taxNote: RESALE }),
    rows: [SUB, SVC, ['Sales tax', '$0.00'], RESALE], total: '$54.60', footer: null },
  { id: 't7', why: 'the farm remits: a row and no footer',
    reply: order({ totalCents: 5636, taxCents: 176, taxNote: LABEL }),
    rows: [SUB, SVC, TAX, LABEL], total: '$56.36', footer: null },
  { id: 't8', why: 'rates unreadable: a row and no note',
    reply: order({ totalCents: 5636, taxCents: 176 }),
    rows: [SUB, SVC, TAX], total: '$56.36', footer: null },
  { id: 't9', why: 'taxUnknown, with a fee: the total alone',
    reply: order({ totalCents: 5636, taxUnknown: true }),
    rows: [], total: '$56.36', footer: null },
  { id: 't10', why: 'taxUnknown, with delivery: the total alone',
    reply: order({ totalCents: 6636, ...delivery(1000), taxUnknown: true }),
    rows: [], total: '$66.36', footer: null, sentence: DELIVERED },
  { id: 't11', why: 'taxUnknown beside the other tax keys: it wins',
    reply: order({ totalCents: 5636, taxUnknown: true, taxCents: 176, taxNote: LABEL, taxFooter: FOOTER }),
    rows: [], total: '$56.36', footer: null },
  { id: 't12', why: 'a footer with no tax row: not shown',
    reply: order({ taxFooter: FOOTER }),
    rows: [SUB, SVC], total: '$54.60', footer: null },
  { id: 't13', why: 'an older function with no subtotalCents',
    reply: without(order({ totalCents: 5636, taxCents: 176, taxNote: LABEL }), 'subtotalCents'),
    rows: [SUB, SVC, TAX, LABEL], total: '$56.36', footer: null },
  { id: 't14', why: 'markup in the tax text stays text',
    reply: order({ totalCents: 5636, taxCents: 176, taxNote: `${ATTACK}note`, taxFooter: `${ATTACK}foot` }),
    rows: [SUB, SVC, TAX, `${ATTACK}note`], total: '$56.36', footer: `${ATTACK}foot`, attack: true },
];

const ITEMS = [['Tomatoes', '2', '$12.00'], ['Soap', '2', '$14.00']];

// ── Sources ──────────────────────────────────────────────────────────────────

// LF, as git holds and Cloudflare serves it: with core.autocrlf a working file
// can be CRLF, which would show up as a byte difference in every text node.
const lf = (s) => s.replace(/\r\n/g, '\n');
const current = (file) => lf(readFileSync(join(REPO, file), 'utf8'));
const atBase = (file) => lf(execFileSync('git', ['-C', REPO, 'show', `${BASE_SHA}:${file}`], { encoding: 'utf8' }));
const noInlineScript = (html) => html.replace(/<script>[\s\S]*<\/script>/, '');

const PAY_NOW = current('pay.html');
const RESULT_NOW = current('pay-result.html');
const PAY_BASE = atBase('pay.html');
const RESULT_BASE = atBase('pay-result.html');

// Every code on today's page, each of which must render as it does today.
const CODES = [...RESULT_BASE.matchAll(/^\s+([a-z_]+):\s*\['/gm)].map((m) => m[1]);
const RESULT_SAME = [
  ...CODES.map((s) => ({ id: `r.other.${s}`, query: `s=${s}` })),
  { id: 'r.other.none', query: '' },
  { id: 'r.other.unknown', query: 's=nope' },
  { id: 'r.other.confirmed-amt', query: 's=order_confirmed&amt=1234&ref=ORD-12' },
  { id: 'r.other.approved-amt', query: 's=sub_approved&amt=999' },
  { id: 'r.other.declined-amt', query: 's=sub_declined&amt=999' },
  { id: 'r.other.cta', query: `s=paid_ach&ctaLabel=pay_by_card&cta=${encodeURIComponent('https://growinggreen.app/x')}` },
];

// ── Chrome over DevTools ─────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.calls = new Map();
    this.waiters = [];
    ws.addEventListener('message', (e) => this.receive(JSON.parse(e.data)));
  }
  receive(m) {
    if (m.id) {
      const call = this.calls.get(m.id);
      this.calls.delete(m.id);
      if (m.error) call.reject(new Error(m.error.message));
      else call.resolve(m.result);
      return;
    }
    this.waiters = this.waiters.filter((w) => {
      if (w.method !== m.method) return true;
      clearTimeout(w.timer);
      w.resolve(m.params);
      return false;
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  next(method, ms = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), ms);
      this.waiters.push({ method, resolve, timer });
    });
  }
}

let cdp;
let session;
let chrome;
let profile;
let server;
let port;

async function startChrome() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_PATH`);
  profile = mkdtempSync(join(tmpdir(), 'gg-pay-test-'));
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-device-scale-factor=1', '--remote-debugging-port=0',
    '--remote-allow-origins=*', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  let lines = [];
  for (let i = 0; i < 400 && lines.length < 2; i++) {
    await sleep(50);
    if (existsSync(portFile)) lines = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  }
  if (lines.length < 2) throw new Error('Chrome did not open its DevTools port');
  const ws = new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('could not reach Chrome')));
  });
  cdp = new Cdp(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId: session } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  await cdp.send('Page.enable', {}, session);
  await cdp.send('Runtime.enable', {}, session);
  await phoneWidth();
}

const metrics = (width) => cdp.send('Emulation.setDeviceMetricsOverride',
  { width, height: 900, deviceScaleFactor: 1, mobile: false }, session);
const phoneWidth = () => metrics(390);

async function stopChrome() {
  try { await cdp?.send('Browser.close'); } catch (e) { console.warn(`Browser.close: ${e.message}`); }
  chrome?.kill();
  await sleep(300);
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, session);
  if (r.exceptionDetails) throw new Error(`in the page: ${r.exceptionDetails.text}`);
  return r.result.value;
}

async function open(path, waitForRender) {
  const loaded = cdp.next('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}${path}` }, session);
  await loaded;
  if (!waitForRender) return;
  for (let i = 0; i < 40 && await evaluate(`!document.getElementById('loading').hidden`); i++) await sleep(25);
}

/** The page at both widths, for a byte compare of the PNGs. Ends back at phone width. */
async function pixels() {
  const out = {};
  for (const width of [390, 1280]) {
    await metrics(width);
    out[width] = (await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, session)).data;
  }
  await phoneWidth();
  return out;
}

// ── The stubbed server ───────────────────────────────────────────────────────

const pages = new Map();
const replies = new Map();
let slugs = 0;

function register(html) {
  const slug = `v${++slugs}`;
  pages.set(slug, html);
  return slug;
}

function stubScript(reply) {
  const answer = reply === REJECT
    ? `return Promise.reject(new Error('offline'));`
    : `return Promise.resolve({ json: function () { return Promise.resolve(${JSON.stringify(reply).replace(/</g, '\\u003c')}); } });`;
  return `<script>
window.__fetched = [];
window.fetch = function (url) { window.__fetched.push(String(url)); ${answer} };
window.Stripe = function () { return { elements: function () { return { create: function () { return { mount: function () {}, on: function () {} }; } }; }, confirmCardSetup: function () { return Promise.resolve({}); } }; };
</script>`;
}

function startServer() {
  server = createServer((req, res) => {
    const [, slug, caseId] = new URL(req.url, 'http://x').pathname.split('/');
    let html = pages.get(slug);
    if (html === undefined) { res.writeHead(404); res.end(); return; }
    if (replies.has(caseId)) html = html.replace(STRIPE_TAG, () => stubScript(replies.get(caseId)));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
}

function payPath(slug, c) {
  const params = new URLSearchParams({
    secret: 'seti_stub_secret_stub', order: '00000000-0000-4000-8000-000000000000', api: STAGING, ...(c.query ?? {}),
  });
  return `/${slug}/${c.id}?${params}`;
}
const resultPath = (slug, query) => `/${slug}/page?${query}`;

for (const c of [...SAME, ...TAXED]) replies.set(c.id, c.reply);

// ── What gets read out of the page ───────────────────────────────────────────

const READ_DOM = `(() => {
  const c = document.documentElement.cloneNode(true);
  c.querySelectorAll('script').forEach((s) => s.remove());
  return JSON.stringify({ fetched: window.__fetched || [], dom: c.outerHTML });
})()`;

const READ_PAY = `(() => {
  const $ = (id) => document.getElementById(id);
  const seen = (el) => !!el && el.getClientRects().length > 0;
  const rect = (el) => el.getBoundingClientRect();
  const kids = seen($('breakdown')) ? [...$('breakdown').children].filter(seen) : [];
  const isRow = (k) => k.classList.contains('breakdown-row');
  const total = $('total');
  const next = total.nextElementSibling;
  const hasFooter = next && next.tagName !== 'LABEL';
  const card = document.querySelector('label[for=card-element]');
  const noteAt = kids.findIndex((k) => !isRow(k));
  return {
    view: ['loading', 'form', 'done', 'oops'].filter((id) => seen($(id))),
    rows: kids.map((k) => (isRow(k) ? [k.children[0].textContent, k.children[1].textContent] : k.textContent)),
    total: total.textContent,
    footer: hasFooter ? next.textContent : null,
    noteOk: noteAt < 0 || (noteAt > 0 && rect(kids[noteAt]).top >= rect(kids[noteAt - 1]).bottom - 0.5),
    footOk: !hasFooter || (rect(next).top >= rect(total).bottom - 0.5
      && rect(next).bottom <= rect(card).top + 0.5
      && next.scrollWidth <= next.clientWidth),
    items: [...$('items').children].map((tr) => [...tr.children].map((td) => td.textContent)),
    sentence: $('note').textContent,
    attacked: window.__xss === true || $('form').querySelectorAll('img').length > 0,
  };
})()`;

const READ_RESULT = `(() => ({
  icon: document.getElementById('mark').textContent,
  title: document.getElementById('title').textContent,
  tone: document.getElementById('title').className,
  body: document.getElementById('body').textContent,
  doc: document.title,
}))()`;

// ── Checks ───────────────────────────────────────────────────────────────────

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const toCents = (s) => (s === 'Free' ? 0 : Math.round(parseFloat(s.replace('$', '')) * 100));
const dollars = (c) => `$${(c / 100).toFixed(2)}`;

function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `first differs at byte ${i}: got ${JSON.stringify(a.slice(i, i + 50))}, want ${JSON.stringify(b.slice(i, i + 50))}`;
}

function collector() {
  const ids = [];
  const fails = new Map();
  return { ids, fails, check(id, ok, detail = '') { ids.push(id); if (!ok) fails.set(id, detail); } };
}

let baseline; // BASE_SHA's own render of every SAME case, read once.

async function readBaseline() {
  baseline = new Map();
  const pay = register(PAY_BASE);
  for (const c of SAME) {
    await open(payPath(pay, c), true);
    baseline.set(c.id, { dom: await evaluate(READ_DOM), px: await pixels() });
  }
  const result = register(RESULT_BASE);
  for (const c of RESULT_SAME) {
    await open(resultPath(result, c.query), false);
    baseline.set(c.id, { dom: await evaluate(READ_DOM), px: await pixels() });
  }
}

async function comparePixels(check, id) {
  const px = await pixels();
  for (const width of [390, 1280]) check(`${id}.px${width}`, px[width] === baseline.get(id).px[width], `screenshot at ${width} differs`);
}

async function suitePay(html, withPixels) {
  const { ids, fails, check } = collector();
  const slug = register(html);
  check('src.pay', noInlineScript(html) === noInlineScript(PAY_BASE), 'markup or CSS differs from today\'s page');
  check('src.pay.banned', !BANNED.test(html), 'a banned tax label is in the page');

  for (const c of SAME) {
    await open(payPath(slug, c), true);
    const dom = await evaluate(READ_DOM);
    check(`${c.id}.dom`, dom === baseline.get(c.id).dom, firstDifference(dom, baseline.get(c.id).dom));
    if (withPixels) await comparePixels(check, c.id);
  }

  for (const c of TAXED) {
    await open(payPath(slug, c), true);
    const got = await evaluate(READ_PAY);
    check(`${c.id}.view`, eq(got.view, ['form']), `showing ${got.view}`);
    check(`${c.id}.rows`, eq(got.rows, c.rows), `got ${JSON.stringify(got.rows)}`);
    check(`${c.id}.total`, got.total === c.total, `got ${got.total}`);
    check(`${c.id}.footer`, got.footer === c.footer, `got ${JSON.stringify(got.footer)}`);
    check(`${c.id}.items`, eq(got.items, ITEMS), `got ${JSON.stringify(got.items)}`);
    check(`${c.id}.sentence`, got.sentence === (c.sentence ?? PICKUP), `got ${got.sentence}`);
    if (c.rows.length > 0) {
      const sum = got.rows.filter(Array.isArray).reduce((n, r) => n + toCents(r[1]), 0);
      const want = toCents(got.total);
      check(`${c.id}.sum`, sum === want,
        `rows add to ${dollars(sum)}, Total is ${dollars(want)} (short by ${dollars(want - sum)})`);
    }
    if (c.rows.some((r) => typeof r === 'string') || c.footer) {
      check(`${c.id}.position`, got.noteOk && got.footOk, `note ok ${got.noteOk}, footer ok ${got.footOk}`);
    }
    if (c.attack) check(`${c.id}.inert`, !got.attacked, 'markup from the reply became an element');
  }
  return { ids, fails };
}

async function suiteResult(html, withPixels) {
  const { ids, fails, check } = collector();
  const slug = register(html);
  check('src.result', noInlineScript(html) === noInlineScript(RESULT_BASE), 'markup or CSS differs from today\'s page');
  check('src.result.banned', !BANNED.test(html), 'a banned tax label is in the page');

  await open(resultPath(slug, 's=tax_unavailable'), false);
  const got = await evaluate(READ_RESULT);
  check('r.body', got.body === TAX_UNAVAILABLE, `got ${JSON.stringify(got.body)}`);
  check('r.title', got.title === 'Something went wrong', `got ${got.title}`);
  check('r.icon', got.icon === '⚠️', `got ${got.icon}`);
  check('r.tone', got.tone === 'warn', `got ${JSON.stringify(got.tone)}`);
  check('r.doc', got.doc === 'Something went wrong — Growing Green', `got ${got.doc}`);

  await open(resultPath(slug, 's=tax_unavailable&amt=1234'), false);
  const withAmt = await evaluate(READ_RESULT);
  check('r.amt', withAmt.body === TAX_UNAVAILABLE, `got ${JSON.stringify(withAmt.body)}`);

  for (const c of RESULT_SAME) {
    await open(resultPath(slug, c.query), false);
    const dom = await evaluate(READ_DOM);
    check(`${c.id}.dom`, dom === baseline.get(c.id).dom, firstDifference(dom, baseline.get(c.id).dom));
    if (withPixels) await comparePixels(check, c.id);
  }
  return { ids, fails };
}

/** The strings copied above, against the files they come from (root lane, read-only). */
function sourcesOfTruth() {
  const placement = join(LANE, 'supabase/functions/_shared/tax_placement.ts');
  const classes = join(LANE, 'docs/reference/tax-classes.md');
  if (!existsSync(placement) || !existsSync(classes)) {
    return [`SKIP   the source-of-truth compare: no root lane at ${LANE} (set GG_TAX_LANE)`];
  }
  const server = readFileSync(placement, 'utf8').match(/export const TAX_UNAVAILABLE =\s*"([^"]*)"/)?.[1];
  const doc = readFileSync(classes, 'utf8');
  const rows = [
    ['TAX_UNAVAILABLE = tax_placement.ts', server === TAX_UNAVAILABLE],
    ['receiptFooter   = tax-classes.md', doc.includes(`receiptFooter              = '${FOOTER}'`)],
    ['resaleOnFile    = tax-classes.md', doc.includes(`resaleOnFile               = '${RESALE}'`)],
    ['salesTaxLabel   = tax-classes.md', doc.includes("salesTaxLabel              = 'Sales tax'")],
  ];
  return rows.map(([name, ok]) => `${ok ? 'PASS' : 'FAIL'}   ${name}`);
}

// ── Mutants: each edit's text must occur exactly once, so a stale one is loud ─

const SENTENCE = `"${TAX_UNAVAILABLE}"`;
const ENTRY = `tax_unavailable:['⚠️','warn','Something went wrong',${SENTENCE}],`;
const ROW_CALL = 'if (hasTax) addTaxRow(taxCents, d.taxNote);';
const FOOT_CALL = 'if (hasTax && d.taxFooter) addTaxFooter(d.taxFooter);';
const HAS_TAX = 'var hasTax = !taxUnknown && d.taxCents !== undefined && d.taxCents !== null;';
const GATE = 'if (!taxUnknown && (fee > 0 || hasDelivery || hasTax)) {';
const NOTE_STYLE = 'margin-top:2px';
const FOOT_STYLE = 'margin:-12px 0 24px';

const MUTANTS = [
  // The row, its note and the footer
  { file: 'pay', name: 'tax row removed', edits: [[ROW_CALL, '']], caughtBy: 't1.rows' },
  { file: 'pay', name: 'tax row above the fees', edits: [['box.appendChild(row);', 'box.insertBefore(row, box.firstChild);']], caughtBy: 't1.rows' },
  { file: 'pay', name: 'note removed', edits: [['if (note) {', 'if (false) {']], caughtBy: 't1.rows' },
  { file: 'pay', name: 'note above its row', edits: [['box.appendChild(under);', 'box.insertBefore(under, row);']], caughtBy: 't1.rows' },
  { file: 'pay', name: 'empty note when there is no label', edits: [['if (note) {', 'if (true) {']], caughtBy: 't8.rows' },
  { file: 'pay', name: 'footer removed', edits: [[FOOT_CALL, '']], caughtBy: 't1.footer' },
  { file: 'pay', name: 'footer above the total', edits: [['total.parentNode.insertBefore(foot, total.nextSibling);', 'total.parentNode.insertBefore(foot, total);']], caughtBy: 't1.footer' },
  { file: 'pay', name: 'footer on a page with no tax row', edits: [[FOOT_CALL, 'if (d.taxFooter) addTaxFooter(d.taxFooter);']], caughtBy: 't12.footer' },
  { file: 'pay', name: 'footer on every page', edits: [[FOOT_CALL, "addTaxFooter('x');"]], caughtBy: 't9.footer' },
  { file: 'pay', name: 'note and footer overlap what is above them', edits: [[NOTE_STYLE, 'margin-top:-30px'], [FOOT_STYLE, 'margin:-80px 0 24px']], caughtBy: 't1.position' },
  { file: 'pay', name: 'footer clipped at phone width', edits: [["foot.style.cssText = '", "foot.style.cssText = 'white-space:nowrap;"]], caughtBy: 't1.position' },
  // The tax's presence and its figure
  { file: 'pay', name: 'truthy taxCents hides the $0', edits: [[HAS_TAX, 'var hasTax = !taxUnknown && !!d.taxCents;']], caughtBy: 't5.rows' },
  { file: 'pay', name: 'breakdown gate not widened', edits: [[GATE, 'if (!taxUnknown && (fee > 0 || hasDelivery)) {']], caughtBy: 't2.rows' },
  { file: 'pay', name: 'Subtotal off by a cent', edits: [["$('subtotal').textContent = money(subtotal);", "$('subtotal').textContent = money(subtotal + 1);"]], caughtBy: 't1.sum' },
  { file: 'pay', name: 'Subtotal holds the tax', edits: [["$('subtotal').textContent = money(subtotal);", "$('subtotal').textContent = money(subtotal + taxCents);"]], caughtBy: 't1.sum' },
  { file: 'pay', name: 'fallback forgets the tax', edits: [['- fee - deliveryFee - taxCents);', '- fee - deliveryFee);']], caughtBy: 't13.rows' },
  { file: 'pay', name: 'the tax figure is wrong', edits: [['value.textContent = money(cents);', 'value.textContent = money(0);']], caughtBy: 't1.sum' },
  { file: 'pay', name: 'Total gains a cent', edits: [["$('total').textContent = money(d.totalCents);", "$('total').textContent = money(d.totalCents + 1);"]], caughtBy: 't1.total' },
  { file: 'pay', name: 'label reworded to a banned one', edits: [["label.textContent = 'Sales tax';", "label.textContent = 'Taxes & fees';"]], caughtBy: 'src.pay.banned' },
  // taxUnknown
  { file: 'pay', name: 'taxUnknown ignored', edits: [['var taxUnknown = d.taxUnknown === true;', 'var taxUnknown = false;']], caughtBy: 't9.rows' },
  { file: 'pay', name: 'taxUnknown keeps the fee rows', edits: [[GATE, 'if (fee > 0 || hasDelivery || hasTax) {']], caughtBy: 't10.rows' },
  // Text, never markup
  { file: 'pay', name: 'note written as markup', edits: [['under.textContent = note;', 'under.innerHTML = note;']], caughtBy: 't14.inert' },
  { file: 'pay', name: 'footer written as markup', edits: [['foot.textContent = text;', 'foot.innerHTML = text;']], caughtBy: 't14.inert' },
  // The rest of the page keeps working
  { file: 'pay', name: 'render throws', edits: [[FOOT_CALL, "throw new Error('x');"]], caughtBy: 't1.view' },
  { file: 'pay', name: 'item rows lose their price', edits: [['tr.appendChild(qty); tr.appendChild(price);', 'tr.appendChild(qty);']], caughtBy: 't1.items' },
  { file: 'pay', name: 'the card sentence changes', edits: [["' confirms your order is ready for delivery.'", "' says so.'"], ["' confirms your order is ready.'", "' says so.'"]], caughtBy: 't1.sentence' },
  // Prod-shaped replies stay byte-identical
  { file: 'pay', name: 'a tax row on every reply', edits: [[HAS_TAX, 'var hasTax = !taxUnknown;']], caughtBy: 'p.fee.dom', pixels: true },
  { file: 'pay', name: 'null counts as a tax', edits: [[HAS_TAX, 'var hasTax = !taxUnknown && d.taxCents !== undefined;']], caughtBy: 'p.nulls.dom' },
  { file: 'pay', name: 'taxUnknown: false reads as unknown', edits: [['var taxUnknown = d.taxUnknown === true;', 'var taxUnknown = d.taxUnknown !== undefined;']], caughtBy: 'p.false.dom' },
  { file: 'pay', name: 'older-function fallback broken', edits: [['Math.max(0, (d.totalCents || 0) - fee - deliveryFee - taxCents)', '0']], caughtBy: 'p.oldfn.dom' },
  { file: 'pay', name: 'a hidden tax row in the markup', edits: [['<div class="breakdown-row" id="delivery-row" hidden>', '<div class="breakdown-row" id="tax-row" hidden><span>Sales tax</span><span></span></div><div class="breakdown-row" id="delivery-row" hidden>']], caughtBy: 'src.pay' },
  { file: 'pay', name: 'the page background shifts', edits: [['body { margin: 0; background: #f5f5f5;', 'body { margin: 0; background: #f5f5f6;']], caughtBy: 'p.notfound.px390', pixels: true },
  { file: 'pay', name: 'the fetch URL changes', edits: [["endpoint.searchParams.set('format', 'json');", "endpoint.searchParams.set('format', 'jsonp');"]], caughtBy: 'p.fee.dom' },
  // pay-result.html
  { file: 'result', name: 'no entry for the code', edits: [[ENTRY, '']], caughtBy: 'r.body' },
  { file: 'result', name: 'sentence: one curly apostrophe', edits: [[`"We couldn't work`, '"We couldn’t work']], caughtBy: 'r.body' },
  { file: 'result', name: 'sentence: one byte short', edits: [['try again later."', 'try again later"']], caughtBy: 'r.body' },
  { file: 'result', name: 'wrong title', edits: [[`'Something went wrong',${SENTENCE}`, `'Try again',${SENTENCE}`]], caughtBy: 'r.title' },
  { file: 'result', name: 'wrong tone', edits: [[`'warn','Something went wrong',${SENTENCE}`, `'bad','Something went wrong',${SENTENCE}`]], caughtBy: 'r.tone' },
  { file: 'result', name: 'wrong icon', edits: [["tax_unavailable:['⚠️'", "tax_unavailable:['✅'"]], caughtBy: 'r.icon' },
  { file: 'result', name: 'an amount rewrites the sentence', edits: [["if (code === 'order_confirmed') {", "if (code === 'order_confirmed' || code === 'tax_unavailable') {"]], caughtBy: 'r.amt' },
  { file: 'result', name: 'another code\'s copy disturbed', edits: [["'Ordering has closed','The confirm window", "'Ordering closed','The confirm window"]], caughtBy: 'r.other.so_auto.dom' },
  { file: 'result', name: 'the page background shifts', edits: [['background: #f5f5f5; margin: 0; padding: 24px; color: #333;', 'background: #f5f5f6; margin: 0; padding: 24px; color: #333;']], caughtBy: 'src.result', pixels: true },
  { file: 'result', name: 'a banned label in the page', edits: [['<title>Payment — Growing Green</title>', '<title>Taxes & fees — Growing Green</title>']], caughtBy: 'src.result.banned' },
];

function mutate(html, m) {
  return m.edits.reduce((out, [find, replace]) => {
    const count = out.split(find).length - 1;
    if (count !== 1) throw new Error(`mutant "${m.name}": ${JSON.stringify(find)} occurs ${count} times, expected once`);
    return out.replace(find, () => replace);
  }, html);
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function saveShots(dir) {
  mkdirSync(dir, { recursive: true });
  const save = async (name) => {
    const px = await pixels();
    for (const width of [390, 1280]) writeFileSync(join(dir, `${name}-${width}.png`), Buffer.from(px[width], 'base64'));
  };
  const pay = register(PAY_NOW);
  for (const c of TAXED) { await open(payPath(pay, c), true); await save(c.id); }
  const result = register(RESULT_NOW);
  await open(resultPath(result, 's=tax_unavailable'), false);
  await save('result-tax_unavailable');
}

async function main() {
  const shotsAt = process.argv.indexOf('--shots');
  let problems = 0;
  await startServer();
  await startChrome();
  try {
    await readBaseline();

    console.log('SOURCES OF TRUTH');
    for (const line of sourcesOfTruth()) {
      console.log(`  ${line}`);
      if (line.startsWith('FAIL')) problems++;
    }

    // The changed pages, pixels included.
    const pay = await suitePay(PAY_NOW, true);
    const result = await suiteResult(RESULT_NOW, true);
    const allIds = [...pay.ids, ...result.ids];
    const cleanFails = [...pay.fails, ...result.fails];
    console.log(`\nTHE CHANGED PAGES: ${allIds.length - cleanFails.length} of ${allIds.length} checks pass`);
    for (const [id, detail] of cleanFails) { console.log(`  FAIL ${id}: ${detail}`); problems++; }
    const sameIds = allIds.filter((id) => /^(p|r\.other)\./.test(id));
    console.log(`  prod-shaped replies and other codes: ${sameIds.length} byte or pixel compares against ${BASE_SHA}`);

    // Today's page against the same checks: the tax ones must fail.
    const seenFailing = new Set();
    const todayPay = await suitePay(PAY_BASE, false);
    const todayResult = await suiteResult(RESULT_BASE, false);
    const today = [...todayPay.fails, ...todayResult.fails];
    for (const [id] of today) seenFailing.add(id);
    console.log(`\nTODAY'S PAGE (${BASE_SHA}): fails ${today.length} checks`);
    console.log(`  ${today.map(([id]) => id).join(' ')}`);
    console.log(`  t1.sum, "difference 3": ${todayPay.fails.get('t1.sum')}`);
    console.log(`  r.body: ${todayResult.fails.get('r.body')}`);
    if (!todayPay.fails.has('t1.sum') || !todayResult.fails.has('r.body')) problems++;

    // The mutants.
    console.log(`\nMUTANTS: ${MUTANTS.length}`);
    for (const m of MUTANTS) {
      const source = m.file === 'pay' ? PAY_NOW : RESULT_NOW;
      const run = m.file === 'pay' ? suitePay : suiteResult;
      const { fails } = await run(mutate(source, m), m.pixels === true);
      for (const id of fails.keys()) seenFailing.add(id);
      const caught = fails.has(m.caughtBy);
      if (!caught) problems++;
      console.log(`  ${caught ? 'caught ' : 'MISSED '} ${m.file === 'pay' ? 'pay   ' : 'result'} ${m.name}: ${m.caughtBy}${fails.size > 1 ? ` (+${fails.size - 1} more)` : ''}`);
    }

    // Every check has to have failed under something.
    const never = [...new Set(allIds)].filter((id) => !seenFailing.has(id));
    console.log(`\nCHECKS NEVER SHOWN FAILING: ${never.length}`);
    if (never.length) { console.log(`  ${never.join(' ')}`); problems += never.length; }

    if (shotsAt !== -1) await saveShots(process.argv[shotsAt + 1]);
  } finally {
    server.close();
    await stopChrome();
  }
  console.log(problems === 0 ? '\nPASS' : `\nFAIL: ${problems} problem(s)`);
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
