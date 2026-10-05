import ExcelJS from 'exceljs';
import { badRequest } from './errors.js';

/** Prefixes cells that a spreadsheet would run as a formula (CSV/formula injection). Phone numbers stay as-is. */
export function neutralizeFormula(value) {
  const s = String(value ?? '');
  return /^[=+\-@]/.test(s) && !/^\+\d+$/.test(s) ? `'${s}` : s;
}

/** Reverses neutralizeFormula so an exported file can be imported again unchanged. */
export function restoreFormula(value) {
  return typeof value === 'string' && /^'[=+\-@]/.test(value) ? value.slice(1) : value;
}

export function toCsv(headers, rows) {
  const esc = (v) => {
    const safe = neutralizeFormula(v);
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}

/** RFC 4180 CSV parser: quoted fields, escaped quotes, embedded newlines, CRLF, UTF-8 BOM. Returns rows of strings. */
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (quoted) throw badRequest('CSV has an unterminated quoted field');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function excelCellValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return excelCellValue(v.result); // formula: use the cached result, never the formula
    if (v.text !== undefined) return excelCellValue(v.text); // hyperlink
    if (v.error) return '';
    return String(v);
  }
  return v;
}

/** Reads the first worksheet of an .xlsx file into rows (values are strings, numbers, booleans or Dates). */
export async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw badRequest('Could not read the Excel file. Save it as .xlsx and try again.');
  }
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const width = ws.columnCount;
  // Keep sheet row positions so import errors can point at the right row number
  const rows = Array.from({ length: ws.rowCount }, () => []);
  ws.eachRow({ includeEmpty: false }, (r) => {
    const cells = [];
    for (let c = 1; c <= width; c += 1) cells.push(excelCellValue(r.getCell(c).value));
    rows[r.number - 1] = cells;
  });
  while (rows.length && !rows[0].some((v) => String(v).trim() !== '')) rows.shift();
  return rows;
}

/** Parses an uploaded CSV or XLSX body. xlsx files are zip archives, so they start with "PK". */
export async function readTable(buffer, format) {
  if (!buffer?.length) throw badRequest('The uploaded file is empty');
  const isXlsx = format ? format === 'xlsx' : buffer[0] === 0x50 && buffer[1] === 0x4b;
  return isXlsx ? parseXlsx(buffer) : parseCsv(buffer.toString('utf8'));
}

/** Sends rows as a CSV or XLSX download. */
export async function sendTable(res, { headers, rows, name, format = 'csv', sheet }) {
  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheet || name);
    ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(12, h.length + 4) }));
    // Excel stores these as literal text, so no formula neutralization is needed here
    rows.forEach((r) => ws.addRow(r));
    ws.getRow(1).font = { bold: true };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
  return res.send(toCsv(headers, rows));
}
