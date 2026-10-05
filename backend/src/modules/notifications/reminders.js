import { Appointment, Task } from '../../models/index.js';
import { notify } from './service.js';

// How long before an appointment its owner is reminded.
export const APPOINTMENT_LEAD_MINUTES = 15;

const relatedData = (related = {}) => Object.fromEntries(
  ['leadId', 'contactId', 'dealId', 'accountId', 'ticketId'].filter((k) => related[k]).map((k) => [k, String(related[k])]),
);

/** Follow-up reminders: open tasks whose due time has come, reminded once per due time. */
export async function remindDueTasks(now = new Date()) {
  const due = await Task.find({ status: 'open', dueAt: { $lte: now }, assigneeId: { $ne: null }, reminderSentAt: null }).limit(200);
  for (const task of due) {
    task.reminderSentAt = now;
    await task.save();
    await notify(task.organizationId, task.assigneeId, {
      type: 'task_due',
      title: `⏰ Follow-up due: ${task.title}`,
      body: task.description ? String(task.description).slice(0, 120) : `Due ${task.dueAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
      data: { taskId: String(task._id), ...relatedData(task.related) },
    });
  }
  return due.length;
}

/** Reminds the owner shortly before a scheduled appointment starts. */
export async function remindUpcomingAppointments(now = new Date()) {
  const soon = new Date(now.getTime() + APPOINTMENT_LEAD_MINUTES * 60000);
  const upcoming = await Appointment.find({ status: 'scheduled', startAt: { $lte: soon, $gte: new Date(now.getTime() - 3600000) }, userId: { $ne: null }, reminderSentAt: null }).limit(200);
  for (const appt of upcoming) {
    appt.reminderSentAt = now;
    await appt.save();
    const minutes = Math.max(0, Math.round((appt.startAt - now) / 60000));
    await notify(appt.organizationId, appt.userId, {
      type: 'appointment_reminder',
      title: `📅 ${appt.title}`,
      body: minutes ? `Starts in ${minutes} min` : 'Starting now',
      data: { appointmentId: String(appt._id), ...relatedData(appt.related) },
    });
  }
  return upcoming.length;
}

/** Tells a user a task was assigned to them by someone else. */
export async function notifyTaskAssigned(task, byUser) {
  if (!task.assigneeId || String(task.assigneeId) === String(byUser?._id)) return;
  await notify(task.organizationId, task.assigneeId, {
    type: 'task_assigned',
    title: `New task: ${task.title}`,
    body: `Assigned by ${byUser?.name || 'a teammate'}${task.dueAt ? ` · due ${task.dueAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}`,
    data: { taskId: String(task._id), ...relatedData(task.related) },
  });
}
