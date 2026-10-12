/**
 * Fills one company with a large amount of realistic CRM data for performance and pagination testing.
 *
 *   MONGO_URI=mongodb://127.0.0.1:27017/cognicrm_perf node scripts/seed-bulk.js <companyCode or orgId> [scale]
 *
 * scale 1 = 100k leads, 50k contacts, 10k accounts, 20k deals, 50k tasks, 20k tickets, 100k calls.
 * Never point this at a production database.
 */
import mongoose from 'mongoose';
import {
  Account, Call, Contact, Deal, Lead, Organization, Task, Ticket, User,
} from '../src/models/index.js';

const uri = process.env.MONGO_URI;
const [target, scaleArg = '1'] = process.argv.slice(2);
if (!uri || !target) {
  console.error('usage: MONGO_URI=… node scripts/seed-bulk.js <companyCode|orgId> [scale]');
  process.exit(1);
}
if (/crm\.cognieos|mongodb\+srv/.test(uri) || !/perf|load|test/i.test(uri)) {
  console.error('Refusing to seed: the database name must contain "perf", "load" or "test".');
  process.exit(1);
}
const scale = Number(scaleArg) || 1;

const FIRST = ['Rahul', 'Priya', 'Amit', 'Sneha', 'Vikram', 'Anjali', 'Rohan', 'Pooja', 'Arjun', 'Kavya', 'Suresh', 'Neha', 'Manoj', 'Divya', 'Karan'];
const LAST = ['Sharma', 'Verma', 'Patel', 'Gupta', 'Singh', 'Reddy', 'Nair', 'Iyer', 'Khan', 'Mehta', 'Joshi', 'Chauhan', 'Das', 'Bose'];
const COMPANIES = ['Traders', 'Industries', 'Solutions', 'Enterprises', 'Retail', 'Foods', 'Logistics', 'Pharma', 'Textiles', 'Tech'];
const pick = (a, i) => a[i % a.length];
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const phone = (i) => `+91${String(9000000000 + ((i * 7919) % 999999999)).slice(0, 10)}`;

async function batchInsert(Model, count, make) {
  const started = Date.now();
  for (let from = 0; from < count; from += 5000) {
    const docs = [];
    for (let i = from; i < Math.min(from + 5000, count); i += 1) docs.push(make(i));
    await Model.insertMany(docs, { ordered: false, lean: true });
  }
  console.log(`${Model.modelName.padEnd(8)} ${count.toLocaleString('en-IN').padStart(9)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

await mongoose.connect(uri);
const org = await Organization.findOne(mongoose.isValidObjectId(target) ? { _id: target } : { companyCode: target });
if (!org) throw new Error(`No company ${target}`);
const users = await User.find({ organizationId: org._id }).select('_id').lean();
const owner = (i) => users[i % users.length]._id;
const organizationId = org._id;
console.log(`Seeding ${org.name} (${org.companyCode}) with ${users.length} users, scale ${scale}`);

await batchInsert(Account, 10000 * scale, (i) => ({
  organizationId, name: `${pick(LAST, i)} ${pick(COMPANIES, i * 3)} ${i}`, industry: pick(COMPANIES, i), phone: phone(i), ownerId: owner(i), createdAt: daysAgo(i % 720),
}));
const accounts = await Account.find({ organizationId }).select('_id').limit(2000).lean();
await batchInsert(Contact, 50000 * scale, (i) => ({
  organizationId, firstName: pick(FIRST, i), lastName: `${pick(LAST, i * 7)}`, email: `contact${i}@example.in`, phone: phone(i + 1e6),
  company: `${pick(LAST, i)} ${pick(COMPANIES, i)}`, accountId: pick(accounts, i)._id, ownerId: owner(i), createdAt: daysAgo(i % 720),
}));
const STATUSES = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost', 'unqualified'];
const SOURCES = ['website', 'referral', 'inbound_call', 'campaign', 'social', 'event', 'cold', 'other'];
await batchInsert(Lead, 100000 * scale, (i) => ({
  organizationId, name: `${pick(FIRST, i)} ${pick(LAST, i * 3)}`, email: `lead${i}@example.in`, phone: phone(i + 2e6),
  company: `${pick(LAST, i * 5)} ${pick(COMPANIES, i * 2)}`, status: pick(STATUSES, i), source: pick(SOURCES, i * 11),
  ownerId: owner(i), score: i % 100, estimatedValue: (i % 50) * 10000, createdAt: daysAgo(i % 720),
}));
const STAGES = ['prospecting', 'qualification', 'proposal', 'negotiation', 'won', 'lost'];
await batchInsert(Deal, 20000 * scale, (i) => ({
  organizationId, name: `Deal ${i} — ${pick(LAST, i)} ${pick(COMPANIES, i)}`, value: (i % 100) * 5000, stage: pick(STAGES, i),
  ownerId: owner(i), accountId: pick(accounts, i)._id, score: i % 100, createdAt: daysAgo(i % 720),
}));
await batchInsert(Task, 50000 * scale, (i) => ({
  organizationId, title: `Follow up ${pick(FIRST, i)} ${i}`, status: pick(['open', 'open', 'done', 'cancelled'], i), priority: pick(['low', 'medium', 'high'], i),
  assigneeId: owner(i), dueAt: daysAgo((i % 60) - 30), reminderSentAt: new Date(), createdAt: daysAgo(i % 720),
}));
await batchInsert(Ticket, 20000 * scale, (i) => ({
  organizationId, subject: `Issue ${i}: ${pick(COMPANIES, i)} order`, status: pick(['open', 'pending', 'resolved', 'closed'], i), priority: pick(['low', 'medium', 'high', 'urgent'], i), createdAt: daysAgo(i % 720),
}));
await batchInsert(Call, 100000 * scale, (i) => ({
  organizationId, direction: pick(['inbound', 'outbound'], i), status: pick(['completed', 'no_answer', 'busy', 'failed'], i),
  customerPhone: phone(i + 3e6), agentId: owner(i), durationSeconds: (i * 13) % 900, startedAt: daysAgo((i % 365) + (i % 24) / 24), createdAt: daysAgo(i % 365),
}));
await mongoose.disconnect();
console.log('done');
