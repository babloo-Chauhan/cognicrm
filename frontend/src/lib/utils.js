import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merges Tailwind class names, later classes winning over conflicting earlier ones. */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
