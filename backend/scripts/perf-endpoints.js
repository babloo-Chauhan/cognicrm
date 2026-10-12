/**
 * Times the main read endpoints against a seeded company (see seed-bulk.js) and flags slow ones.
 *
 *   API=http://127.0.0.1:5099/api/v1 TOKEN=… node scripts/perf-endpoints.js
 */
const API = process.env.API || 'http://127.0.0.1:5099/api/v1';
const TOKEN = process.env.TOKEN;
if (!TOKEN) throw new Error('TOKEN is required');
const SLOW_MS = Number(process.env.SLOW_MS) || 500;

async function hit(path) {
  const started = performance.now();
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const body = Buffer.from(await res.arrayBuffer());
  return { ms: Math.round(performance.now() - started), status: res.status, kb: Math.round(body.length / 1024), body };
}

const me = JSON.parse((await hit('/auth/me')).body.toString());
const userId = me.user?.id || me.id;
const paths = [
  '/dashboard', '/sales/overview', '/analytics/me', '/analytics/calls', '/pipelines/board', '/notifications',
  '/leads', '/leads?page=1000', '/leads?page=1999', '/leads?q=Sharma', '/leads?q=lead99999', '/leads?q=%2B9190', '/leads?status=won',
  `/leads?ownerId=${userId}`, '/leads?sort=-score', '/leads?sort=name', '/leads?status=qualified&sort=-createdAt&page=50',
  '/contacts', '/contacts?q=Priya', '/contacts?q=contact4999', '/accounts?q=Patel', '/deals', '/deals?stage=won', '/deals?sort=-value',
  `/tasks?status=open&assigneeId=${userId}`, '/tasks?status=open&sort=dueAt', '/tickets?status=open', '/calls', '/calls?page=500',
  '/quotes', '/invoices', '/audit-logs', '/users', '/leads/export?format=csv',
];

console.log('ms'.padStart(6), 'status', 'KB'.padStart(6), ' endpoint');
const slow = [];
for (const p of paths) {
  // run twice: the first call warms caches, the second is what users typically see
  await hit(p);
  const r = await hit(p);
  const flag = r.ms > SLOW_MS ? '  ← SLOW' : r.status >= 400 ? '  ← ERROR' : '';
  if (flag) slow.push(p);
  console.log(String(r.ms).padStart(6), String(r.status).padStart(6), String(r.kb).padStart(6), ` ${p}${flag}`);
}
console.log(slow.length ? `\n${slow.length} slow/failed endpoint(s)` : '\nall endpoints under the limit');
