import { BusinessHours, CallDisposition } from '../../models/index.js';

export const DEFAULT_DISPOSITIONS = [
  { code: 'connected', label: 'Connected', category: 'connected' },
  { code: 'not_connected', label: 'Not Connected', category: 'not_connected' },
  { code: 'busy', label: 'Busy', category: 'not_connected' },
  { code: 'no_answer', label: 'No Answer', category: 'not_connected' },
  { code: 'wrong_number', label: 'Wrong Number', category: 'not_connected' },
  { code: 'interested', label: 'Interested', category: 'outcome' },
  { code: 'not_interested', label: 'Not Interested', category: 'outcome' },
  { code: 'callback_requested', label: 'Callback Requested', category: 'outcome', requiresCallback: true },
  { code: 'demo_scheduled', label: 'Demo Scheduled', category: 'outcome' },
  { code: 'qualified', label: 'Qualified', category: 'outcome' },
  { code: 'unqualified', label: 'Unqualified', category: 'outcome' },
  { code: 'converted', label: 'Converted', category: 'outcome', isConversion: true },
  { code: 'escalated', label: 'Escalated', category: 'outcome' },
  { code: 'other', label: 'Other', category: 'outcome' },
];

/** Creates the per-organization defaults every new tenant needs. */
export async function seedOrganization(orgId) {
  await CallDisposition.insertMany(
    DEFAULT_DISPOSITIONS.map((d, i) => ({ ...d, organizationId: orgId, system: true, order: i })),
    { ordered: false },
  ).catch(() => null);
  await BusinessHours.create({
    organizationId: orgId,
    name: 'Standard hours',
    timezone: 'Asia/Kolkata',
    weekly: [1, 2, 3, 4, 5].map((day) => ({ day, open: '09:00', close: '18:00' })).concat([{ day: 6, open: '10:00', close: '14:00' }]),
    holidays: [],
  });
}
