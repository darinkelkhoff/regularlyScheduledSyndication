import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { join } from 'node:path';
import { hashToken } from '../src/auth/tokens.ts';

/** Local workerd only; migrations in this project keep each SQL statement on one line. */
export async function localDatabase(directory: string) {
  const runtime = new Miniflare({
    modules: true, script: 'export default { fetch() { return new Response("local database"); } };',
    compatibilityDate: '2026-07-30', d1Databases: ['DB'], d1Persist: directory, r2Buckets: ['FEEDS'], r2Persist: join(directory, 'r2'), host: '127.0.0.1', port: 0,
  });
  try {
    const db = await runtime.getD1Database('DB');
    await db.prepare('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)').run();
    const migrations = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(name, migrations), 'utf8');
      const checksum = await hashToken(sql);
      const applied = await db.prepare('SELECT checksum FROM local_migrations WHERE name = ?').bind(name).first<{ checksum: string }>();
      if (applied) {
        if (applied.checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      const statements = sql.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('--'));
      await db.batch([
        ...statements.map(statement => db.prepare(statement)),
        db.prepare('INSERT INTO local_migrations (name, checksum) VALUES (?, ?)').bind(name, checksum),
      ]);
    }
    return { runtime, db, bucket: await runtime.getR2Bucket('FEEDS') };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
