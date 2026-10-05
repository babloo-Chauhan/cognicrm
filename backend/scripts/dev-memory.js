// Runs the API against an in-memory MongoDB (no local MongoDB needed). Data is lost on exit.
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
process.env.MONGO_URI = mongo.getUri('cognieos');
console.log(`In-memory MongoDB at ${process.env.MONGO_URI}`);
await import('../index.js');
