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

const csvCell = (v) => {
  const safe = neutralizeFormula(v);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** One CSV line (no newline) for `row`, in `headers` order, with formula injection neutralized. */
export const csvLine = (headers, row) => headers.map((h) => csvCell(row[h])).join(',');

export function toCsv(headers, rows) {
  return [headers.join(','), ...rows.map((r) => csvLine(headers, r))].join('\n');
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

const TEMPLATE_ROWS = 1000; // rows that get dropdowns and checks
const colLetter = (n) => { let s = ''; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };

/**
 * Builds an import template workbook: the data sheet first (that is the sheet import reads), with highlighted
 * required headers, a hint on each header, dropdowns from a hidden "Lists" sheet and number checks; then an
 * "Instructions" sheet with one row per column and an example. columns: templateGuide() output.
 */
export function buildTemplateWorkbook({ sheet, columns }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  const guide = wb.addWorksheet('Instructions');
  const lists = wb.addWorksheet('Lists', { state: 'veryHidden' });

  ws.columns = columns.map((c) => ({ header: c.header, key: c.header, width: Math.max(14, c.header.length + 4, String(c.example).length + 2) }));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const head = ws.getRow(1);
  head.height = 22;
  columns.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.font = { bold: true, color: { argb: c.required ? 'FFFFFFFF' : 'FF1F2937' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.required ? 'FF4F46E5' : 'FFE0E7FF' } };
    cell.alignment = { vertical: 'middle' };
    cell.note = `${c.required ? 'Required. ' : ''}${c.hint}${c.example !== '' ? `\nExample: ${c.example}` : ''}`;
    const range = `${colLetter(i + 1)}2:${colLetter(i + 1)}${TEMPLATE_ROWS + 1}`;
    if (c.list) {
      const col = colLetter(lists.columnCount + 1);
      c.list.forEach((v, r) => { lists.getCell(`${col}${r + 1}`).value = v; });
      ws.dataValidations.add(range, {
        type: 'list', allowBlank: true, formulae: [`Lists!$${col}$1:$${col}$${c.list.length}`],
        showErrorMessage: true, errorStyle: c.strict ? 'stop' : 'information',
        errorTitle: c.header, error: c.strict ? `Choose a value from the list for ${c.header}.` : `${c.header} is not in the list — it will be saved as typed.`,
      });
    } else if (c.number) {
      ws.dataValidations.add(range, {
        type: 'decimal', operator: 'greaterThanOrEqual', allowBlank: true, formulae: [0],
        showErrorMessage: true, errorStyle: 'stop', errorTitle: c.header, error: `${c.header} must be a number (0 or more).`,
      });
    }
  });

  guide.columns = [
    { header: 'Column', key: 'header', width: 22 },
    { header: 'Required?', key: 'required', width: 11 },
    { header: 'What to enter', key: 'hint', width: 58 },
    { header: 'Example', key: 'example', width: 26 },
  ];
  guide.getRow(1).font = { bold: true };
  for (const c of columns) guide.addRow({ header: c.header, required: c.required ? 'Yes' : '', hint: c.list && !c.strict && c.list.length > 3 ? `${c.hint}. Options: ${c.list.join(', ')}` : c.hint, example: c.example });
  guide.addRow({});
  guide.addRow({ header: 'How to import', hint: `Fill one record per row on the "${sheet}" sheet (row 1 is the header — keep it). Blank optional cells are fine.` });
  guide.addRow({ hint: 'Phone numbers: 10 digits, or with country code. Dates: YYYY-MM-DD or DD/MM/YYYY.' });
  guide.addRow({ hint: 'Upload the file and click "Preview" first — every row is checked and nothing is saved until you import.' });
  guide.getColumn('hint').alignment = { wrapText: true, vertical: 'top' };
  return wb;
}
