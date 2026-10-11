import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { http, registerOrg, useDatabase } from './helpers.js';
import { firstError, phoneChars, validateField, validateForm } from '../src/lib/validation.js';

useDatabase();

const binaryParser = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('shared form rules', () => {
  it('the web app uses the same rules file as the API', () => {
    const api = fs.readFileSync(new URL('../src/lib/validation.js', import.meta.url), 'utf8');
    const web = fs.readFileSync(new URL('../../frontend/src/lib/validation.js', import.meta.url), 'utf8');
    expect(web).toBe(api);
  });

  it('checks phones, emails, names, numbers and Indian tax formats', () => {
    const phone = { key: 'phone', label: 'Phone', type: 'phone' };
    expect(validateField(phone, '9876543210')).toBeNull();
    expect(validateField(phone, '+91 98765-43210')).toBeNull();
    expect(validateField(phone, '08416800849')).toBeNull();
    expect(validateField(phone, '98765')).toMatch(/valid phone/);
    expect(validateField(phone, '98765abcde')).toMatch(/valid phone/);
    // A long junk value gets the phone message, not "too long"
    expect(validateField(phone, '56565655665565656fhfh')).toMatch(/valid phone/);
    expect(phoneChars('56565655665565656fhfh')).toBe('56565655665565656');
    expect(phoneChars('+91 (987) 654-3210')).toBe('+91 (987) 654-3210');

    expect(validateField({ label: 'Email', type: 'email' }, 'a@b.co')).toBeNull();
    expect(validateField({ label: 'Email', type: 'email' }, 'rahul@gmail')).toMatch(/valid email/);

    const name = { key: 'name', label: 'Name', required: true, format: 'name' };
    expect(validateField(name, '  ')).toBe('Name is required');
    expect(validateField(name, '12345')).toMatch(/letters/);
    expect(validateField(name, 'राहुल')).toBeNull();
    expect(validateField(name, 'x'.repeat(201))).toMatch(/too long/);

    const value = { label: 'Value', type: 'number', money: true };
    expect(validateField(value, '-1')).toBe('Value cannot be negative');
    expect(validateField(value, 'abc')).toBe('Value must be a number');
    expect(validateField(value, '1,25,000')).toBeNull();
    expect(validateField({ label: 'Probability', type: 'number', min: 0, max: 100 }, 120)).toMatch(/at most 100/);

    expect(validateField({ label: 'GSTIN', format: 'gstin' }, '27abcde1234f1z5')).toBeNull();
    expect(validateField({ label: 'GSTIN', format: 'gstin' }, '27ABCDE1234')).toMatch(/15 characters/);
    expect(validateField({ label: 'IFSC', format: 'ifsc' }, 'HDFC0001234')).toBeNull();
    expect(validateField({ label: 'PIN', format: 'pincode' }, '01234')).toMatch(/6 digits/);
    expect(validateField({ label: 'Web', format: 'url' }, 'www.cognieos.in')).toBeNull();
    expect(validateField({ label: 'Web', format: 'url' }, 'not a site')).toMatch(/valid website/);

    const errors = validateForm([name, phone], { name: '', phone: '123' });
    expect(Object.keys(errors)).toEqual(['name', 'phone']);
    expect(firstError(errors)).toBe('Name is required');
  });
});

