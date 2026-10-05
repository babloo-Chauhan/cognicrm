import { toast as sonner } from 'sonner';

/** App-wide toast: `toast('Saved')`, `toast('Failed', 'error')`. Rendered by the Sonner <Toaster /> in main.jsx. */
export function toast(message, tone = 'success') {
  if (tone === 'error') sonner.error(message);
  else if (tone === 'info') sonner.info(message);
  else sonner.success(message);
}
