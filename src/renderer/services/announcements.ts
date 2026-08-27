export type AnnouncementKind = 'info' | 'warning' | 'critical';

export interface Announcement {
  id: string;
  message: string;
  kind: AnnouncementKind;
  startsAt?: string;
  expiresAt?: string;
  linkUrl?: string;
  linkLabel?: string;
}

const ANNOUNCEMENT_TIMEOUT_MS = 4_000;
const MAX_ANNOUNCEMENT_ID_LENGTH = 128;
const MAX_ANNOUNCEMENT_MESSAGE_LENGTH = 2_000;
const MAX_ANNOUNCEMENT_LINK_URL_LENGTH = 2_048;
const MAX_ANNOUNCEMENT_LINK_LABEL_LENGTH = 80;
const configuredAnnouncementUrl = import.meta.env?.VITE_ANNOUNCEMENT_URL?.trim();

export const isAnnouncementServiceConfigured = Boolean(configuredAnnouncementUrl) || Boolean(import.meta.env?.DEV);

const announcementUrl = configuredAnnouncementUrl || 'http://127.0.0.1:8788/v1/announcement';

function optionalIsoDate(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function optionalHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ANNOUNCEMENT_LINK_URL_LENGTH) return undefined;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function normalizeAnnouncement(value: unknown, now = Date.now()): Announcement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const message = typeof candidate.message === 'string' ? candidate.message.trim() : '';
  if (
    !id
    || id.length > MAX_ANNOUNCEMENT_ID_LENGTH
    || !message
    || message.length > MAX_ANNOUNCEMENT_MESSAGE_LENGTH
  ) {
    return null;
  }

  const kind: AnnouncementKind = candidate.kind === 'warning' || candidate.kind === 'critical'
    ? candidate.kind
    : 'info';
  const startsAt = optionalIsoDate(candidate.startsAt);
  const expiresAt = optionalIsoDate(candidate.expiresAt);
  if (startsAt === null || expiresAt === null) return null;
  if (startsAt && Date.parse(startsAt) > now) return null;
  if (expiresAt && Date.parse(expiresAt) <= now) return null;
  const linkUrl = optionalHttpsUrl(candidate.linkUrl);
  const configuredLinkLabel = typeof candidate.linkLabel === 'string' ? candidate.linkLabel.trim() : '';
  const linkLabel = configuredLinkLabel && configuredLinkLabel.length <= MAX_ANNOUNCEMENT_LINK_LABEL_LENGTH
    ? configuredLinkLabel
    : 'Learn more';

  return {
    id,
    message,
    kind,
    ...(startsAt ? { startsAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(linkUrl ? { linkUrl, linkLabel } : {}),
  };
}

export async function fetchActiveAnnouncement(): Promise<Announcement | null> {
  if (!isAnnouncementServiceConfigured) return null;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), ANNOUNCEMENT_TIMEOUT_MS);

  try {
    const response = await fetch(announcementUrl, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });

    if (response.status === 204) return null;
    if (!response.ok) return null;

    return normalizeAnnouncement(await response.json());
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}
