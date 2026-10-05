import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { addUser, http, registerOrg, useDatabase } from './helpers.js';
import { AuditLog, Contact, Deal, Lead } from '../src/models/index.js';
import { parseCsv, toCsv } from '../src/lib/spreadsheet.js';

useDatabase();

const importCsv = (auth, entity, csv, query = '') => http()
  .post(`/api/v1/${entity}/import${query}`).set(auth).set('Content-Type', 'text/csv').send(csv);

const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('CSV helpers', () => {
  it('parses quotes, escaped quotes, embedded newlines, CRLF and BOM', () => {
    const rows = parseCsv('﻿Name,Note\r\n"Shah, Amit","said ""hi""\nthen left"\r\nB,\n');
    expect(rows).toEqual([['Name', 'Note'], ['Shah, Amit', 'said "hi"\nthen left'], ['B', '']]);
  });

  it('round-trips through toCsv, neutralizing formulas but keeping phone numbers', () => {
    const csv = toCsv(['A', 'B'], [{ A: '=SUM(1)', B: '+919876543210' }]);
    expect(csv).toBe("A,B\n'=SUM(1),+919876543210");
  });
});

describe('CRM import', () => {
  it('imports leads from CSV with header aliases, normalization and per-row errors', async () => {
    const admin = await registerOrg();
    const csv = [
      'Full Name,EMAIL,Mobile,Company,Status,Estimated Value,Do Not Call,Owner,Unknown Col',
      `Rahul Sharma,Rahul@Example.com,98765 43210,Infra Co,Qualified,"2,50,000",yes,${admin.user.email},x`,
      'Priya,priya@example.com,9811111111,,new,,no,,',
      ',,,,,,,,',
      'Bad Status,bad@example.com,,,maybe,,,,',
      'No Email,not-an-email,,,,abc,,,',
      ',missing-name@example.com,,,,,,,',
    ].join('\n');
    const res = await importCsv(admin.auth, 'leads', csv);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 5, created: 2, updated: 0, skipped: 0, failed: 3, ignoredColumns: ['Unknown Col'] });
    expect(res.body.errors.map((e) => e.row)).toEqual([5, 6, 7]);
    expect(res.body.errors[0].message).toMatch(/Status: "maybe" must be one of/);
    expect(res.body.errors[1].message).toMatch(/not a valid email.*not a number/);
    expect(res.body.errors[2].message).toBe('Name is required');

    const rahul = await Lead.findOne({ name: 'Rahul Sharma' }).lean();
    expect(rahul).toMatchObject({ email: 'rahul@example.com', phone: '+919876543210', status: 'qualified', estimatedValue: 250000, doNotCall: true });
    expect(String(rahul.organizationId)).toBe(admin.org.id);
    expect(String(rahul.ownerId)).toBe(admin.user.id);
    expect(await AuditLog.countDocuments({ action: 'leads.import' })).toBe(1);
  });

  it('dry run validates without writing', async () => {
    const admin = await registerOrg();
    const res = await importCsv(admin.auth, 'leads', 'Name,Phone\nA,9876543210\nB,9811111111', '?dryRun=1');
    expect(res.body).toMatchObject({ dryRun: true, created: 2 });
    expect(await Lead.countDocuments()).toBe(0);
  });

  it('skips, updates or creates duplicates depending on mode (matching by email/phone and within the file)', async () => {
    const admin = await registerOrg();
    await http().post('/api/v1/contacts').set(admin.auth).send({ firstName: 'Asha', email: 'ASHA@example.com', phone: '9876543210', company: 'Old' });
    const csv = 'First Name,Email,Phone,Company\nAsha,asha@example.com,,New Co\nRavi,,9811111111,R1\nRavi,,98111 11111,R2';

    const skip = await importCsv(admin.auth, 'contacts', csv);
    expect(skip.body).toMatchObject({ created: 1, skipped: 2, updated: 0 });
    expect((await Contact.findOne({ firstName: 'Asha' })).company).toBe('Old');

    const update = await importCsv(admin.auth, 'contacts', csv, '?mode=update');
    expect(update.body).toMatchObject({ created: 0, updated: 3 });
    expect((await Contact.findOne({ firstName: 'Asha' })).company).toBe('New Co');
    expect((await Contact.findOne({ firstName: 'Ravi' })).company).toBe('R2');
    expect(await Contact.countDocuments()).toBe(2);

    const create = await importCsv(admin.auth, 'contacts', csv, '?mode=create');
    expect(create.body.created).toBe(3);
    expect(await Contact.countDocuments()).toBe(5);

    expect((await importCsv(admin.auth, 'contacts', csv, '?mode=bogus')).status).toBe(400);
  });

  it('resolves account and contact references by name/email and warns when missing', async () => {
    const admin = await registerOrg();
    const acc = await http().post('/api/v1/accounts').set(admin.auth).send({ name: 'Tata Steel' });
    const con = await http().post('/api/v1/contacts').set(admin.auth).send({ firstName: 'Neha', lastName: 'Gupta', email: 'neha@tata.com' });
    const csv = 'Name,Value,Stage,Expected Close Date,Contact,Account\n'
      + 'Big deal,500000,Proposal,31/12/2026,neha@tata.com,tata steel\n'
      + 'Other deal,1000,prospecting,2026-11-01,Neha Gupta,Nope Ltd\n'
      + 'Bad date,1,prospecting,31/02/2026,,';
    const res = await importCsv(admin.auth, 'deals', csv);
    expect(res.body).toMatchObject({ created: 2, failed: 1 });
    expect(res.body.warnings).toEqual([{ row: 3, message: 'Account "Nope Ltd" was not found; left empty' }]);
    const big = await Deal.findOne({ name: 'Big deal' }).lean();
    expect(String(big.accountId)).toBe(acc.body.id);
    expect(String(big.contactId)).toBe(con.body.id);
    expect(big.stage).toBe('proposal');
    expect(new Date(big.expectedCloseDate).getFullYear()).toBe(2026);
    expect(String((await Deal.findOne({ name: 'Other deal' })).contactId)).toBe(con.body.id);
  });

  it('rejects files without required columns and non-file bodies', async () => {
    const admin = await registerOrg();
    const res = await importCsv(admin.auth, 'leads', 'Email,Phone\na@b.com,1');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Missing required column\(s\): Name/);
    const json = await http().post('/api/v1/leads/import').set(admin.auth).send({ rows: [] });
    expect(json.status).toBe(400);
  });

  it('imports Excel files', async () => {
    const admin = await registerOrg();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Tasks');
    ws.addRow(['Title', 'Due At', 'Priority', 'Assignee']);
    ws.addRow(['Call back Rahul', new Date('2026-11-05T10:00:00Z'), 'High', admin.user.email]);
    ws.addRow([{ richText: [{ text: 'Send ' }, { text: 'quote' }] }, '05/11/2026 14:30', 'low', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await http().post('/api/v1/tasks/import').set(admin.auth).set('Content-Type', 'application/octet-stream').send(buffer);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, failed: 0 });
    const tasks = await http().get('/api/v1/tasks').set(admin.auth);
    const titles = tasks.body.items.map((t) => t.title).sort();
    expect(titles).toEqual(['Call back Rahul', 'Send quote']);
    expect(tasks.body.items.find((t) => t.title === 'Call back Rahul')).toMatchObject({ priority: 'high', assigneeId: admin.user.id });
  });

  it('keeps tenants isolated: IDs and references from another org are not used', async () => {
    const a = await registerOrg('Org A');
    const b = await registerOrg('Org B');
    const lead = await http().post('/api/v1/leads').set(a.auth).send({ name: 'A lead' });
    await http().post('/api/v1/accounts').set(a.auth).send({ name: 'A Account' });
    const res = await importCsv(b.auth, 'leads', `ID,Name\n${lead.body.id},Hijack`, '?mode=update');
    expect(res.body).toMatchObject({ updated: 0, failed: 1 });
    expect((await Lead.findById(lead.body.id)).name).toBe('A lead');
    const con = await importCsv(b.auth, 'contacts', 'First Name,Account\nX,A Account');
    expect(con.body.warnings).toHaveLength(1);
  });
});

