/** Lightweight toasts: `toast('Saved')` from anywhere; <ToastHost /> (components/ui.jsx) renders them. */
export function toast(message, tone = 'success') {
  window.dispatchEvent(new CustomEvent('app:toast', { detail: { message, tone, id: Math.random() } }));
}
