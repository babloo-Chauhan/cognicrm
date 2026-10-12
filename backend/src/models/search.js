/**
 * Fast prefix search for large collections.
 *
 * A record keeps `_search`: the lower-cased word prefixes (2–10 characters) of its searchable fields, plus
 * prefixes of its phone digits with and without the country code. `{ _search: { $all: [...] } }` is answered
 * from the { organizationId, _search } index, so "shar", "rahul shar", "lead99" or "98765" stay fast with
 * hundreds of thousands of records, where an unanchored regex has to read every record of the company.
 */
const MIN = 2;
const MAX = 10;
const PHONE_FIELDS = new Set(['phone', 'mobile', 'whatsapp']);

const words = (text) => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function prefixes(word, into) {
  for (let n = MIN; n <= Math.min(word.length, MAX); n += 1) into.add(word.slice(0, n));
  if (word.length < MIN) into.add(word);
}

/** Search tokens for one record. */
export function searchTokens(doc, fields) {
  const out = new Set();
  for (const field of fields) {
    const value = doc[field];
    if (value === undefined || value === null || value === '') continue;
    if (PHONE_FIELDS.has(field)) {
      const digits = String(value).replace(/\D/g, '');
      if (digits) {
        prefixes(digits, out);
        if (digits.length > 10) prefixes(digits.slice(-10), out); // +91 98765 43210 is also found as 98765…
      }
      continue;
    }
    for (const w of words(value)) prefixes(w, out);
  }
  return [...out];
}

/**
 * The query terms for a search box value: words (cut to the indexed prefix length), with a phone-like value
 * ("+91 98765-43210", "098765 43210") turned into one digit string. Returns null when there is nothing to search.
 */
export function searchTerms(q) {
  const text = String(q ?? '').trim();
  if (!text) return null;
  if (/^[+\d\s\-().]+$/.test(text) && /\d/.test(text)) {
    let digits = text.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1); // 0 + 10-digit mobile
    return [digits.slice(0, MAX)];
  }
  const terms = [...new Set(words(text).map((w) => w.slice(0, MAX)))];
  return terms.length ? terms : null;
}

/** Mongoose plugin: maintains `_search` for `fields` on create, save, import and single-record updates. */
export function searchPlugin(schema, { fields }) {
  schema.add({ _search: { type: [String], select: false } });
  // createdAt + _id after the token: results come out of the index already newest-first (no in-memory sort)
  schema.index({ organizationId: 1, _search: 1, createdAt: -1, _id: -1 });
  schema.statics.searchFields = fields;

  // 'validate' also runs for insertMany (imports), unlike 'save'
  schema.pre('validate', function setSearch() {
    if (this.isNew || fields.some((f) => this.isModified(f))) this._search = searchTokens(this, fields);
  });

  // updateOne / findOneAndUpdate that change a searched field: refresh the tokens of the matched records
  schema.post(['updateOne', 'findOneAndUpdate'], async function refreshSearch() {
    const update = this.getUpdate() || {};
    const changed = { ...update, ...(update.$set || {}), ...(update.$unset || {}) };
    if (!fields.some((f) => f in changed)) return;
    const docs = await this.model.find(this.getFilter()).select(fields.join(' ')).limit(100).lean();
    if (!docs.length) return;
    await this.model.bulkWrite(docs.map((d) => ({ updateOne: { filter: { _id: d._id }, update: { $set: { _search: searchTokens(d, fields) } } } })));
  });
}

/**
 * Fills `_search` for records saved before search tokens existed (runs once at startup, in batches,
 * so a large company does not block the server).
 */
export async function backfillSearch(Model, { batch = 1000, log = () => {} } = {}) {
  const fields = Model.searchFields;
  let total = 0;
  for (;;) {
    const docs = await Model.find({ _search: { $exists: false } }).select(fields.join(' ')).limit(batch).lean();
    if (!docs.length) break;
    await Model.bulkWrite(docs.map((d) => ({ updateOne: { filter: { _id: d._id }, update: { $set: { _search: searchTokens(d, fields) } } } })), { ordered: false });
    total += docs.length;
  }
  if (total) log(Model.modelName, total);
  return total;
}
