/**
 * Mixed-traffic load test: many signed-in users opening the screens employees use all day.
 * Needs autocannon (npm i -g autocannon, or run from a folder where it is installed).
 *
 *   API=http://127.0.0.1:5099/api/v1 USERS=agent1@loadtest.in,agent2@loadtest.in PASSWORD=… \
 *   CONNECTIONS=100 DURATION=30 node scripts/loadtest.js
 */
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.AUTOCANNON_DIR || process.cwd()}/`);
const autocannon = require('autocannon');

const API = process.env.API || 'http://127.0.0.1:5099/api/v1';
const emails = (process.env.USERS || '').split(',').filter(Boolean);
const password = process.env.PASSWORD;
const connections = Number(process.env.CONNECTIONS) || 100;
const duration = Number(process.env.DURATION) || 30;

const tokens = [];
for (const email of emails) {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const body = await res.json();
  if (!body.token) throw new Error(`login failed for ${email}: ${JSON.stringify(body)}`);
  tokens.push(body.token);
}
const sample = await (await fetch(`${API}/leads?limit=50`, { headers: { authorization: `Bearer ${tokens[0]}` } })).json();
const leadIds = sample.items.map((l) => l.id);

// What a typical employee session does, weighted by how often each screen is opened
const PATHS = [
  ...Array(4).fill('/leads'), '/leads?page=7', '/leads?q=Sharma', '/leads?q=98765', '/contacts', '/contacts?q=Priya',
  '/dashboard', '/dashboard', '/notifications', '/notifications', '/tasks?status=open', '/deals', '/pipelines/board',
  '/calls', '/analytics/me', '/auth/me', 'LEAD',
];
let n = 0;
const instance = autocannon({
  url: API.replace(/\/api\/v1$/, ''),
  connections,
  duration,
  requests: [{
    setupRequest: (req) => {
      n += 1;
      let path = PATHS[n % PATHS.length];
      if (path === 'LEAD') path = `/leads/${leadIds[n % leadIds.length]}`;
      return { ...req, method: 'GET', path: `/api/v1${path}`, headers: { authorization: `Bearer ${tokens[n % tokens.length]}` } };
    },
  }],
});
autocannon.track(instance, { renderProgressBar: false, renderResultsTable: true, renderLatencyTable: true });
instance.on('done', (r) => {
  const errors = r.non2xx + r.errors + r.timeouts;
  console.log(`\nrequests/s avg ${Math.round(r.requests.average)} · p50 ${r.latency.p50} ms · p99 ${r.latency.p99} ms · max ${r.latency.max} ms`);
  console.log(`total ${r.requests.total} · non-2xx ${r.non2xx} · errors ${r.errors} · timeouts ${r.timeouts}${errors ? '  ← PROBLEMS' : ''}`);
});
