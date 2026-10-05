import { useState } from 'react';
import { download, upload } from '../lib/api.js';
import { ErrorAlert, Field, Modal } from '../components/ui.jsx';

const MODES = [
  { value: 'skip', label: 'Skip records that already exist' },
  { value: 'update', label: 'Update records that already exist' },
  { value: 'create', label: 'Always create new records' },
];

const MATCH_HINT = {
  leads: 'email or phone', contacts: 'email or phone', accounts: 'name', deals: 'name', tickets: 'ID column', tasks: 'ID column',
};

/** Export buttons for a list page; exports use the same search and filters as the list. */
export function ExportButtons({ entity, query }) {
  const [error, setError] = useState(null);
  const run = async (format) => {
    setError(null);
    try {
      await download(`/${entity}/export`, { ...query, format }, `${entity}.${format}`);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <>
      <button type="button" className="btn" onClick={() => run('csv')}>Export CSV</button>
      <button type="button" className="btn" onClick={() => run('xlsx')}>Export Excel</button>
      {error && <ErrorAlert error={error} />}
    </>
  );
}

function Summary({ result }) {
  const counts = [
    ['Rows', result.total], ['Created', result.created], ['Updated', result.updated], ['Skipped', result.skipped], ['Failed', result.failed],
  ];
  return (
    <div className="stack">
      <div className={`alert ${result.failed ? 'alert-warning' : 'alert-info'}`}>
        {result.dryRun ? 'Preview — nothing has been saved yet. ' : 'Import finished. '}
        {counts.map(([k, v]) => `${k}: ${v}`).join(' · ')}
      </div>
      {result.ignoredColumns?.length > 0 && (
        <p className="small muted">Ignored columns (not recognised): {result.ignoredColumns.join(', ')}</p>
      )}
      {result.errors?.length > 0 && (
        <div>
          <strong className="small">Rows with errors {result.dryRun ? '(will be skipped)' : '(not imported)'}</strong>
          <ul className="small" style={{ maxHeight: 180, overflow: 'auto', margin: '4px 0', paddingLeft: 18 }}>
            {result.errors.map((e) => <li key={`e${e.row}`}>Row {e.row}: {e.message}</li>)}
          </ul>
        </div>
      )}
      {result.warnings?.length > 0 && (
        <div>
          <strong className="small">Warnings</strong>
          <ul className="small muted" style={{ maxHeight: 120, overflow: 'auto', margin: '4px 0', paddingLeft: 18 }}>
            {result.warnings.map((w, i) => <li key={`w${w.row}-${i}`}>Row {w.row}: {w.message}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Upload → preview (dry run) → import. */
export function ImportModal({ entity, title, onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState('skip');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const send = async (dryRun) => {
    setBusy(true);
    setError(null);
    try {
      const format = /\.xlsx$/i.test(file.name) ? 'xlsx' : 'csv';
      const res = await upload(`/${entity}/import`, file, { mode, format, dryRun: dryRun ? 1 : undefined });
      setResult(res);
      if (!dryRun) onImported?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const reset = (changes) => { setResult(null); setError(null); changes(); };
  const done = result && !result.dryRun;

  return (
    <Modal
      title={`Import ${title}`}
      onClose={onClose}
      size="lg"
      footer={done ? <button type="button" className="btn btn-primary" onClick={onClose}>Done</button> : (
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={!file || busy} onClick={() => send(true)}>Preview</button>
          <button type="button" className="btn btn-primary" disabled={!file || busy || (result && !result.created && !result.updated)} onClick={() => send(false)}>
            {busy ? 'Working…' : 'Import'}
          </button>
        </>
      )}
    >
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          Upload a CSV or Excel (.xlsx) file whose first row holds column names. Existing {title.toLowerCase()} are
          matched by {MATCH_HINT[entity]} (or the ID column of an export). Dates can be YYYY-MM-DD or DD/MM/YYYY.
          Empty cells never overwrite existing values.
        </p>
        <div className="row">
          <span className="small muted">Template:</span>
          <button type="button" className="btn btn-sm" onClick={() => download(`/${entity}/import/template`, { format: 'csv' }, `${entity}-template.csv`).catch(setError)}>CSV</button>
          <button type="button" className="btn btn-sm" onClick={() => download(`/${entity}/import/template`, { format: 'xlsx' }, `${entity}-template.xlsx`).catch(setError)}>Excel</button>
        </div>
        <Field label="File">
          <input
            className="input"
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={done}
            onChange={(e) => { const f = e.target.files?.[0] || null; reset(() => setFile(f)); }}
          />
        </Field>
        <Field label="When a record already exists">
          <select className="input" value={mode} disabled={done} onChange={(e) => { const v = e.target.value; reset(() => setMode(v)); }}>
            {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>
        <ErrorAlert error={error} />
        {result && <Summary result={result} />}
      </div>
    </Modal>
  );
}
