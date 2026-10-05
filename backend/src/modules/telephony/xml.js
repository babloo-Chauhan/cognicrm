/** Tiny XML builder used to render TwiML / Plivo XML from the provider-neutral action list. */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds an element. A string child is TEXT and is always escaped; an array child holds
 * already-rendered elements and is inserted as-is.
 */
export function el(tag, attrs = {}, children = '') {
  const attrString = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join('');
  const body = Array.isArray(children) ? children.join('') : escapeXml(children);
  return body === '' ? `<${tag}${attrString}/>` : `<${tag}${attrString}>${body}</${tag}>`;
}

export function document(rootChildren) {
  return `<?xml version="1.0" encoding="UTF-8"?>${el('Response', {}, rootChildren)}`;
}
