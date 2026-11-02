import { useEffect, useRef, useState } from 'react';
import type { MetaPreview } from '../store';
import { OMDB_SETTINGS_CHANGED_EVENT } from '../services/omdb';
import { IMDB_DATASET_RATINGS_CHANGED_EVENT } from '../services/imdb-dataset';
import { canFetchImdbRatings, getImdbRatingDetails } from '../services/imdb-ratings';
import { formatRatingVotes, getDisplayRating, ratingDescription, type ImdbRatingDetails, type RatingItem } from '../services/rating-policy';
import { resolveTmdbImdbId } from '../services/tmdb-identity';
import './RatingBadge.css';

interface RatingBadgeProps {
  item: Pick<MetaPreview, 'id' | 'type' | 'imdbId'> & RatingItem;
  variant?: 'poster' | 'inline';
}

export default function RatingBadge({ item, variant = 'poster' }: RatingBadgeProps) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; version: number; rating: ImdbRatingDetails | null } | null>(null);
  const explicitImdbId = item.imdbId || (/^tt\d+$/i.test(item.id) ? item.id : undefined);
  const key = `${item.type}:${item.id}:${explicitImdbId ?? ''}`;

  useEffect(() => {
    const onSettingsChanged = () => setSettingsVersion((version) => version + 1);
    window.addEventListener(OMDB_SETTINGS_CHANGED_EVENT, onSettingsChanged);
    window.addEventListener(IMDB_DATASET_RATINGS_CHANGED_EVENT, onSettingsChanged);
    return () => {
      window.removeEventListener(OMDB_SETTINGS_CHANGED_EVENT, onSettingsChanged);
      window.removeEventListener(IMDB_DATASET_RATINGS_CHANGED_EVENT, onSettingsChanged);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let started = false;
    const loadRating = async () => {
      if (started || cancelled) return;
      started = true;
      try {
        // An explicit IMDb ID can still use its saved score without a configured key.
        if (!explicitImdbId && !(await canFetchImdbRatings())) return;
        if (cancelled) return;
        const imdbId = await resolveTmdbImdbId({ id: item.id, type: item.type, imdbId: explicitImdbId });
        if (!imdbId || cancelled) return;
        const rating = await getImdbRatingDetails(imdbId);
        if (!cancelled) setLoaded({ key, version: settingsVersion, rating });
      } catch {
        // A missing identity or unavailable service leaves the metadata score visible.
      }
    };
    const element = elementRef.current;
    const observer = element && typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer?.disconnect();
          void loadRating();
        }, { rootMargin: '80px' })
      : null;
    if (observer && element) observer.observe(element);
    else void loadRating();
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [key, item.id, item.type, explicitImdbId, settingsVersion]);

  const rating = getDisplayRating(item, loaded?.key === key && loaded.version === settingsVersion ? loaded.rating : null);
  const description = rating ? ratingDescription(rating) : undefined;
  return (
    <span
      ref={elementRef}
      className={`media-rating media-rating--${variant}${rating ? ` media-rating--${rating.source}` : ' media-rating--empty'}`}
      title={description}
      aria-label={description}
      aria-hidden={!rating || undefined}
    >
      {rating && <>
        <span className="media-rating-score">
          <span className="media-rating-source">{rating.source === 'imdb' ? 'IMDb' : rating.source === 'trakt' ? 'Trakt' : 'TMDB'}</span>
          <strong>{rating.rating.toFixed(1)}</strong>
        </span>
        {rating.votes !== undefined && <span className="media-rating-votes">{formatRatingVotes(rating.votes)} votes</span>}
      </>}
    </span>
  );
}
