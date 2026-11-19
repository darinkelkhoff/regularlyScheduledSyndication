import { readFile, readdir } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import { Miniflare } from 'miniflare';

export async function database(t: TestContext) {
  const mf = new Miniflare({
    modules: true, script: 'export default { fetch() { return new Response("test"); } };',
    compatibilityDate: '2026-07-30', d1Databases: ['DB'],
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const migrations = new URL('../../migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(name, migrations), 'utf8'));
  }
  await db.prepare('INSERT INTO users (id, display_name) VALUES (?, ?), (?, ?)').bind('alice', 'Alice', 'bob', 'Bob').run();
  return db;
}