describe('API rejects invalid records', () => {
  it('on create, with the field in the details', async () => {
    const admin = await registerOrg();
    const res = await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Rahul', email: 'rahul@gmail', phone: '98765' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/valid email/);
    expect(res.body.errors.map((e) => e.path[0])).toEqual(['email', 'phone']);

    expect((await http().post('/api/v1/leads').set(admin.auth).send({ name: '1234' })).body.message).toMatch(/letters/);
    expect((await http().post('/api/v1/deals').set(admin.auth).send({ name: 'Big', value: -10 })).body.message).toBe('Value cannot be negative');
    expect((await http().post('/api/v1/contacts').set(admin.auth).send({ lastName: 'Shah' })).body.message).toBe('First name is required');

    const ok = await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Rahul Sharma', email: 'rahul@sharma.in', phone: '98765 43210' });
    expect(ok.status).toBe(201);
  });

  it('on update, checking only the fields sent', async () => {
    const admin = await registerOrg();
    const lead = (await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Asha' })).body;
    expect((await http().patch(`/api/v1/leads/${lead.id}`).set(admin.auth).send({ status: 'contacted' })).status).toBe(200);
    const bad = await http().patch(`/api/v1/leads/${lead.id}`).set(admin.auth).send({ phone: 'call me' });
    expect(bad.status).toBe(400);
    expect((await http().patch(`/api/v1/leads/${lead.id}`).set(admin.auth).send({ name: '' })).body.message).toBe('Name is required');
    expect((await http().post('/api/v1/products').set(admin.auth).send({ name: 'Plan', hsnSac: '99' })).body.message).toMatch(/HSN/);
  });

  it('import reports a bad phone number on its row', async () => {
    const admin = await registerOrg();
    const res = await http().post('/api/v1/leads/import?dryRun=1').set(admin.auth).set('Content-Type', 'text/csv')
      .send('Name,Phone\nGood,9876543210\nBad,12345\n');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, failed: 1 });
    expect(res.body.errors).toEqual([{ row: 3, message: expect.stringContaining('"12345" is not a valid phone number') }]);
  });
});

describe('lead import template', () => {
  it('Excel template has dropdowns, highlighted required columns and instructions', async () => {
    const admin = await registerOrg();
    const res = await http().get('/api/v1/leads/import/template?format=xlsx').set(admin.auth).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('leads-import-template.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);

    const [sheet, guide] = wb.worksheets;
    expect(sheet.name).toBe('Leads');
    const headers = sheet.getRow(1).values.slice(1);
    expect(headers.slice(0, 5)).toEqual(['Name', 'Email', 'Phone', 'Company', 'Source']);
    expect(sheet.rowCount).toBe(1); // no sample data to import by mistake
    expect(sheet.getCell('A1').note.texts?.map((t) => t.text).join('') || sheet.getCell('A1').note).toContain('Required');

    // Status column: a strict dropdown fed from the hidden Lists sheet
    const statusCol = String.fromCharCode(65 + headers.indexOf('Status'));
    const status = sheet.dataValidations.find(`${statusCol}2`);
    expect(status).toMatchObject({ type: 'list', errorStyle: 'stop' });
    const ownerCol = String.fromCharCode(65 + headers.indexOf('Owner'));
    const lists = wb.getWorksheet('Lists');
    const ownerRange = sheet.dataValidations.find(`${ownerCol}2`).formulae[0];
    const ownerListCol = ownerRange.match(/\$([A-Z]+)\$1/)[1];
    expect(lists.getCell(`${ownerListCol}1`).value).toBe(admin.email);

    expect(guide.name).toBe('Instructions');
    const guideRows = guide.getSheetValues().slice(2).map((r) => r?.[1]);
    expect(guideRows).toEqual(expect.arrayContaining(['Name', 'Phone', 'Status']));
    expect(guide.getRow(2).getCell(2).value).toBe('Yes'); // Name is required

    // The untouched template imports cleanly (header row only)
    const back = await http().post('/api/v1/leads/import?dryRun=1').set(admin.auth).set('Content-Type', 'application/octet-stream').send(res.body);
    expect(back.status).toBe(200);
  });

  it('CSV template stays a plain header row', async () => {
    const admin = await registerOrg();
    const tpl = await http().get('/api/v1/leads/import/template').set(admin.auth);
    expect(tpl.text.split('\n')).toHaveLength(1);
    expect(tpl.text.startsWith('Name,Email,Phone,Company,Source,Status')).toBe(true);
  });
});
