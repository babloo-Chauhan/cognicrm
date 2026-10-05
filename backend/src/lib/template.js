/** Replaces {{path.to.value}} placeholders using values from the context object. */
export function interpolate(text, context = {}) {
  if (typeof text !== 'string') return text;
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const value = path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), context);
    return value == null ? '' : String(value);
  });
}
