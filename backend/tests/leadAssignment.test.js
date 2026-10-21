import { describe, expect, it } from 'vitest';
import { addUser, http, registerOrg, useDatabase } from './helpers.js';

useDatabase();

const leadsOf = async (who) => (await http().get('/api/v1/leads').set(who.auth)).body.items.map((l) => l.name).sort();
const notes = async (who) => (await http().get('/api/v1/notifications').set(who.auth)).body.items;

describe('lead assignment and visibility', () => {
  it('employees see only leads they hold or held; the admin sees all', async () => {
    const admin = await registerOrg();
    const ravi = await addUser(admin, { role: 'sales_executive', name: 'Ravi' });
    const sita = await addUser(admin, { role: 'sales_executive', name: 'Sita' });
    const mohan = await addUser(admin, { role: 'sales_manager', name: 'Mohan' });
    await http().post('/api/v1/leads').set(admin.auth).send({ name: 'For Ravi', ownerId: ravi.user.id });
    await http().post('/api/v1/leads').set(sita.auth).send({ name: 'Sita own' });
    await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Admin own' });

    expect(await leadsOf(admin)).toEqual(['Admin own', 'For Ravi', 'Sita own']);
    expect(await leadsOf(ravi)).toEqual(['For Ravi']);
    expect(await leadsOf(sita)).toEqual(['Sita own']);
    expect(await leadsOf(mohan)).toEqual([]); // managers too, unless the admin grants team_leads:view_all

    // Someone else's lead cannot be opened, edited, deleted, converted, or read through its timeline / remarks
    const sitas = (await http().get('/api/v1/leads').set(sita.auth)).body.items[0];
    expect((await http().get(`/api/v1/leads/${sitas.id}`).set(ravi.auth)).status).toBe(404);
    expect((await http().patch(`/api/v1/leads/${sitas.id}`).set(ravi.auth).send({ status: 'lost' })).status).toBe(404);
    expect((await http().delete(`/api/v1/leads/${sitas.id}`).set(ravi.auth)).status).toBe(404);
    expect((await http().post(`/api/v1/leads/${sitas.id}/convert`).set(ravi.auth).send({})).status).toBe(404);
    expect((await http().get(`/api/v1/timeline/lead/${sitas.id}`).set(ravi.auth)).status).toBe(404);
    expect((await http().get('/api/v1/notes').query({ 'related.leadId': sitas.id }).set(ravi.auth)).status).toBe(404);
    expect((await http().post('/api/v1/notes').set(ravi.auth).send({ body: 'x', related: { leadId: sitas.id } })).status).toBe(404);
    expect((await http().get(`/api/v1/leads/${sitas.id}`).set(admin.auth)).status).toBe(200);

    // Dashboard numbers follow the same rule
    expect((await http().get('/api/v1/dashboard').set(ravi.auth)).body.leads.total).toBe(1);
    expect((await http().get('/api/v1/dashboard').set(admin.auth)).body.leads.total).toBe(3);
  });

  it('only the admin or the current holder can reassign; the trail is kept and both people are told', async () => {
    const admin = await registerOrg();
    const ravi = await addUser(admin, { role: 'sales_executive', name: 'Ravi' });
    const sita = await addUser(admin, { role: 'sales_executive', name: 'Sita' });
    const amit = await addUser(admin, { role: 'sales_executive', name: 'Amit' });

    const lead = (await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Mehta Steels', phone: '9876500077', ownerId: ravi.user.id })).body;
    expect(lead.assignments).toHaveLength(1);
    expect(lead.assignments[0]).toMatchObject({ from: null, to: ravi.user.id, by: admin.user.id });

    // Ravi is told, and the notification lets him call straight away
    const n = (await notes(ravi)).find((x) => x.type === 'lead_assigned');
    expect(n.data).toMatchObject({ leadId: lead.id, phone: '+919876500077', action: 'call' });
    expect(n.body).toContain('tap to call');

    // Sita does not hold it, so she cannot take it (she cannot even see it)
    expect((await http().patch(`/api/v1/leads/${lead.id}`).set(sita.auth).send({ ownerId: sita.user.id })).status).toBe(404);

    // Ravi passes it to Sita; he keeps seeing it, marked as passed on
    const passed = await http().patch(`/api/v1/leads/${lead.id}`).set(ravi.auth).send({ ownerId: sita.user.id });
    expect(passed.status).toBe(200);
    expect(passed.body.assignments.map((a) => [a.from, a.to, a.by])).toEqual([
      [null, ravi.user.id, admin.user.id], [ravi.user.id, sita.user.id, ravi.user.id],
    ]);
    expect(await leadsOf(ravi)).toEqual(['Mehta Steels']);
    expect(await leadsOf(sita)).toEqual(['Mehta Steels']);
    expect((await notes(sita)).some((x) => x.type === 'lead_assigned' && x.data.leadId === lead.id)).toBe(true);

    // Both keep it as theirs: Ravi can still work on it and assign it on
    expect((await http().patch(`/api/v1/leads/${lead.id}`).set(ravi.auth).send({ status: 'contacted' })).status).toBe(200);
    const again = await http().patch(`/api/v1/leads/${lead.id}`).set(ravi.auth).send({ ownerId: amit.user.id });
    expect(again.status).toBe(200);
    expect(await leadsOf(amit)).toEqual(['Mehta Steels']);
    // …and Sita, who had it in between, too
    expect((await http().patch(`/api/v1/leads/${lead.id}`).set(sita.auth).send({ ownerId: sita.user.id })).status).toBe(200);
    // …but only the admin can unassign it
    expect((await http().patch(`/api/v1/leads/${lead.id}`).set(sita.auth).send({ ownerId: null })).status).toBe(403);
    // …and nobody can rewrite the trail
    await http().patch(`/api/v1/leads/${lead.id}`).set(sita.auth).send({ assignments: [], assignees: [] });
    expect((await http().get(`/api/v1/leads/${lead.id}`).set(admin.auth)).body.assignments).toHaveLength(4);

    // The admin can move it to anyone; Sita (previous holder) is told where it went
    await http().patch(`/api/v1/leads/${lead.id}`).set(admin.auth).send({ ownerId: amit.user.id });
    const moved = (await notes(sita)).find((x) => x.type === 'lead_reassigned');
    expect(moved.body).toContain('Amit');
    expect(moved.body).toContain('stays in your leads');
    // The admin can unassign it; everyone who held it still sees it
    const unassigned = await http().patch(`/api/v1/leads/${lead.id}`).set(admin.auth).send({ ownerId: null });
    expect(unassigned.status).toBe(200);
    expect(unassigned.body.assignments.at(-1)).toMatchObject({ from: amit.user.id, to: null, by: admin.user.id });
    for (const who of [ravi, sita, amit]) expect(await leadsOf(who)).toEqual(['Mehta Steels']);

    // "Handled by me" filter: leads someone has held
    const mine = await http().get('/api/v1/leads').query({ assignees: ravi.user.id }).set(admin.auth);
    expect(mine.body.items.map((l) => l.name)).toEqual(['Mehta Steels']);
    const tl = await http().get(`/api/v1/timeline/lead/${lead.id}`).set(ravi.auth);
    expect(tl.body.items.filter((i) => i.type === 'lead_assigned').map((i) => i.title)).toContain('Lead assigned to Sita by Ravi');
  });

  it('a salesperson can add a senior (or several people) to a lead without handing it over', async () => {
    const admin = await registerOrg();
    const ravi = await addUser(admin, { role: 'sales_executive', name: 'Ravi' });
    const mohan = await addUser(admin, { role: 'sales_manager', name: 'Mohan' });
    const sita = await addUser(admin, { role: 'sales_executive', name: 'Sita' });
    const amit = await addUser(admin, { role: 'sales_executive', name: 'Amit' });
    const lead = (await http().post('/api/v1/leads').set(ravi.auth).send({ name: 'Gupta Traders', phone: '9876500088' })).body;

    // Someone without the lead cannot add people to it
    expect((await http().post(`/api/v1/leads/${lead.id}/team`).set(sita.auth).send({ userId: sita.user.id })).status).toBe(404);

    // Ravi adds his senior Mohan, then Sita: Ravi stays the owner, all three see and work on it
    const added = await http().post(`/api/v1/leads/${lead.id}/team`).set(ravi.auth).send({ userId: mohan.user.id });
    expect(added.status).toBe(201);
    expect(added.body.ownerId).toBe(ravi.user.id);
    expect(added.body.assignments.at(-1)).toMatchObject({ kind: 'added', from: null, to: mohan.user.id, by: ravi.user.id });
    expect((await http().post(`/api/v1/leads/${lead.id}/team`).set(ravi.auth).send({ userId: sita.user.id })).status).toBe(201);
    for (const who of [ravi, mohan, sita]) expect(await leadsOf(who)).toEqual(['Gupta Traders']);
    expect(await leadsOf(amit)).toEqual([]);
    expect((await http().patch(`/api/v1/leads/${lead.id}`).set(mohan.auth).send({ status: 'contacted' })).status).toBe(200);

    // Mohan is told and can call straight away
    const n = (await notes(mohan)).find((x) => x.type === 'lead_assigned');
    expect(n.title).toContain('Gupta Traders');
    expect(n.body).toContain('Ravi added you');
    expect(n.data).toMatchObject({ leadId: lead.id, phone: '+919876500088', action: 'call' });

    // Adding the same person twice, or someone outside the company, is refused
    expect((await http().post(`/api/v1/leads/${lead.id}/team`).set(ravi.auth).send({ userId: mohan.user.id })).status).toBe(400);
    expect((await http().post(`/api/v1/leads/${lead.id}/team`).set(ravi.auth).send({ userId: '64b000000000000000000000' })).status).toBe(400);
    // Anyone on the lead can bring in someone else too
    expect((await http().post(`/api/v1/leads/${lead.id}/team`).set(mohan.auth).send({ userId: amit.user.id })).status).toBe(201);

    // Only the admin takes people off (people may leave themselves); the owner cannot be removed this way
    expect((await http().delete(`/api/v1/leads/${lead.id}/team/${amit.user.id}`).set(ravi.auth)).status).toBe(403);
    expect((await http().delete(`/api/v1/leads/${lead.id}/team/${ravi.user.id}`).set(admin.auth)).status).toBe(400);
    expect((await http().delete(`/api/v1/leads/${lead.id}/team/${amit.user.id}`).set(admin.auth)).status).toBe(200);
    expect((await http().delete(`/api/v1/leads/${lead.id}/team/${sita.user.id}`).set(sita.auth)).status).toBe(200);
    expect(await leadsOf(amit)).toEqual([]);
    expect(await leadsOf(sita)).toEqual([]);
    const final = (await http().get(`/api/v1/leads/${lead.id}`).set(admin.auth)).body;
    expect(final.assignments.at(-1)).toMatchObject({ kind: 'removed', from: sita.user.id, to: null, by: sita.user.id });
    expect(final.assignees.sort()).toEqual([mohan.user.id, ravi.user.id].sort());
  });

  it('the AI assistant only finds leads the person may see', async () => {
    const { TOOLS } = await import('../src/modules/ai/tools.js');
    const { User } = await import('../src/models/index.js');
    const admin = await registerOrg();
    const ravi = await addUser(admin, { role: 'sales_executive', name: 'Ravi' });
    await http().post('/api/v1/leads').set(admin.auth).send({ name: 'Hidden Lead' });
    await http().post('/api/v1/leads').set(ravi.auth).send({ name: 'Ravi Lead' });
    const me = await User.findById(ravi.user.id).lean();
    const boss = await User.findById(admin.user.id).lean();
    expect((await TOOLS.list_leads.handler({ orgId: admin.org.id, user: me }, {})).map((l) => l.name)).toEqual(['Ravi Lead']);
    expect((await TOOLS.list_leads.handler({ orgId: admin.org.id, user: boss }, {})).map((l) => l.name).sort()).toEqual(['Hidden Lead', 'Ravi Lead']);
  });
});
