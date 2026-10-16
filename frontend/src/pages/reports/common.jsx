import { Field } from '../../components/ui.jsx';
import { PRESETS } from './reportUtils.js';

/** Period select (quick periods or custom dates) bound to usePeriod(). */
export function PeriodPicker({ period }) {
  return (
    <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <Field label="Period">
        <select className="input" value={period.preset} onChange={(e) => period.choose(e.target.value)}>
          {PRESETS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          <option value="custom">Custom dates…</option>
        </select>
      </Field>
      {period.preset === 'custom' && (
        <>
          <Field label="From"><input className="input" type="date" value={period.from} max={period.to} onChange={(e) => e.target.value && period.setDates(e.target.value, period.to)} /></Field>
          <Field label="To"><input className="input" type="date" value={period.to} min={period.from} onChange={(e) => e.target.value && period.setDates(period.from, e.target.value)} /></Field>
        </>
      )}
    </div>
  );
}
