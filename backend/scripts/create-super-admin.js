// Creates (or resets the password of) a platform super admin.
// Usage: npm run create-super-admin -- <email> <password> [name] [--allow-weak]
// --allow-weak skips the 12-character minimum (local development only; refused when NODE_ENV=production).
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { PlatformUser } from '../src/models/index.js';

const args = process.argv.slice(2);
const allowWeak = args.includes('--allow-weak') && process.env.NODE_ENV !== 'production';
const [email, password, name = 'Platform Owner'] = args.filter((a) => a !== '--allow-weak');
if (!email || !password || (password.length < 12 && !allowWeak)) {
  console.error('Usage: npm run create-super-admin -- <email> <password (12+ chars)> [name]');
  process.exit(1);
}

await mongoose.connect(env.mongoUri);
const passwordHash = await bcrypt.hash(password, 12);
const existing = await PlatformUser.findOne({ email: email.toLowerCase() });
if (existing) {
  existing.passwordHash = passwordHash;
  existing.active = true;
  existing.tokenVersion += 1;
  await existing.save();
  console.log(`Password reset for super admin ${existing.email}`);
} else {
  await PlatformUser.create({ email: email.toLowerCase(), name, passwordHash, role: 'super_admin' });
  console.log(`Super admin ${email.toLowerCase()} created`);
}
await mongoose.disconnect();
