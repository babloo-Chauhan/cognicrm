import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { http, registerOrg, useDatabase } from './helpers.js';
import { Lead } from '../src/models/index.js';
import { searchTerms, searchTokens } from '../src/models/search.js';
import { pageParams, sortParam } from '../src/lib/pagination.js';
import { bumpCompany, cached, clearMemoryCache } from '../src/lib/cache.js';

useDatabase();

const ids = (res) => res.body.items.map((i) => i.id);

describe('pagination and sorting', () => {
  it('turns junk page / limit values into safe defaults', () => {
    expect(pageParams({})).toEqual({ page: 1, limit: 50 });
    expect(pageParams({ page: '3', limit: '20' })).toEqual({ page: 3, limit: 20 });
    expect(pageParams({ page: '-2', limit: '-5' })).toEqual({ page: 1, limit: 50 });
    expect(pageParams({ page: 'abc', limit: '1e9' })).toEqual({ page: 1, limit: 50 });
    expect(pageParams({ limit: '5000' }).limit).toBe(200);
  });

  it('only sorts by allowed fields', () => {
    expect(sortParam('-score', null, ['score'])).toEqual({ score: -1 });
    expect(() => sortParam('passwordHash', null, ['score'])).toThrow(/Cannot sort/);
    expect(() => sortParam('$where', null)).toThrow(/Cannot sort/);
  });

  it('pages through every record once, with totals', async () => {
    const admin = await registerOrg();
    // Same createdAt for all: the _id tie-breaker must still give stable, non-overlapping pages
    const at = new Date();
    await Lead.insertMany(Array.from({ length: 23 }, (_, i) => ({ organizationId: admin.org.id, name: `Lead ${i}`, createdAt: at })));
    const seen = [];
    for (let page = 1; page <= 3; page += 1) {
      const res = await http().get(`/api/v1/leads?limit=10&page=${page}`).set(admin.auth);
      expect(res.body).toMatchObject({ total: 23, page, limit: 10, pages: 3 });
      seen.push(...ids(res));
    }
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
    expect((await http().get('/api/v1/leads?page=99').set(admin.auth)).body.items).toEqual([]);
    expect((await http().get('/api/v1/leads?sort=passwordHash').set(admin.auth)).status).toBe(400);
    expect((await http().get('/api/v1/leads?sort=-score').set(admin.auth)).status).toBe(200);
  });

  it('walks a list with cursors: every record once, fast at any depth', async () => {
    const admin = await registerOrg();
    const at = new Date();
    await Lead.insertMany(Array.from({ length: 23 }, (_, i) => ({ organizationId: admin.org.id, name: `Lead ${i}`, createdAt: at, score: i % 3 })));
    for (const sort of ['', '-score']) {
      const seen = [];
      let after = null;
      for (let i = 0; i < 5; i += 1) {
        const res = await http().get(`/api/v1/leads?limit=10${sort ? `&sort=${sort}` : ''}${after ? `&after=${after}` : ''}`).set(admin.auth);
        expect(res.status).toBe(200);
        seen.push(...ids(res));
        after = res.body.next;
        if (!after) break;
      }
      expect(seen).toHaveLength(23);
      expect(new Set(seen).size).toBe(23);
    }
    expect((await http().get('/api/v1/leads?after=garbage').set(admin.auth)).status).toBe(400);
  });

  it('streams exports with every row (CSV and Excel)', async () => {
    const admin = await registerOrg();
    await Lead.insertMany(Array.from({ length: 1234 }, (_, i) => ({ organizationId: admin.org.id, name: `Lead ${i}`, phone: '=cmd' })));
    const csv = await http().get('/api/v1/leads/export?format=csv').set(admin.auth);
    expect(csv.headers['x-export-rows']).toBe('1234');
    const lines = csv.text.split('\n');
    expect(lines).toHaveLength(1235);
    expect(lines[0].startsWith('ID,Name,')).toBe(true);
    expect(csv.text).toContain("'=cmd"); // formula injection still neutralized
    const xlsx = await http().get('/api/v1/leads/export?format=xlsx').set(admin.auth).buffer(true)
      .parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body);
    expect(wb.worksheets[0].rowCount).toBe(1235);
  });

  it('list rows look like detail records (id, no internals)', async () => {
    const admin = await registerOrg();
    await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Asha Rao', phone: '9876543210' });
    const [row] = (await http().get('/api/v1/leads').set(admin.auth)).body.items;
    expect(row).toMatchObject({ id: expect.any(String), name: 'Asha Rao' });
    expect(row).not.toHaveProperty('_id');
    expect(row).not.toHaveProperty('_search');
    expect(row).not.toHaveProperty('__v');
  });

  it('paginates the audit log', async () => {
    const admin = await registerOrg();
    const res = await http().get('/api/v1/audit-logs?limit=1').set(admin.auth);
    expect(res.body).toMatchObject({ page: 1, limit: 1, total: expect.any(Number) });
    expect(res.body.items.length).toBeLessThanOrEqual(1);
  });
});

