import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { activate, pause, resume, editSchedule, processRelease, type InitialRelease, type ReleaseState } from '../domain/release.ts';
import type { Schedule } from '../domain/schedule.ts';
import { selectEpisodes, type Selection } from '../domain/selection.ts';
import type { ImportedEpisode } from './catalog.ts';

type Row = {
  id: string; source_id: string; source_revision: number; schedule_json: string; selection_json: string;
  live: number; paused: number; waiting: number; next_slot: string; revision: number; publication_version: number;
};
export type Snapshot = {
  id: string; sourceId: string; sourceRevision: number; revision: number;
  state: ReleaseState; selection: Selection; live: boolean; episodes: ImportedEpisode[];
};
export type SubscriptionOptions = { schedule: Schedule; selection: Selection; live: boolean; choice: InitialRelease };
export type Change =
  | { kind: 'pause' }
  | { kind: 'resume'; choice: InitialRelease }
  | { kind: 'schedule'; schedule: Schedule }
  | { kind: 'selection'; selection: Selection; live: boolean };

function validateSelection(selection: Selection, live: boolean, episodes: readonly ImportedEpisode[]): void {
  if (selection.mode === 'before' && live) throw new RangeError('Before-boundary subscriptions cannot check live sources');
  if (selection.mode === 'choose' && selection.ids.some(id => !episodes.some(episode => episode.id === id))) {
    throw new RangeError('Selected episode unavailable');
  }
  selectEpisodes(episodes, selection);
}

