import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
export type User = { id: string; displayName: string; isAdmin: boolean };
const messages: Record<string, string> = { publication_pending: 'Your feed could not publish yet. Please retry in a moment.',
  invalid_feed_url: 'Paste a complete HTTP or HTTPS podcast RSS URL.', blocked_feed_address: 'This feed points to a private or unsupported network address.',
  unsupported_feed_url: 'Use an HTTP or HTTPS feed on the standard web ports.', unsafe_feed_redirect: 'The feed redirected to an unsafe destination.',
  feed_fetch_failed: 'The podcast could not be reached. Check the URL and try again.', feed_timeout: 'The podcast took too long to respond. Please try again.',
  feed_http_error: 'The publisher did not return a working feed. Check your URL or membership access.',
  invalid_xml: 'The publisher returned malformed XML.', unsafe_xml: 'This feed contains an unsupported XML document type.',
  unsupported_feed: 'Use a podcast RSS 2.0 feed rather than a website or Atom feed.', no_episodes: 'No podcast episodes were found in this feed.',
  missing_enclosure: 'An episode is missing its audio enclosure. This feed cannot be imported yet.',
  duplicate_episode_identity: 'The publisher reused an episode identity. Importing would make the queue ambiguous.',
  source_busy: 'This podcast is already being checked. Please try again shortly.', source_limit: 'The local limit is 25 saved podcast sources per account.',
  feed_too_large: 'This feed exceeds the current 8 MB import limit.', too_many_episodes: 'This feed exceeds the current 2,000-episode import limit.',
  import_unavailable: 'Safe feed fetching is not configured for this server.', invalid_media_url: 'The feed contains an unsupported media URL.',

  maintenance: 'RegSched is moving to its new home. Please try again shortly.',
  site_moved: 'RegSched has moved to https://regsched.com. Open the new site to continue.',
  invalid_name: 'Enter an account name of up to 80 characters.',
  signup_closed: 'New accounts are currently closed. Existing accounts can still sign in.',
  fresh_authentication_required: 'Please verify your passkey, then try again.',
  authentication_required: 'Please sign in to continue.', subscription_changed: 'This podcast changed in another window. Reload it and try again.',
  podcast_already_added: 'This sample is already in your library.', bootstrap_unavailable: 'That setup code is unavailable or has already been used.',
  invalid_recovery_code: 'That recovery code is invalid or has already been replaced.',
  rate_limited: 'Too many attempts. Please wait ten minutes before trying again.',
  retain_access_method: 'Keep another passkey or generate a recovery code before removing this passkey.',
};
export class ApiError extends Error {
  constructor(readonly code: string) { super(messages[code] ?? 'That action could not be completed. Please try again.'); }
}
export async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/api' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error);
  return data as T;
}
export async function registration(path: string, body: unknown) {
  const options = await api<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>(path, body);
  const response = await startRegistration({ optionsJSON: options.options });
  return api<{ user: User; recoveryCode?: string }>('/auth/register/verify', { challengeId: options.challengeId, response });
}
export async function authenticate(reauth = false) {
  const base = reauth ? '/auth/reauth' : '/auth/login';
  const options = await api<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>(base + '/options', {});
  const response = await startAuthentication({ optionsJSON: options.options });
  return api<{ user: User }>(base + '/verify', { challengeId: options.challengeId, response });
}
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'InvalidStateError') return 'This device already has a passkey for this account. Try a different device or security key.';
  if (error instanceof Error && (error.name === 'NotAllowedError' || error.message.includes('ceremony'))) return 'The passkey prompt was cancelled or timed out. You can try again.';
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export async function withFreshAuthentication<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'fresh_authentication_required') throw error;
    await authenticate(true);
    return action();
  }
}

export const isStaging = document.documentElement.dataset.environment === 'staging';
export const isLocal = !['staging', 'production'].includes(document.documentElement.dataset.environment ?? 'local');
