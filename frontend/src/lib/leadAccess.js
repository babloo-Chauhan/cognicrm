/** The admin assigns any lead to anyone (or unassigns it); the person holding a lead can pass it on. */
export function canReassignLead(lead, { can, user }) {
  return can('team_leads:assign') || (Boolean(lead.ownerId) && String(lead.ownerId) === String(user?.id));
}
