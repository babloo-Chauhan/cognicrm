// Sets a user's password from the command line (there is no "forgot password" email yet).
//   node scripts/reset-password.js <email> <new-password>
// Existing sessions of that user are signed out.
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { User } from '../src/models/index.js';

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: node scripts/reset-password.js <email> <new-password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('The password must have at least 8 characters.');
  process.exit(1);
}

await mongoose.connect(env.mongoUri);
const user = await User.findOne({ email: email.toLowerCase() });
if (!user) {
  console.error(`No user with email ${email}`);
  process.exit(1);
}
user.passwordHash = await bcrypt.hash(password, 10);
user.tokenVersion = (user.tokenVersion || 0) + 1;
user.active = true;
await user.save();
console.log(`Password updated for ${user.name} <${user.email}>`);
await mongoose.disconnect();
