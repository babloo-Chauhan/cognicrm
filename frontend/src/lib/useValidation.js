import { useState } from 'react';
import { validateForm } from './validation.js';

/**
 * Validation for hand-written forms, using the shared rules in validation.js.
 * Errors stay hidden until the first save attempt, then update live as the user fixes them.
 *
 *   const v = useValidation([{ key: 'email', label: 'Email', type: 'email', required: true }], form);
 *   const save = () => { if (!v.check()) return; … };
 *   <Field label="Email" error={v.errors.email}><input aria-invalid={Boolean(v.errors.email)} … /></Field>
 */
export function useValidation(fields, values) {
  const [shown, setShown] = useState(false);
  const all = validateForm(fields.filter(Boolean), values || {});
  return {
    errors: shown ? all : {},
    check: () => {
      const ok = Object.keys(all).length === 0;
      setShown(!ok);
      return ok;
    },
    reset: () => setShown(false),
  };
}