export class Subscriptions {
  #db: D1Database;
  constructor(db: D1Database) { this.#db = db; }

  async create(owner: string, sourceId: string, options: SubscriptionOptions, now: string): Promise<string> {
    const state = activate(options.schedule, now, options.choice);
    const session = this.#db.withSession('first-primary');
    const rows = await session.batch([
      session.prepare('SELECT id FROM sources WHERE id = ? AND user_id = ?').bind(sourceId, owner),
      session.prepare('SELECT identity AS id, published_at AS publishedAt, title FROM episodes WHERE source_id = ? AND EXISTS (SELECT 1 FROM sources WHERE id = ? AND user_id = ?)').bind(sourceId, sourceId, owner),
    ]);
    if (!rows[0]?.results.length) throw new Error('Source unavailable');
    validateSelection(options.selection, options.live, rows[1]!.results as ImportedEpisode[]);
    const id = crypto.randomUUID();
    await this.#db.batch([
      this.#db.prepare(`INSERT INTO subscriptions
        (id, user_id, source_id, schedule_json, selection_json, live, paused, next_slot, waiting)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`)
        .bind(id, owner, sourceId, JSON.stringify(state.schedule), JSON.stringify(options.selection), Number(options.live), state.nextSlot, Number(state.waiting)),
      this.#db.prepare('INSERT INTO publication_outbox (subscription_id, desired_version) VALUES (?, 0)').bind(id),
    ]);
    return id;
  }

  /** D1 batch reads form one consistent snapshot, starting at the primary. */
  async load(owner: string, id: string): Promise<Snapshot | null> {
    const session = this.#db.withSession('first-primary');
    const results = await session.batch([
      session.prepare(`SELECT s.*, src.revision AS source_revision FROM subscriptions s
        JOIN sources src ON src.id = s.source_id WHERE s.id = ? AND s.user_id = ?`).bind(id, owner),
      session.prepare(`SELECT r.episode_identity AS episodeId, r.delivered_at AS deliveredAt FROM releases r
        JOIN subscriptions s ON s.id = r.subscription_id WHERE s.id = ? AND s.user_id = ? ORDER BY r.sequence`).bind(id, owner),
      session.prepare(`SELECT e.identity AS id, e.published_at AS publishedAt, e.title, e.episode_number AS episodeNumber FROM episodes e
        JOIN subscriptions s ON s.source_id = e.source_id WHERE s.id = ? AND s.user_id = ?`).bind(id, owner),
    ]);
    const row = results[0]?.results[0] as Row | undefined;
    if (!row) return null;
    return {
      id, sourceId: row.source_id, sourceRevision: row.source_revision, revision: row.revision,
      selection: JSON.parse(row.selection_json) as Selection, live: Boolean(row.live),
      episodes: results[2]!.results as ImportedEpisode[],
      state: {
        schedule: JSON.parse(row.schedule_json) as Schedule, paused: Boolean(row.paused),
        nextSlot: row.next_slot, waiting: Boolean(row.waiting), publicationVersion: row.publication_version,
        releases: results[1]!.results as unknown as ReleaseState['releases'],
      },
    };
  }

  async process(owner: string, id: string, expectedRevision: number, now: string): Promise<boolean> {
    const snapshot = await this.load(owner, id);
    if (!snapshot || snapshot.revision !== expectedRevision) return false;
    const selected = selectEpisodes(snapshot.episodes, snapshot.selection);
    return this.#commit(owner, snapshot, processRelease(snapshot.state, selected, now), snapshot.selection, snapshot.live);
  }

  async change(owner: string, id: string, expectedRevision: number, change: Change, now: string): Promise<boolean> {
    const snapshot = await this.load(owner, id);
    if (!snapshot || snapshot.revision !== expectedRevision) return false;
    let state = snapshot.state;
    let selection = snapshot.selection;
    let live = snapshot.live;
    switch (change.kind) {
      case 'pause': state = pause(state); break;
      case 'resume': state = resume(state, now, change.choice); break;
      case 'schedule': state = editSchedule(state, change.schedule, now); break;
      case 'selection':
        validateSelection(change.selection, change.live, snapshot.episodes);
        selection = change.selection; live = change.live; break;
      default: throw new RangeError('Unsupported subscription change');
    }
    return this.#commit(owner, snapshot, state, selection, live);
  }

  async #commit(owner: string, snapshot: Snapshot, state: ReleaseState, selection: Selection, live: boolean): Promise<boolean> {
    const mutation = crypto.randomUUID();
    const revision = snapshot.revision + 1;
    const statements: D1PreparedStatement[] = [this.#db.prepare(`UPDATE subscriptions SET
      schedule_json = ?, selection_json = ?, live = ?, paused = ?, next_slot = ?, waiting = ?,
      revision = revision + 1, publication_version = ?, mutation_id = ?
      WHERE id = ? AND user_id = ? AND revision = ?
      AND EXISTS (SELECT 1 FROM users WHERE users.id = subscriptions.user_id AND disabled = 0)
      AND EXISTS (SELECT 1 FROM sources WHERE id = source_id AND revision = ?)`)
      .bind(JSON.stringify(state.schedule), JSON.stringify(selection), Number(live), Number(state.paused), state.nextSlot,
        Number(state.waiting), state.publicationVersion, mutation, snapshot.id, owner, snapshot.revision, snapshot.sourceRevision)];
    const release = state.releases[snapshot.state.releases.length];
    if (release) {
      statements.push(this.#db.prepare(`INSERT INTO releases
        (subscription_id, source_id, episode_identity, delivered_at, sequence, output_guid)
        SELECT id, source_id, ?, ?, ?, ? FROM subscriptions WHERE id = ? AND user_id = ? AND revision = ? AND mutation_id = ?`)
        .bind(release.episodeId, release.deliveredAt, state.releases.length, crypto.randomUUID(), snapshot.id, owner, revision, mutation));
      statements.push(this.#db.prepare(`UPDATE publication_outbox SET desired_version = ?
        WHERE subscription_id = ? AND EXISTS
        (SELECT 1 FROM subscriptions WHERE id = ? AND user_id = ? AND revision = ? AND mutation_id = ?)`)
        .bind(state.publicationVersion, snapshot.id, snapshot.id, owner, revision, mutation));
    }
    const result = await this.#db.batch(statements);
    return result[0]!.meta.changes === 1;
  }
}