describe('CRM export', () => {
  it('exports filtered CSV that can be re-imported to update records', async () => {
    const admin = await registerOrg();
    const agent = await addUser(admin);
    await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Rahul', phone: '9876543210', status: 'qualified', ownerId: agent.user.id });
    await http().post('/api/v1/leads').set(admin.auth).send({ name: '=cmd|evil', status: 'new' });

    const filtered = await http().get('/api/v1/leads/export?status=qualified').set(admin.auth);
    expect(filtered.status).toBe(200);
    expect(filtered.headers['content-disposition']).toContain('leads.csv');
    const rows = parseCsv(filtered.text);
    expect(rows[0].slice(0, 3)).toEqual(['ID', 'Name', 'Email']);
    expect(rows).toHaveLength(2);
    const owner = rows[0].indexOf('Owner');
    expect(rows[1][owner]).toBe(agent.user.email);

    const all = await http().get('/api/v1/leads/export').set(admin.auth);
    expect(all.text).toContain("'=cmd|evil");

    // Edit the export and import it back: rows are matched by ID, the formula guard is undone
    const edited = all.text.replace('Rahul', 'Rahul Updated');
    const res = await importCsv(admin.auth, 'leads', edited, '?mode=update');
    expect(res.body).toMatchObject({ updated: 2, created: 0, failed: 0 });
    expect(await Lead.findOne({ name: 'Rahul Updated' })).toBeTruthy();
    expect(await Lead.findOne({ name: '=cmd|evil' })).toBeTruthy();
    expect(await AuditLog.countDocuments({ action: 'leads.export' })).toBe(2);
  });

  it('exports Excel and serves import templates', async () => {
    const admin = await registerOrg();
    await http().post('/api/v1/accounts').set(admin.auth).send({ name: 'Acme', industry: 'Retail' });
    const xlsx = await http().get('/api/v1/accounts/export?format=xlsx').set(admin.auth).buffer(true).parse(binaryParser);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body);
    expect(wb.worksheets[0].getRow(2).getCell(2).value).toBe('Acme');

    const tpl = await http().get('/api/v1/contacts/import/template').set(admin.auth);
    expect(tpl.text).toBe('First Name,Last Name,Email,Phone,Company,Account,Customer ID,Do Not Call,SMS Opt-out,WhatsApp Opt-out,Email Opt-out,Owner');
  });

  it('does not export other organizations’ records', async () => {
    const a = await registerOrg('Org A');
    const b = await registerOrg('Org B');
    await http().post('/api/v1/leads').set(a.auth).send({ name: 'Secret' });
    const res = await http().get('/api/v1/leads/export').set(b.auth);
    expect(res.text).not.toContain('Secret');
    expect(parseCsv(res.text)).toHaveLength(1);
  });
});