describe('fast search', () => {
  it('indexes word prefixes and phone digits', () => {
    const t = searchTokens({ name: 'Rahul Sharma', email: 'rahul@sharmatraders.in', phone: '+919876543210' }, ['name', 'email', 'phone']);
    expect(t).toEqual(expect.arrayContaining(['ra', 'rahul', 'sh', 'sharma', 'sharmatrad', '9198765432', '98765', '9876543210']));
    expect(searchTerms('  Rahul  SHARMA ')).toEqual(['rahul', 'sharma']);
    expect(searchTerms('+91 98765-43210')).toEqual(['9198765432']);
    expect(searchTerms('098765 43210')).toEqual(['9876543210']);
    expect(searchTerms('   ')).toBeNull();
  });

  it('finds records by name, email, company and phone prefix; keeps tokens fresh on edit', async () => {
    const admin = await registerOrg();
    const a = (await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Rahul Sharma', email: 'rahul@acme.in', phone: '98765 43210', company: 'Acme Traders' })).body;
    await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Priya Verma', phone: '9123456789' });
    const find = async (q) => ids(await http().get(`/api/v1/leads?q=${encodeURIComponent(q)}`).set(admin.auth));

    expect(await find('rah')).toEqual([a.id]);
    expect(await find('sharma rahul')).toEqual([a.id]);
    expect(await find('ACME')).toEqual([a.id]);
    expect(await find('98765')).toEqual([a.id]);
    expect(await find('+91 98765 43210')).toEqual([a.id]);
    expect(await find('arma')).toEqual([a.id]); // "contains" fallback when no word starts with it
    expect(await find('zzzz')).toEqual([]);

    await http().patch(`/api/v1/leads/${a.id}`).set(admin.auth).send({ name: 'Rohit Kumar' });
    expect(await find('rohit')).toEqual([a.id]);
    expect(await find('sharma')).toEqual([]); // old name gone (the email still says rahul)
  });

  it('search tokens cannot be set by the client', async () => {
    const admin = await registerOrg();
    const lead = (await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Asha', _search: ['hacked'] })).body;
    expect(ids(await http().get('/api/v1/leads?q=hacked').set(admin.auth))).toEqual([]);
    expect(ids(await http().get('/api/v1/leads?q=asha').set(admin.auth))).toEqual([lead.id]);
  });

  it('imports get search tokens too', async () => {
    const admin = await registerOrg();
    await http().post('/api/v1/leads/import').set(admin.auth).set('Content-Type', 'text/csv').send('Name,Phone\nImported Person,9811122233\n');
    expect((await http().get('/api/v1/leads?q=impor').set(admin.auth)).body.total).toBe(1);
    expect((await http().get('/api/v1/leads?q=98111').set(admin.auth)).body.total).toBe(1);
  });
});

describe('cache', () => {
  afterEach(() => { delete process.env.CACHE_IN_TESTS; clearMemoryCache(); });

  it('serves repeat reads from cache until the company changes', async () => {
    process.env.CACHE_IN_TESTS = '1';
    let runs = 0;
    const load = () => cached('org1', 'k', 60, async () => { runs += 1; return { runs }; });
    expect(await load()).toEqual({ runs: 1 });
    expect(await load()).toEqual({ runs: 1 });
    await bumpCompany('org1');
    expect(await load()).toEqual({ runs: 2 });
    expect(await cached('org2', 'k', 60, async () => 'other')).toBe('other'); // per company
  });

  it('runs one computation for concurrent misses', async () => {
    process.env.CACHE_IN_TESTS = '1';
    let runs = 0;
    const slow = () => cached('org3', 'k', 60, () => new Promise((r) => { runs += 1; setTimeout(() => r(runs), 20); }));
    expect(await Promise.all([slow(), slow(), slow()])).toEqual([1, 1, 1]);
  });

  it('dashboard and list totals update right after a new record', async () => {
    process.env.CACHE_IN_TESTS = '1';
    const admin = await registerOrg();
    expect((await http().get('/api/v1/dashboard').set(admin.auth)).body.leads.total).toBe(0);
    expect((await http().get('/api/v1/leads').set(admin.auth)).body.total).toBe(0);
    await http().post('/api/v1/leads').set(admin.auth).send({ name: 'New Lead' });
    await new Promise((r) => { setTimeout(r, 20); }); // the bump runs when the response finishes
    expect((await http().get('/api/v1/dashboard').set(admin.auth)).body.leads.total).toBe(1);
    expect((await http().get('/api/v1/leads').set(admin.auth)).body.total).toBe(1);
  });
});

describe('pipeline board', () => {
  it('counts and totals deals per stage in the database', async () => {
    const admin = await registerOrg();
    for (const [name, value, stage] of [['A', 100, 'proposal'], ['B', 250, 'proposal'], ['C', 50, 'won']]) {
      await http().post('/api/v1/deals').set(admin.auth).send({ name: `Deal ${name}`, value, stage });
    }
    const { items } = (await http().get('/api/v1/pipelines/board').set(admin.auth)).body;
    const proposal = items.find((c) => c.stage === 'proposal');
    expect(proposal).toMatchObject({ count: 2, value: 350, pipelineId: expect.any(String) });
    expect(proposal.recent.map((d) => d.name)).toEqual(['Deal B', 'Deal A']);
    expect(items.find((c) => c.stage === 'won')).toMatchObject({ count: 1, value: 50 });
  });

  it('rejects bad analytics filters with 400', async () => {
    const admin = await registerOrg();
    expect((await http().get('/api/v1/analytics/me?from=not-a-date').set(admin.auth)).status).toBe(400);
    expect((await http().get('/api/v1/analytics/me?agentId=xyz').set(admin.auth)).status).toBe(400);
    expect((await http().get('/api/v1/analytics/me?from=2026-01-01').set(admin.auth)).status).toBe(200);
  });
});
