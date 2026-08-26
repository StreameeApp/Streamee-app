import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { MetaPreview } from '../store';
import {
  enqueueSrrdbQualityEnrichment,
  getXrelQualityBadge,
  getXrelQualitySnapshot,
  registerXrelQualityLookup,
  subscribeXrelQualitySnapshot,
} from '../services/xrel';

interface XrelQualityBadgeProps {
  item: Pick<MetaPreview, 'type' | 'name' | 'year' | 'imdbId' | 'originalName' | 'aliases'>
    & Partial<Pick<MetaPreview, 'id'>>;
  season?: number;
  episode?: number;
  variant?: 'poster' | 'inline';
  queuePriority?: 'normal' | 'library';
}

function badgeTier(rank: number): 'early' | 'standard' | 'uhd' | 'premium' {
  if (rank < 35) return 'early';
  if (rank >= 88) return 'premium';
  if (rank >= 80) return 'uhd';
  return 'standard';
}

function tooltipText(
  badge: NonNullable<ReturnType<typeof getXrelQualityBadge>>
): string {
  const technicalDetails = [
    badge.resolution,
    badge.dynamicRange,
    badge.source,
    badge.codec,
    badge.audio,
  ].filter((value, index, values): value is string => !!value && values.indexOf(value) === index);
  const scope = badge.season !== undefined
    ? `Season ${badge.season}${badge.episode !== undefined ? `, episode ${badge.episode}` : ''}`
    : null;
  const match = badge.matchMethod === 'imdb'
    ? 'Matched by IMDb ID'
    : badge.matchMethod === 'title-year'
      ? 'Matched by title and year'
      : 'Matched by title';
  const language = badge.language === 'unknown'
    ? 'Language not tagged'
    : `${badge.language[0].toUpperCase()}${badge.language.slice(1)} release`;
  const provider = badge.provider === 'srrdb' ? 'Source: srrDB' : 'Source: xREL';
  const lookup = badge.lookupTier === 'precise'
    ? 'Lookup: precise title verification'
    : badge.lookupTier === 'background'
      ? 'Lookup: background poster queue'
      : 'Lookup: release feed';
  const upgrade = badge.previousLabel ? `Recently upgraded: ${badge.previousLabel} → ${badge.label}` : null;
  return [
    'Best known release',
    technicalDetails.join(' · '),
    scope,
    language,
    provider,
    lookup,
    match,
    `Verified ${new Date(badge.verifiedAt).toLocaleString()}`,
    `Published ${new Date(badge.updatedAt).toLocaleString()}`,
    upgrade,
    badge.dirname,
  ].filter(Boolean).join('\n');
}

export default function XrelQualityBadge({
  item,
  season,
  episode,
  variant = 'poster',
  queuePriority = 'normal',
}: XrelQualityBadgeProps) {
  const queueAnchorRef = useRef<HTMLSpanElement>(null);
  const unregisterRef = useRef<() => void>(() => {});
  const registeredPriorityRef = useRef<'nearby' | 'visible' | 'library' | null>(null);
  const snapshot = useSyncExternalStore(
    subscribeXrelQualitySnapshot,
    getXrelQualitySnapshot,
    getXrelQualitySnapshot,
  );
  const badge = getXrelQualityBadge(item, { season, episode });

  useEffect(() => {
    if (!snapshot.enabled || variant !== 'poster' || !badge || badge.rank >= 96) return;
    enqueueSrrdbQualityEnrichment(
      item,
      queuePriority === 'library' ? 'library' : 'visible',
    );
  }, [badge?.rank, item.aliases, item.id, item.imdbId, item.name, item.originalName, item.type, item.year, queuePriority, snapshot.enabled, variant]);

  useEffect(() => {
    if (!snapshot.enabled || variant !== 'poster' || badge) return;
    const anchor = queueAnchorRef.current;
    if (!anchor) return;
    const register = (priority: 'nearby' | 'visible' | 'library') => {
      if (registeredPriorityRef.current === priority) return;
      unregisterRef.current();
      unregisterRef.current = registerXrelQualityLookup(item, priority);
      registeredPriorityRef.current = priority;
    };
    const unregister = () => {
      unregisterRef.current();
      unregisterRef.current = () => {};
      registeredPriorityRef.current = null;
    };
    if (typeof IntersectionObserver === 'undefined') {
      register(queuePriority === 'library' ? 'library' : 'visible');
      return unregister;
    }
    let isNearby = false;
    let isVisible = false;
    const syncRegistration = () => {
      if (isVisible) {
        register(queuePriority === 'library' ? 'library' : 'visible');
      } else if (isNearby) {
        register(queuePriority === 'library' ? 'library' : 'nearby');
      } else {
        unregister();
      }
    };
    const nearbyObserver = new IntersectionObserver((entries) => {
      isNearby = entries[0]?.isIntersecting ?? false;
      syncRegistration();
    }, { rootMargin: '240px 0px' });
    const visibleObserver = new IntersectionObserver((entries) => {
      isVisible = entries[0]?.isIntersecting ?? false;
      syncRegistration();
    });
    nearbyObserver.observe(anchor);
    visibleObserver.observe(anchor);
    return () => {
      nearbyObserver.disconnect();
      visibleObserver.disconnect();
      unregister();
    };
  }, [badge, item.aliases, item.id, item.imdbId, item.name, item.originalName, item.type, item.year, queuePriority, snapshot.enabled, variant]);

  if (!snapshot.enabled) return null;
  if (!badge) {
    return variant === 'poster'
      ? <span ref={queueAnchorRef} className="xrel-quality-queue-anchor" aria-hidden="true" />
      : null;
  }

  return (
    <span
      className={`xrel-quality-badge ${variant === 'inline' ? 'is-inline' : ''}`}
      data-tier={badgeTier(badge.rank)}
      title={tooltipText(badge)}
      aria-label={`Best known release quality: ${badge.label}`}
    >
      {badge.previousLabel && <span className="xrel-quality-badge-new">NEW</span>}
      {badge.label}
    </span>
  );
}
