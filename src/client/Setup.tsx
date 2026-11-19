import { useEffect, useRef, useState } from 'react';
import { isLocal, api, errorMessage } from './api.ts';
import { EpisodeSelection, ScheduleEditor, PodcastCover, type Episode } from './Podcasts.tsx';
import { selectEpisodes, type Selection } from '../domain/selection.ts';
import type { Schedule } from '../domain/schedule.ts';
import { scheduleLabel } from './schedule-label.ts';
export function AddPodcast({ close, added }: { close: () => void; added: (id: string) => void }) {
  const modal = useRef<HTMLElement>(null);
  const [step, setStep] = useState(0); const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
  const [title, setTitle] = useState(''); const [sourceId, setSourceId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>({ mode: 'all' });
  const [schedule, setSchedule] = useState<Schedule>({ kind: 'weekly', weekdays: [1], hour: 12, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const [choice, setChoice] = useState<'now' | 'next'>('next'); const [live, setLive] = useState(false);
  const [url, setUrl] = useState('');
  const [backgroundProcessing, setBackgroundProcessing] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    api<{ backgroundProcessing: boolean }>('/podcasts').then(data => { setBackgroundProcessing(data.backgroundProcessing); }).catch(e => setError(errorMessage(e)));
    const previous = document.activeElement as HTMLElement | null; modal.current?.querySelector<HTMLElement>('input')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { close(); return; } if (event.key !== 'Tab') return;
      const items = [...(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') ?? [])];
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyboard); return () => { document.removeEventListener('keydown', keyboard); previous?.focus(); };
  }, []);
  async function load() {
    setBusy(true); setError('');
    try {
      const data = await api<{ sourceId?: string; artworkUrl?: string | null; title: string; episodes: Episode[] }>('/sources/preview', { url: url.trim() });
      setArtworkUrl(data.artworkUrl ?? null); setTitle(data.title); setEpisodes(data.episodes); setSourceId(data.sourceId ?? null); setSelection({ mode: 'all' }); setLive(false); setUrl(''); setStep(1);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError('');
    try { const data = await api<{ id: string }>('/podcasts', { sourceId, schedule, selection, live: selection.mode === 'before' ? false : live, choice }); added(data.id); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><section ref={modal} className="modal" role="dialog" aria-modal="true" aria-labelledby="setup-title"><div className="modal-top"><span className="eyebrow">Add podcast</span><button className="icon-button" aria-label="Close podcast setup" disabled={busy} onClick={close}>×</button></div><h2 id="setup-title">{['Import a podcast', 'Choose episodes', 'Set the release schedule', 'Review podcast setup'][step]}</h2><ol className="steps">{['Podcast', 'Episodes', 'Schedule', 'Ready'].map((name, i) => <li key={name} className={step === i ? 'current' : ''}>{i + 1} <span>{name}</span></li>)}</ol>
    {step === 0 ? <><form onSubmit={e => { e.preventDefault(); load(); }}><label>Podcast RSS URL<input name="feed-url" type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="Paste a podcast RSS URL" autoComplete="off" spellCheck={false} /></label><div className="source-actions"><button disabled={busy || !url.trim()}>{busy ? 'Loading podcast…' : 'Load podcast'}</button></div></form><p className="fine">Your source URL stays private. Only episodes included in the publisher’s current RSS feed can be imported.</p></> : step === 1 ? <><div className="imported-summary">{artworkUrl && <PodcastCover title={title} sample={false} artworkUrl={artworkUrl} compact />}<h3>{title}</h3><small>{episodes.length} episodes available</small></div><EpisodeSelection episodes={episodes} value={selection} onChange={setSelection} />{sourceId && <><label className="check"><input type="checkbox" checked={selection.mode !== 'before' && live} disabled={selection.mode === 'before'} onChange={e => setLive(e.target.checked)} />Keep checking for new episodes</label><p className="fine">{selection.mode === 'before' ? 'Before-episode selections are a finite backlog.' : selection.mode === 'choose' ? 'Discoveries will appear in the list for you to select.' : 'New episodes will join your queue automatically.'} {backgroundProcessing ? isLocal ? 'New episodes are checked about hourly while the local server is running.' : 'New episodes are checked about hourly.' : 'Manual checks are available now.'}</p></>}</> : step === 2 ? <ScheduleEditor value={schedule} onChange={setSchedule} episodes={selectEpisodes(episodes, selection)} live={selection.mode !== 'before' && live} releaseNow={choice === 'now'} /> : <><div className="review-show">{artworkUrl && <PodcastCover title={title} sample={false} artworkUrl={artworkUrl} compact />}<h3>{title}</h3><p>{selectEpisodes(episodes, selection).length} episodes · oldest first · {scheduleLabel(schedule)}</p></div><fieldset><legend>When should the first episode arrive?</legend><label className="radio-card"><input type="radio" name="first" checked={choice === 'next'} onChange={() => setChoice('next')} /><span><strong>At the next scheduled time</strong><small>Use the next release date in your schedule.</small></span></label><label className="radio-card"><input type="radio" name="first" checked={choice === 'now'} onChange={() => setChoice('now')} /><span><strong>Release one now</strong><small>Then follow the regular schedule.</small></span></label></fieldset><p className="notice">{isLocal ? 'Your podcast and schedule save locally. ' : 'Your podcast and schedule will be saved. '}{backgroundProcessing && isLocal ? 'Scheduled releases run while the local server is running. ' : ''}Your custom RSS feed will be available on the next screen.</p></>}
    {error && <p role="alert" className="error">{error}</p>}<div className="modal-actions"><button className="text-button" disabled={busy} onClick={step ? () => { setError(''); setStep(step - 1); } : close}>{step ? 'Back' : 'Cancel'}</button>{step > 0 && <button disabled={busy || !selectEpisodes(episodes, selection).length} onClick={step === 3 ? save : () => setStep(step + 1)}>{busy ? 'Saving…' : step === 3 ? 'Add to my podcasts' : 'Continue'} <span aria-hidden>→</span></button>}</div></section></div>;
}
