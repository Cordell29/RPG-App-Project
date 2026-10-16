import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './connection.ts';

const dataDir = process.env.DATA_DIR ?? './data';
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, 'tavern.db'));
const row = db.$client.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number };
console.log(`database at schema version ${row.v}`);
db.$client.close();
