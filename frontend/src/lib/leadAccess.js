/** True when this user holds the lead now or held it before: it is theirs to work and to assign on. */
export function sharesLead(lead, user) {
  const me = String(user?.id || '');
  return Boolean(me) && (String(lead.ownerId || '') === me || (lead.assignees || []).some((a) => String(a) === me));
}

/** The admin assigns any lead to anyone (or unassigns it); everyone who has held a lead can assign it on. */
export function canReassignLead(lead, { can, user }) {
  return can('team_leads:assign') || sharesLead(lead, user);
}
