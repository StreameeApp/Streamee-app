import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { FiHeart, FiEye, FiEyeOff, FiFilm, FiTv, FiSearch, FiRefreshCw, FiArrowUp, FiUser, FiList } from 'react-icons/fi';
import { useStore, MetaPreview } from '../../store';
import XrelQualityBadge from '../../components/XrelQualityBadge';
import { getContinueWatchingProgress } from '../../services/progress';
import {
  getTmdbSearch,
  getTmdbDiscovery,
  getTmdbLanguages,
  getTmdbPersonCredits,
  searchTmdbPeople,
  type TmdbPerson,
  type TmdbPersonCreditPreview,
  TMDB_GENRES
} from '../../services/tmdb';
import { isTmdbSearchQueryReady } from '../../services/tmdb-request-policy';
import { pushUnwatchedToTrakt, pushWatchedToTrakt, pushWatchlistToTrakt } from '../../services/trakt-sync';
import {
  getTraktListPreviewPosters,
  searchTraktListsResult,
  streamTraktListItems,
  type TraktListSearchResult
} from '../../services/trakt';
import {
  DISCOVERY_CONTENT_CHANGED_EVENT,
  filterDiscoveryItems,
  getDiscoveryContentMode,
  type DiscoveryContentMode,
} from '../../services/discovery-content';
import './Search.css';

const YEARS = Array.from({ length: 30 }, (_, i) => new Date().getFullYear() - i);
const LIST_YEARS = Array.from(
  { length: new Date().getFullYear() - 1898 },
  (_, index) => new Date().getFullYear() + 1 - index
);
const RELEASE_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
});
const LIST_SEARCH_PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 500;
type DiscoverFilter = 'all' | 'movie' | 'tv' | 'actor' | 'list';
type ActorCreditFilter = 'all' | 'movie' | 'series';
type ListItemFilter = 'all' | 'movie' | 'series';
type ListWatchFilter = 'all' | 'watched' | 'unwatched';
type ListSort = 'list' | 'rating' | 'title' | 'release';

function formatReleaseDate(dateStr?: string): string {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return RELEASE_DATE_FORMATTER.format(date);
  } catch {
    return dateStr;
  }
}

const Discover: React.FC = () => {
  const { setSelectedMeta, watchlist, addToWatchlist, removeFromWatchlist, watched, addToWatched, removeFromWatched, continueWatching, discoverScrollPosition, setDiscoverScrollPosition, discoverItems, setDiscoverItems, setDiscoverPage, discoverCacheKey, setDiscoverCacheKey, discoverFilter, setDiscoverFilter, discoverMode, setDiscoverMode, discoverGenre, setDiscoverGenre, discoverYear, setDiscoverYear, discoverLanguage, setDiscoverLanguage, discoverMinRating, discoverMaxRating, setDiscoverRatingRange, discoverSearchQuery, setDiscoverSearchQuery, discoverListState, updateDiscoverListState, resetDiscoverListState, view, discoverPage, traktConnected } = useStore();
  const [discoveryContentMode, setDiscoveryContentMode] = useState(getDiscoveryContentMode);
  const [items, setItems] = useState<MetaPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [backToTopTop, setBackToTopTop] = useState(0);
  const [people, setPeople] = useState<TmdbPerson[]>([]);
  const [selectedActor, setSelectedActor] = useState<TmdbPerson | null>(null);
  const [actorCredits, setActorCredits] = useState<TmdbPersonCreditPreview[]>([]);
  const [actorCreditsLoading, setActorCreditsLoading] = useState(false);
  const [actorCreditsError, setActorCreditsError] = useState<string | null>(null);
  const [actorCreditFilter, setActorCreditFilter] = useState<ActorCreditFilter>('all');
  const [lists, setLists] = useState<TraktListSearchResult[]>(discoverListState.lists);
  const [listSearchError, setListSearchError] = useState<string | null>(null);
  const [selectedList, setSelectedList] = useState<TraktListSearchResult | null>(discoverListState.selectedList);
  const [listItems, setListItems] = useState<MetaPreview[]>(discoverListState.items);
  const [listItemsLoading, setListItemsLoading] = useState(false);
  const [listItemsStreaming, setListItemsStreaming] = useState(false);
  const [listItemsTotal, setListItemsTotal] = useState(discoverListState.total);
  const [listItemsError, setListItemsError] = useState<string | null>(null);
  const [listItemFilter, setListItemFilter] = useState<ListItemFilter>(discoverListState.itemFilter);
  const [listGenre, setListGenre] = useState<number | null>(discoverListState.genre);
  const [listYear, setListYear] = useState<number | null>(discoverListState.year);
  const [listLanguage, setListLanguage] = useState<string | null>(discoverListState.language);
  const [listMinRating, setListMinRating] = useState(discoverListState.minRating);
  const [listMaxRating, setListMaxRating] = useState(discoverListState.maxRating);
  const [listWatchFilter, setListWatchFilter] = useState<ListWatchFilter>(discoverListState.watchFilter);
  const [listSort, setListSort] = useState<ListSort>(discoverListState.sort);
  const pageRef = useRef(discoverPage);
  const loadingRef = useRef(false);
  const fetchRequestIdRef = useRef(0);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const lastLoadRef = useRef(0);
  const initialLoadDone = useRef(false);
  const handledCacheKeyRef = useRef('');
  const restoredScrollRef = useRef(false);
  const actorCreditsSectionRef = useRef<HTMLElement | null>(null);
  const listItemsSectionRef = useRef<HTMLElement | null>(null);
  const actorRequestIdRef = useRef(0);
  const listRequestIdRef = useRef(0);
  const listStreamAbortRef = useRef<AbortController | null>(null);
  const listStreamResumePageRef = useRef(1);
  const restoredListSessionRef = useRef(false);

  useEffect(() => {
    const handleContentModeChange = (event: Event) => {
      const mode = (event as CustomEvent<DiscoveryContentMode>).detail;
      setDiscoveryContentMode(mode || getDiscoveryContentMode());
    };
    window.addEventListener(DISCOVERY_CONTENT_CHANGED_EVENT, handleContentModeChange);
    return () => window.removeEventListener(DISCOVERY_CONTENT_CHANGED_EVENT, handleContentModeChange);
  }, []);
  
  const [filter, setLocalFilter] = useState<DiscoverFilter>(discoverFilter);
  const [mode, setLocalMode] = useState<'search' | 'browse'>(discoverMode);
  const [searchQuery, setLocalSearchQuery] = useState(discoverSearchQuery);
  const [committedSearchQuery, setCommittedSearchQuery] = useState(discoverSearchQuery.trim());
  const [selectedGenre, setLocalGenre] = useState<number | null>(discoverGenre);
  const [selectedYear, setLocalYear] = useState<number | null>(discoverYear);
  const [selectedLanguage, setLocalLanguage] = useState<string | null>(discoverLanguage);
  const [minRating, setMinRating] = useState(discoverMinRating);
  const [maxRating, setMaxRating] = useState(discoverMaxRating);
  const [languages, setLanguages] = useState<Awaited<ReturnType<typeof getTmdbLanguages>>>(
    []
  );
  const trimmedSearchQuery = committedSearchQuery;
  const actorMode = filter === 'actor';
  const listMode = filter === 'list';
  const searchOnlyMode = actorMode || listMode;
  const cacheKey = useMemo(() => {
    return [
      mode,
      filter,
      selectedGenre ?? 'any',
      selectedYear ?? 'any',
      selectedLanguage ?? 'any',
      minRating,
      maxRating,
      discoveryContentMode,
      'discovery-content-v2',
      trimmedSearchQuery.toLowerCase()
    ].join('::');
  }, [mode, filter, selectedGenre, selectedYear, selectedLanguage, minRating, maxRating, discoveryContentMode, trimmedSearchQuery]);

  const languageLabel = useMemo(() => {
    if (!selectedLanguage) {
      return null;
    }

    return (
      languages.find((lang) => lang.iso_639_1 === selectedLanguage)?.english_name ||
      selectedLanguage.toUpperCase()
    );
  }, [languages, selectedLanguage]);

  const genreOptions = useMemo(() => {
    if (filter === 'movie') {
      return TMDB_GENRES.movie;
    }

    if (filter === 'tv') {
      return TMDB_GENRES.tv;
    }

    return [];
  }, [filter]);

  const genreLabel = useMemo(() => {
    if (selectedGenre === null) {
      return null;
    }

    return genreOptions.find((genre) => genre.id === selectedGenre)?.name || 'Genre';
  }, [genreOptions, selectedGenre]);

  const watchlistIds = useMemo(() => new Set(watchlist.map((item) => item.id)), [watchlist]);
  const watchedIds = useMemo(() => new Set(watched.map((item) => item.id)), [watched]);
  const filteredActorCredits = useMemo(
    () => actorCreditFilter === 'all'
      ? actorCredits
      : actorCredits.filter((credit) => credit.type === actorCreditFilter),
    [actorCreditFilter, actorCredits]
  );
  const actorMovieCount = useMemo(
    () => actorCredits.filter((credit) => credit.type === 'movie').length,
    [actorCredits]
  );
  const actorSeriesCount = actorCredits.length - actorMovieCount;
  const listGenreOptions = useMemo(() => {
    const genreNames = new Map<number, string>();
    [...TMDB_GENRES.movie, ...TMDB_GENRES.tv].forEach((genre) => {
      if (!genreNames.has(genre.id)) genreNames.set(genre.id, genre.name);
    });
    const availableGenreIds = new Set(listItems.flatMap((item) => item.genreIds || []));
    return Array.from(genreNames, ([id, name]) => ({ id, name }))
      .filter((genre) => availableGenreIds.has(genre.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [listItems]);
  const listYearOptions = useMemo(() => Array.from(new Set([
    ...LIST_YEARS,
    ...listItems.flatMap((item) => item.year ? [Number(item.year)] : [])
  ])).filter(Number.isFinite).sort((a, b) => b - a), [listItems]);
  const listLanguageOptions = useMemo(() => Array.from(new Set(
    listItems.flatMap((item) => item.originalLanguage ? [item.originalLanguage] : [])
  )).sort((a, b) => a.localeCompare(b)), [listItems]);
  const filteredListItems = useMemo(() => {
    const filtered = filterDiscoveryItems(listItems, discoveryContentMode).filter((item) => {
      if (listItemFilter !== 'all' && item.type !== listItemFilter) return false;
      if (listGenre !== null && !item.genreIds?.includes(listGenre)) return false;
      if (listYear !== null && Number(item.year) !== listYear) return false;
      if (listLanguage !== null && item.originalLanguage !== listLanguage) return false;
      if ((listMinRating > 0 || listMaxRating < 10) && (
        item.rating === undefined || item.rating < listMinRating || item.rating > listMaxRating
      )) return false;
      const isWatched = watchedIds.has(item.id);
      if (listWatchFilter === 'watched' && !isWatched) return false;
      if (listWatchFilter === 'unwatched' && isWatched) return false;
      return true;
    });

    if (listSort === 'list') return filtered;
    return [...filtered].sort((a, b) => {
      if (listSort === 'rating') return (b.rating ?? -1) - (a.rating ?? -1);
      if (listSort === 'title') return a.name.localeCompare(b.name);
      return (Date.parse(b.releaseDate || '') || 0) - (Date.parse(a.releaseDate || '') || 0);
    });
  }, [discoveryContentMode, listGenre, listItemFilter, listItems, listLanguage, listMaxRating, listMinRating, listSort, listWatchFilter, listYear, watchedIds]);
  const listMovieCount = useMemo(
    () => listItems.filter((item) => item.type === 'movie').length,
    [listItems]
  );
  const listSeriesCount = listItems.length - listMovieCount;
  const activeFilterChips = useMemo(() => {
    const chips: string[] = [];

    if (mode === 'search' && trimmedSearchQuery) {
      chips.push(`Search: "${trimmedSearchQuery}"`);
    }

    if (filter === 'movie') {
      chips.push('Movies');
    } else if (filter === 'tv') {
      chips.push('TV');
    } else if (filter === 'actor') {
      chips.push('Actors');
    } else if (filter === 'list') {
      chips.push('Lists');
    }

    if (!actorMode && discoveryContentMode === 'anime-only') {
      chips.push('Anime only');
    } else if (!actorMode && discoveryContentMode === 'exclude-anime') {
      chips.push('Anime excluded');
    }

    if (genreLabel) {
      chips.push(genreLabel);
    }

    if (selectedYear) {
      chips.push(String(selectedYear));
    }

    if (languageLabel) {
      chips.push(languageLabel);
    }

    if (minRating > 0 || maxRating < 10) {
      chips.push(`Score ${minRating}-${maxRating}`);
    }

    return chips;
  }, [actorMode, discoveryContentMode, filter, genreLabel, languageLabel, maxRating, minRating, mode, selectedYear, trimmedSearchQuery]);

  const syncModeWithQuery = useCallback(() => {
    const nextQuery = searchQuery.trim();
    setCommittedSearchQuery(nextQuery);
    if (nextQuery) {
      setLocalMode('search');
      setDiscoverMode('search');
      setDiscoverSearchQuery(nextQuery);
      return;
    }

    setLocalMode('browse');
    setDiscoverMode('browse');
    setDiscoverSearchQuery('');
  }, [searchQuery, setDiscoverMode, setDiscoverSearchQuery]);

  const commitRatingRange = useCallback((nextMin: number, nextMax: number) => {
    setDiscoverRatingRange(nextMin, nextMax);
    syncModeWithQuery();
  }, [setDiscoverRatingRange, syncModeWithQuery]);

  const refreshFilters = () => {
    handledCacheKeyRef.current = '';
    pageRef.current = 1;
    initialLoadDone.current = false;
    setHasMore(true);
    setDiscoverItems([]);
    setDiscoverPage(1);
    setDiscoverCacheKey('');
    setDiscoverScrollPosition(0);
    setItems([]);
    setPeople([]);
    setSelectedActor(null);
    setActorCredits([]);
    setActorCreditsError(null);
    setActorCreditFilter('all');
    setLists([]);
    setListSearchError(null);
    setSelectedList(null);
    setListItems([]);
    setListItemsTotal(0);
    setListItemsError(null);
    resetDiscoverListState();
    setLocalFilter('all');
    setDiscoverFilter('all');
    setLocalMode('browse');
    setDiscoverMode('browse');
    setLocalGenre(null);
    setDiscoverGenre(null);
    setLocalYear(null);
    setDiscoverYear(null);
    setLocalLanguage(null);
    setDiscoverLanguage(null);
    setMinRating(0);
    setMaxRating(10);
    setDiscoverRatingRange(0, 10);
  };

  useEffect(() => {
    let active = true;

    getTmdbLanguages().then((result) => {
      if (active) {
        setLanguages(result);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => () => {
    listStreamAbortRef.current?.abort();
    fetchAbortRef.current?.abort();
  }, []);

  const fetchData = useCallback(async (page: number, isLoadMore: boolean = false) => {
    if (loadingRef.current && isLoadMore) return;
    
    const now = Date.now();
    if (isLoadMore && now - lastLoadRef.current < 800) return;
    lastLoadRef.current = now;
    const requestId = ++fetchRequestIdRef.current;
    fetchAbortRef.current?.abort();
    const fetchController = new AbortController();
    fetchAbortRef.current = fetchController;
    loadingRef.current = true;
    
    if (isLoadMore) setLoadingMore(true);
    else setLoading(true);
    
    try {
      let data: MetaPreview[] = [];

      if (mode === 'search' && !isTmdbSearchQueryReady(trimmedSearchQuery)) {
        setLists([]);
        setPeople([]);
        setItems([]);
        setDiscoverItems([]);
        setHasMore(false);
        if (page === 1) initialLoadDone.current = true;
        return;
      }

      if (listMode) {
        if (mode === 'search' && trimmedSearchQuery) {
          const result = await searchTraktListsResult(trimmedSearchQuery, page, LIST_SEARCH_PAGE_SIZE);
          if (requestId !== fetchRequestIdRef.current) return;
          if (!result.success) {
            setListSearchError(result.error || 'Could not search Trakt lists.');
            if (page === 1) {
              setLists([]);
              setHasMore(false);
            }
            if (page === 1) initialLoadDone.current = true;
            return;
          }
          const nextLists = result.data;
          setListSearchError(null);
          setHasMore(page < result.pageCount);

          setLists((prev) => {
            const byId = new Map<number, TraktListSearchResult>();
            for (const list of isLoadMore ? [...prev, ...nextLists] : nextLists) {
              byId.set(list.id, list);
            }
            const mergedLists = Array.from(byId.values());
            updateDiscoverListState({ cacheKey, lists: mergedLists });
            return mergedLists;
          });
          setPeople([]);
          setItems([]);
          setDiscoverItems([]);
          setDiscoverPage(page + 1);
          setDiscoverCacheKey(cacheKey);
          pageRef.current = page + 1;
          if (page === 1) initialLoadDone.current = true;
        } else {
          setLists([]);
          setPeople([]);
          setItems([]);
          setDiscoverItems([]);
          setHasMore(false);
          if (page === 1) initialLoadDone.current = true;
        }

        return;
      }

      if (actorMode) {
        if (mode === 'search' && trimmedSearchQuery) {
          const nextPeople = await searchTmdbPeople(trimmedSearchQuery, page, fetchController.signal);
          if (requestId !== fetchRequestIdRef.current) return;
          if (nextPeople.length === 0) {
            setHasMore(false);
          }

          setPeople((prev) => {
            const byId = new Map<number, TmdbPerson>();
            for (const person of isLoadMore ? [...prev, ...nextPeople] : nextPeople) {
              byId.set(person.id, person);
            }
            return Array.from(byId.values());
          });
          setItems([]);
          setDiscoverItems([]);
          setDiscoverPage(page + 1);
          setDiscoverCacheKey(cacheKey);
          pageRef.current = page + 1;
          if (page === 1) initialLoadDone.current = true;
        } else {
          setPeople([]);
          setItems([]);
          setDiscoverItems([]);
          setHasMore(false);
          if (page === 1) initialLoadDone.current = true;
        }

        return;
      }
      
      if (mode === 'search' && trimmedSearchQuery) {
        data = await getTmdbSearch(trimmedSearchQuery, page, fetchController.signal);
        if (filter === 'movie') {
          data = data.filter(d => d.type === 'movie');
        } else if (filter === 'tv') {
          data = data.filter(d => d.type === 'series');
        }
      } else if (mode === 'browse') {
        data = await getTmdbDiscovery({
          genreId: selectedGenre,
          year: selectedYear,
          language: selectedLanguage,
        }, page, filter === 'all' ? 'all' : filter);
      }

      if (requestId !== fetchRequestIdRef.current) return;
      
      if (data.length === 0) {
        setHasMore(false);
      } else {
        let filteredData = data;
        
        if (mode === 'browse') {
          filteredData = data.filter(item => {
            if (item.rating === undefined) return false;
            const rating = Math.round(item.rating);
            return rating >= minRating && rating <= maxRating;
          });
        }
        
        setItems(prev => {
          const newItems = isLoadMore ? [...prev, ...filteredData!] : filteredData!;
          setDiscoverItems(newItems);
          setDiscoverPage(page + 1);
          setDiscoverCacheKey(cacheKey);
          return newItems;
        });
        pageRef.current = page + 1;
        if (page === 1) initialLoadDone.current = true;
      }
    } catch (error) {
      if (requestId === fetchRequestIdRef.current) {
        console.error('Failed to fetch discover:', error);
      }
    } finally {
      if (requestId === fetchRequestIdRef.current) {
        setLoading(false);
        setLoadingMore(false);
        loadingRef.current = false;
        if (fetchAbortRef.current === fetchController) {
          fetchAbortRef.current = null;
        }
      }
    }
  }, [actorMode, listMode, mode, trimmedSearchQuery, filter, selectedGenre, selectedYear, selectedLanguage, minRating, maxRating, cacheKey, setDiscoverCacheKey, setDiscoverItems, setDiscoverPage, updateDiscoverListState]);

  useEffect(() => {
    if (handledCacheKeyRef.current === cacheKey) {
      return;
    }
    handledCacheKeyRef.current = cacheKey;
    pageRef.current = 1;
    initialLoadDone.current = false;
    restoredScrollRef.current = false;
    setHasMore(true);
    if (
      listMode &&
      discoverListState.cacheKey === cacheKey &&
      discoverListState.lists.length > 0
    ) {
      setLists(discoverListState.lists);
      setSelectedList(discoverListState.selectedList);
      setListItems(discoverListState.items);
      setListItemsTotal(discoverListState.total);
      setListItemFilter(discoverListState.itemFilter);
      setListGenre(discoverListState.genre);
      setListYear(discoverListState.year);
      setListLanguage(discoverListState.language);
      setListMinRating(discoverListState.minRating);
      setListMaxRating(discoverListState.maxRating);
      setListWatchFilter(discoverListState.watchFilter);
      setListSort(discoverListState.sort);
      listStreamResumePageRef.current = discoverListState.resumePage;
      restoredListSessionRef.current = true;
      setPeople([]);
      setItems([]);
      pageRef.current = discoverPage;
      setLoading(false);
      initialLoadDone.current = true;
      return;
    }
    setSelectedActor(null);
    actorRequestIdRef.current += 1;
    setActorCredits([]);
    setActorCreditsError(null);
    setActorCreditFilter('all');
    setSelectedList(null);
    listRequestIdRef.current += 1;
    listStreamAbortRef.current?.abort();
    listStreamAbortRef.current = null;
    setListItems([]);
    setListItemsTotal(0);
    setListItemsError(null);
    setListSearchError(null);
    resetDiscoverListState(cacheKey);
    if (!actorMode && !listMode && discoverItems.length > 0 && discoverCacheKey === cacheKey) {
      setItems(discoverItems);
      setPeople([]);
      setLists([]);
      pageRef.current = discoverPage;
      setLoading(false);
      initialLoadDone.current = true;
      return;
    }

    setDiscoverScrollPosition(0);
    setDiscoverItems([]);
    setDiscoverPage(1);
    setDiscoverCacheKey(cacheKey);
    setItems([]);
    setPeople([]);
    setLists([]);
    fetchData(1);
  }, [actorMode, listMode, mode, filter, selectedGenre, selectedYear, minRating, maxRating, cacheKey, discoverItems, discoverCacheKey, discoverPage, discoverListState, fetchData, resetDiscoverListState, setDiscoverCacheKey, setDiscoverItems, setDiscoverPage]);

  useEffect(() => {
    if (!hasMore || !initialLoadDone.current) return;
    
    const checkScroll = () => {
      if (loadingRef.current) return;
      
      const container = document.querySelector('.main-content');
      if (!container) return;
      
      const scrollTop = container.scrollTop;
      const scrollHeight = container.scrollHeight;
      const clientHeight = container.clientHeight;
      
      if (scrollTop + clientHeight >= scrollHeight - 600) {
        fetchData(pageRef.current, true);
      }
    };
    
    const container = document.querySelector('.main-content');
    if (container) container.addEventListener('scroll', checkScroll);
    
    return () => {
      if (container) container.removeEventListener('scroll', checkScroll);
    };
  }, [fetchData, hasMore, loading, loadingMore]);

  useEffect(() => {
    if (!listMode) return;

    const previewBatch = lists.filter((list) => !list.previewsLoaded).slice(0, 2);
    if (previewBatch.length === 0) return;

    let cancelled = false;
    const hydratePreviews = async () => {
      const hydratedPreviews = await Promise.all(
        previewBatch.map(async (list) => ({
          id: list.id,
          previewPosters: await getTraktListPreviewPosters(list.id)
        }))
      );
      if (cancelled) return;

      const previewsById = new Map(hydratedPreviews.map((preview) => [preview.id, preview.previewPosters]));
      setLists((currentLists) => {
        const hydratedLists = currentLists.map((list) => {
          const previewPosters = previewsById.get(list.id);
          return previewPosters === undefined
            ? list
            : { ...list, previewPosters, previewsLoaded: true };
        });
        updateDiscoverListState({ lists: hydratedLists });
        return hydratedLists;
      });
    };

    void hydratePreviews();
    return () => {
      cancelled = true;
    };
  }, [listMode, lists, updateDiscoverListState]);

  useEffect(() => {
    const container = document.querySelector('.main-content');
    if (!container) {
      return;
    }

    const updateBackToTopVisibility = () => {
      setBackToTopTop(container.scrollTop + container.clientHeight - 78);
      setShowBackToTop(container.scrollTop >= container.clientHeight * 2);
    };

    updateBackToTopVisibility();
    container.addEventListener('scroll', updateBackToTopVisibility, { passive: true });

    return () => {
      container.removeEventListener('scroll', updateBackToTopVisibility);
    };
  }, [view, items.length, loading]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      syncModeWithQuery();
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [searchQuery, syncModeWithQuery]);

  useEffect(() => {
    if (view !== 'search' || discoverScrollPosition <= 0 || !initialLoadDone.current || restoredScrollRef.current) {
      return;
    }

    const container = document.querySelector('.main-content');
    if (!container) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      container.scrollTop = discoverScrollPosition;
      restoredScrollRef.current = true;
    }, 100);

    return () => window.clearTimeout(timeoutId);
  }, [view, discoverScrollPosition, discoverPage]);

  const handleItemClick = (item: MetaPreview) => {
    const container = document.querySelector('.main-content');
    if (container) {
      setDiscoverScrollPosition(container.scrollTop);
    }
    if (listMode && selectedList) {
      updateDiscoverListState({
        itemFilter: listItemFilter,
        genre: listGenre,
        year: listYear,
        language: listLanguage,
        minRating: listMinRating,
        maxRating: listMaxRating,
        watchFilter: listWatchFilter,
        sort: listSort,
      });
    }
    setDiscoverPage(pageRef.current);
    setSelectedMeta({
      id: item.id,
      type: item.type,
      name: item.name,
      poster: item.poster,
      background: item.background,
      year: item.year,
      imdbId: item.imdbId,
      rating: item.rating
    }, 'search');
  };

  const handleActorClick = async (person: TmdbPerson) => {
    const requestId = ++actorRequestIdRef.current;
    setSelectedActor(person);
    setActorCredits([]);
    setActorCreditsError(null);
    setActorCreditFilter('all');
    setActorCreditsLoading(true);

    window.requestAnimationFrame(() => {
      const container = document.querySelector('.main-content');
      const target = actorCreditsSectionRef.current;
      if (!(container instanceof HTMLElement) || !target) {
        return;
      }

      container.scrollTo({
        top: target.offsetTop - 24,
        behavior: 'smooth'
      });
    });

    try {
      const credits = await getTmdbPersonCredits(person.id);
      if (requestId !== actorRequestIdRef.current) return;
      setActorCredits(credits);
      if (credits.length === 0) {
        setActorCreditsError(`No movie or TV credits found for ${person.name}.`);
      }
    } catch (error) {
      if (requestId !== actorRequestIdRef.current) return;
      console.error('Failed to load actor credits:', error);
      setActorCreditsError(`Could not load credits for ${person.name}.`);
    } finally {
      if (requestId === actorRequestIdRef.current) {
        setActorCreditsLoading(false);
      }
    }
  };

  const handleActorCreditClick = (credit: TmdbPersonCreditPreview) => {
    handleItemClick(credit);
  };

  const handleListClick = async (list: TraktListSearchResult, resume: boolean = false) => {
    listStreamAbortRef.current?.abort();
    const streamController = new AbortController();
    listStreamAbortRef.current = streamController;
    const requestId = ++listRequestIdRef.current;
    let receivedFirstBatch = resume;
    setSelectedList(list);
    updateDiscoverListState({ cacheKey, selectedList: list, complete: false });
    if (!resume) {
      setListItems([]);
      setListItemsTotal(list.itemCount);
      updateDiscoverListState({
        items: [],
        total: list.itemCount,
        resumePage: 1,
        itemFilter: 'all',
        genre: null,
        year: null,
        language: null,
        minRating: 0,
        maxRating: 10,
        watchFilter: 'all',
        sort: 'list',
      });
      listStreamResumePageRef.current = 1;
    }
    setListItemsError(null);
    if (!resume) {
      setListItemFilter('all');
      setListGenre(null);
      setListYear(null);
      setListLanguage(null);
      setListMinRating(0);
      setListMaxRating(10);
      setListWatchFilter('all');
      setListSort('list');
    }
    // A resumed partial list can remain interactive, but an empty failed list
    // still needs a visible loading state while its first batch arrives.
    setListItemsLoading(!resume || listItems.length === 0);
    setListItemsStreaming(true);

    if (!resume) window.requestAnimationFrame(() => {
      const container = document.querySelector('.main-content');
      const target = listItemsSectionRef.current;
      if (!(container instanceof HTMLElement) || !target) return;

      container.scrollTo({
        top: target.offsetTop - 24,
        behavior: 'smooth'
      });
    });

    try {
      const result = await streamTraktListItems(list.id, (batch, progress) => {
        if (requestId !== listRequestIdRef.current) return;
        listStreamResumePageRef.current = progress.page;
        updateDiscoverListState({ resumePage: progress.page });
        setListItems((previousItems) => {
          const byId = new Map(previousItems.map((item) => [item.id, item]));
          batch.forEach((item) => byId.set(item.id, item));
          const mergedItems = Array.from(byId.values());
          updateDiscoverListState({ items: mergedItems });
          return mergedItems;
        });
        if (progress.totalKnown) {
          setListItemsTotal(progress.total);
          updateDiscoverListState({ total: progress.total });
        }
        if (progress.phase === 'raw' && !receivedFirstBatch) {
          receivedFirstBatch = true;
          setListItemsLoading(false);
        }
      }, streamController.signal, listStreamResumePageRef.current);
      if (requestId !== listRequestIdRef.current) return;
      if (!result.success) {
        if (result.error === 'cancelled') return;
        setListItemsError(result.error || `Could not load ${list.name}.`);
        return;
      }
      if (result.data === 0) {
        setListItemsError(`No movie or TV titles found in ${list.name}.`);
      } else {
        listStreamResumePageRef.current = 1;
      }
      updateDiscoverListState({ complete: true, resumePage: 1 });
    } catch (error) {
      if (requestId !== listRequestIdRef.current) return;
      console.error('Failed to load Trakt list items:', error);
      setListItemsError(`Could not load ${list.name}.`);
    } finally {
      if (requestId === listRequestIdRef.current) {
        setListItemsLoading(false);
        setListItemsStreaming(false);
        listStreamAbortRef.current = null;
      }
    }
  };

  useEffect(() => {
    if (!restoredListSessionRef.current || !selectedList) return;
    restoredListSessionRef.current = false;
    if (!discoverListState.complete) {
      void handleListClick(selectedList, true);
    }
  }, [discoverListState.complete, selectedList]);

  const handleBackToTop = () => {
    const container = document.querySelector('.main-content');
    if (!container) {
      return;
    }

    container.scrollTo({ top: 0, behavior: 'smooth' });
    setDiscoverScrollPosition(0);
    setShowBackToTop(false);
  };

  const getTitle = (): string => {
    if (listMode && mode === 'search') return `Lists matching "${trimmedSearchQuery}"`;
    if (listMode) return 'Search Trakt Lists';
    if (actorMode && mode === 'search') return `Actors matching "${trimmedSearchQuery}"`;
    if (actorMode) return 'Search Actors';
    if (mode === 'search') return `Results for "${trimmedSearchQuery}"`;
    if (selectedGenre !== null) {
      return [genreLabel || 'Discover', selectedYear ? `${selectedYear}` : '', languageLabel].filter(Boolean).join(' | ');
    }
    if (selectedYear !== null || selectedLanguage !== null) {
      return [selectedYear ? `${selectedYear}` : '', languageLabel].filter(Boolean).join(' | ');
    }
    if (filter === 'movie') return 'Popular Movies';
    if (filter === 'tv') return 'Popular TV';
    return 'Discover';
  };

  const getSubtitle = (): string => {
    if (listMode) {
      return 'Search public lists created by Trakt users, then open one to browse every movie and show inside.';
    }

    if (actorMode) {
      return 'Search by actor name, then open a filmography without leaving Discovery.';
    }

    if (mode === 'search') {
      return 'Search updates automatically after a short pause, and category changes refine results without clearing your query.';
    }

    if (filter === 'all') {
      return 'Start broad with popular picks, then narrow by type, year, language, or score.';
    }

    return 'Fine-tune the catalog with filters that stay visible while you scroll.';
  };

  const resetListFilters = () => {
    setListItemFilter('all');
    setListGenre(null);
    setListYear(null);
    setListLanguage(null);
    setListMinRating(0);
    setListMaxRating(10);
    setListWatchFilter('all');
    setListSort('list');
  };

  const renderListAdvancedFilters = () => (
    <>
      <select
        className="filter-select"
        value={listGenre ?? ''}
        aria-label="Filter list by genre"
        onChange={(event) => setListGenre(event.target.value ? Number(event.target.value) : null)}
      >
        <option value="">All Genres</option>
        {listGenreOptions.map((genre) => (
          <option key={genre.id} value={genre.id}>{genre.name}</option>
        ))}
      </select>
      <select
        className="filter-select"
        value={listYear ?? ''}
        aria-label="Filter list by year"
        onChange={(event) => setListYear(event.target.value ? Number(event.target.value) : null)}
      >
        <option value="">All Years</option>
        {listYearOptions.map((year) => <option key={year} value={year}>{year}</option>)}
      </select>
      <select
        className="filter-select"
        value={listLanguage ?? ''}
        aria-label="Filter list by language"
        onChange={(event) => setListLanguage(event.target.value || null)}
      >
        <option value="">All Languages</option>
        {listLanguageOptions.map((language) => (
          <option key={language} value={language}>
            {languages.find((item) => item.iso_639_1 === language)?.english_name || language.toUpperCase()}
          </option>
        ))}
      </select>
      <select
        className="filter-select"
        value={listWatchFilter}
        aria-label="Filter list by watched status"
        onChange={(event) => setListWatchFilter(event.target.value as ListWatchFilter)}
      >
        <option value="all">All Watch States</option>
        <option value="watched">Watched</option>
        <option value="unwatched">Unwatched</option>
      </select>
      <select
        className="filter-select filter-order-select"
        value={listSort}
        aria-label="Sort list titles"
        onChange={(event) => setListSort(event.target.value as ListSort)}
      >
        <option value="list">List Order</option>
        <option value="rating">Highest Rated</option>
        <option value="title">Title A–Z</option>
        <option value="release">Newest Release</option>
      </select>
      <div className="rating-filter contextual-rating-filter">
        <div className="rating-header">
          <span className="rating-label">User Score</span>
          <span className="rating-value">{listMinRating} - {listMaxRating}</span>
        </div>
        <div className="rating-slider">
          <div
            className="slider-track"
            style={{ '--min': listMinRating, '--max': listMaxRating } as React.CSSProperties}
          >
            <input
              type="range"
              min="0"
              max="10"
              step="1"
              value={listMinRating}
              aria-label="Minimum list user score"
              onChange={(event) => {
                const value = Number(event.target.value);
                setListMinRating(value);
                if (value > listMaxRating) setListMaxRating(value);
              }}
            />
            <input
              type="range"
              min="0"
              max="10"
              step="1"
              value={listMaxRating}
              aria-label="Maximum list user score"
              onChange={(event) => {
                const value = Number(event.target.value);
                setListMaxRating(value);
                if (value < listMinRating) setListMinRating(value);
              }}
            />
          </div>
        </div>
      </div>
      <button
        type="button"
        className="search-refresh-btn contextual-filter-reset"
        aria-label="Reset list filters"
        title="Reset list filters"
        onClick={resetListFilters}
      >
        <FiRefreshCw />
      </button>
    </>
  );

  return (
    <div className="search">
      <header className="search-header">
        <div className="discover-hero">
          <div className="discover-hero-copy">
            <span className="discover-kicker">Discover</span>
            <h1 className="discover-heading">Find Something Worth Watching Faster</h1>
            <p className="discover-subtitle">
              Search directly when you know what you want, or browse popular movies and series with clearer filters.
            </p>
          </div>
        </div>

        <div className="search-toolbar">
          <div className="search-input-wrapper">
            <FiSearch className="search-icon" />
            <input
              type="search"
              className="search-input"
              placeholder={actorMode ? 'Search actors...' : listMode ? 'Search Trakt lists...' : 'Search movies and TV shows...'}
              value={searchQuery}
              name="discover-query"
              autoComplete="off"
              spellCheck={false}
              aria-label={actorMode ? 'Search actors' : listMode ? 'Search Trakt lists' : 'Search movies and TV shows'}
              onChange={(e) => setLocalSearchQuery(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') syncModeWithQuery();
              }}
            />
          </div>
          <button
            type="button"
            className="search-refresh-btn"
            onClick={refreshFilters}
            aria-label="Reset discover filters"
            title="Reset discover filters"
          >
            <FiRefreshCw />
          </button>
        </div>
      </header>

      <div className="discover-filters">
        <div className="filter-group filters-main">
          <div className="filter-row filter-row-primary">
            <span className="filter-row-label">Search</span>
            <div className="filter-row-controls filter-mode-controls">
          <button
            type="button"
            className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
            aria-pressed={filter === 'all'}
            onClick={() => {
              setLocalFilter('all');
              setDiscoverFilter('all');
              setLocalGenre(null);
              setDiscoverGenre(null);
              setSelectedActor(null);
              setActorCredits([]);
              syncModeWithQuery();
            }}
          >
            All
          </button>
          <button
            type="button"
            className={`filter-btn ${filter === 'movie' ? 'active' : ''}`}
            aria-pressed={filter === 'movie'}
            onClick={() => {
              setLocalFilter('movie');
              setDiscoverFilter('movie');
              setSelectedActor(null);
              setActorCredits([]);
              syncModeWithQuery();
            }}
          >
            <FiFilm /> Movies
          </button>
          <button
            type="button"
            className={`filter-btn ${filter === 'tv' ? 'active' : ''}`}
            aria-pressed={filter === 'tv'}
            onClick={() => {
              setLocalFilter('tv');
              setDiscoverFilter('tv');
              setSelectedActor(null);
              setActorCredits([]);
              syncModeWithQuery();
            }}
          >
            <FiTv /> TV
          </button>
          <button
            type="button"
            className={`filter-btn ${filter === 'actor' ? 'active' : ''}`}
            aria-pressed={filter === 'actor'}
            onClick={() => {
              setLocalFilter('actor');
              setDiscoverFilter('actor');
              setLocalGenre(null);
              setDiscoverGenre(null);
              setLocalYear(null);
              setDiscoverYear(null);
              setLocalLanguage(null);
              setDiscoverLanguage(null);
              setMinRating(0);
              setMaxRating(10);
              setDiscoverRatingRange(0, 10);
              syncModeWithQuery();
            }}
          >
            <FiUser /> Actors
          </button>
          <button
            type="button"
            className={`filter-btn ${filter === 'list' ? 'active' : ''}`}
            aria-pressed={filter === 'list'}
            onClick={() => {
              setLocalFilter('list');
              setDiscoverFilter('list');
              setLocalGenre(null);
              setDiscoverGenre(null);
              setLocalYear(null);
              setDiscoverYear(null);
              setLocalLanguage(null);
              setDiscoverLanguage(null);
              setMinRating(0);
              setMaxRating(10);
              setDiscoverRatingRange(0, 10);
              syncModeWithQuery();
            }}
          >
            <FiList /> Lists
          </button>

            </div>
          </div>
          <div className="filter-row filter-row-secondary">
            <span className="filter-row-label">{listMode ? 'List' : 'Refine'}</span>
            <div className="filter-row-controls">
          {listMode && selectedList ? (
            renderListAdvancedFilters()
          ) : searchOnlyMode ? (
            <span className="filter-context-hint">
              {listMode ? 'Open a Trakt list to filter and order its titles.' : 'Actor results are matched by name; open an actor to filter their credits.'}
            </span>
          ) : (
            <>
          <select
            className="filter-select"
            value={selectedGenre ?? ''}
            aria-label="Filter by genre"
            disabled={filter === 'all' || searchOnlyMode}
            onChange={(e) => {
              const val = e.target.value ? Number(e.target.value) : null;
              setLocalGenre(val);
              setDiscoverGenre(val);
              syncModeWithQuery();
            }}
          >
            <option value="">{filter === 'all' || searchOnlyMode ? 'Pick Movies or TV first' : 'Genre'}</option>
            {genreOptions.map(g => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>

          <select
            className="filter-select"
            value={selectedYear ?? ''}
            aria-label="Filter by year"
            disabled={searchOnlyMode}
            onChange={(e) => {
              const val = e.target.value ? Number(e.target.value) : null;
              setLocalYear(val);
              setDiscoverYear(val);
              syncModeWithQuery();
            }}
          >
            <option value="">Year</option>
            {YEARS.map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>

          <select
            className="filter-select"
            value={selectedLanguage ?? ''}
            aria-label="Filter by language"
            disabled={searchOnlyMode}
            onChange={(e) => {
              const val = e.target.value || null;
              setLocalLanguage(val);
              setDiscoverLanguage(val);
              syncModeWithQuery();
            }}
          >
            <option value="">Language</option>
            {languages
              .slice()
              .sort((a, b) => a.english_name.localeCompare(b.english_name))
              .map((lang) => (
                <option key={lang.iso_639_1} value={lang.iso_639_1}>
                  {lang.english_name}
                </option>
              ))}
          </select>

          <div className={`rating-filter ${searchOnlyMode ? 'disabled' : ''}`}>
            <div className="rating-header">
              <span className="rating-label">User Score</span>
              <span className="rating-value">{minRating} - {maxRating}</span>
            </div>
            <div className="rating-slider">
              <div 
                className="slider-track"
                style={{ '--min': minRating, '--max': maxRating } as any}
              >
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="1"
                  value={minRating}
                  aria-label="Minimum user score"
                  disabled={searchOnlyMode}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setMinRating(val);
                    if (val > maxRating) setMaxRating(val);
                  }}
                  onMouseUp={() => {
                    commitRatingRange(minRating, maxRating);
                  }}
                  onTouchEnd={() => commitRatingRange(minRating, maxRating)}
                  onKeyUp={() => commitRatingRange(minRating, maxRating)}
                />
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="1"
                  value={maxRating}
                  aria-label="Maximum user score"
                  disabled={searchOnlyMode}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setMaxRating(val);
                    if (val < minRating) setMinRating(val);
                  }}
                  onMouseUp={() => {
                    commitRatingRange(minRating, maxRating);
                  }}
                  onTouchEnd={() => commitRatingRange(minRating, maxRating)}
                  onKeyUp={() => commitRatingRange(minRating, maxRating)}
                />
              </div>
            </div>
          </div>
            </>
          )}
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="search-loading">
          <div className="loading-spinner" />
          <p>{actorMode ? 'Searching actors...' : listMode ? 'Searching Trakt lists...' : 'Loading picks...'}</p>
        </div>
      ) : listMode ? (
        <>
          <div className="discover-results-header">
            <div>
              <p className="discover-results-kicker">Trakt List Search</p>
              <h2 className="discover-title">{getTitle()}</h2>
              <p className="discover-results-subtitle">{getSubtitle()}</p>
            </div>
          </div>
          {activeFilterChips.length > 0 && (
            <div className="discover-active-filters" aria-label="Active filters">
              {activeFilterChips.map((chip) => (
                <span key={chip} className="discover-chip">{chip}</span>
              ))}
            </div>
          )}
          {listSearchError && lists.length > 0 && (
            <div className="search-empty actor-credits-empty">
              <p>{listSearchError}</p>
            </div>
          )}
          {lists.length === 0 ? (
            <div className="search-empty">
              <h2>{listSearchError ? 'Could not search Trakt lists' : trimmedSearchQuery ? 'No lists found' : 'Search Trakt lists'}</h2>
              <p>
                {listSearchError
                  ? listSearchError
                  : trimmedSearchQuery
                  ? 'Try a shorter phrase or a different list name.'
                  : 'Type a topic or list name above to find public lists made by Trakt users.'}
              </p>
            </div>
          ) : (
            <>
              <div className="trakt-list-grid">
                {lists.map((list) => (
                  <button
                    key={list.id}
                    type="button"
                    className={`trakt-list-card ${selectedList?.id === list.id ? 'active' : ''}`}
                    onClick={() => void handleListClick(list)}
                    aria-label={`Open Trakt list ${list.name}`}
                  >
                    <div className="trakt-list-card-header">
                      <span className="trakt-list-avatar" aria-hidden="true">
                        {list.owner.charAt(0).toUpperCase() || <FiList />}
                      </span>
                      <span className="trakt-list-identity">
                        <span className="trakt-list-title">{list.name}</span>
                        <span className="trakt-list-meta">
                          by {list.owner} · {list.itemCount.toLocaleString()} titles
                        </span>
                      </span>
                      <span className="trakt-list-likes"><FiHeart /> {list.likes.toLocaleString()}</span>
                    </div>
                    <div className="trakt-list-collage" aria-hidden="true">
                      {list.previewPosters.length > 0 ? (
                        list.previewPosters.map((poster) => (
                          <img key={`${list.id}:${poster}`} src={poster} alt="" loading="lazy" />
                        ))
                      ) : (
                        <div className="trakt-list-collage-placeholder"><FiList /></div>
                      )}
                    </div>
                  </button>
                ))}
              </div>

              {selectedList && (
                <section className="trakt-list-items-section" ref={listItemsSectionRef}>
                  <div className="actor-credits-header">
                    <div>
                      <p className="discover-results-kicker">Trakt List</p>
                      <h2 className="discover-title">{selectedList.name}</h2>
                      <p className="discover-results-subtitle">
                        {selectedList.likes.toLocaleString()} likes · {selectedList.itemCount.toLocaleString()} movie and TV titles
                      </p>
                    </div>
                    <div className="actor-credit-tabs list-media-filter" aria-label="Filter titles in this list">
                      <button
                        type="button"
                        className={listItemFilter === 'all' ? 'active' : ''}
                        onClick={() => setListItemFilter('all')}
                      >
                        All {listItems.length}
                      </button>
                      <button
                        type="button"
                        className={listItemFilter === 'movie' ? 'active' : ''}
                        onClick={() => setListItemFilter('movie')}
                      >
                        <FiFilm /> Movies {listMovieCount}
                      </button>
                      <button
                        type="button"
                        className={listItemFilter === 'series' ? 'active' : ''}
                        onClick={() => setListItemFilter('series')}
                      >
                        <FiTv /> TV {listSeriesCount}
                      </button>
                    </div>
                  </div>

                  <div className="filter-group trakt-list-filter-mirror">
                    <div className="filter-row filter-row-secondary">
                      <span className="filter-row-label">List</span>
                      <div className="filter-row-controls">
                        {renderListAdvancedFilters()}
                      </div>
                    </div>
                  </div>

                  <div className="trakt-list-filter-summary" aria-live="polite">
                    {listItemsStreaming && listItems.length > 0 && (
                      <span className="trakt-list-streaming">
                        <span className="trakt-list-streaming-dot" /> Loading remaining titles
                      </span>
                    )}
                    <span className="trakt-list-filter-count">
                      {filteredListItems.length.toLocaleString()} matches · {listItems.length.toLocaleString()} of {listItemsTotal.toLocaleString()} loaded
                    </span>
                  </div>

                  {listItemsLoading ? (
                    <div className="search-loading actor-credits-loading">
                      <div className="loading-spinner" />
                      <p>Loading titles...</p>
                    </div>
                  ) : listItemsError && listItems.length === 0 ? (
                    <div className="search-empty actor-credits-empty">
                      <h2>No titles found</h2>
                      <p>{listItemsError}</p>
                      <button className="load-more-btn" onClick={() => selectedList && void handleListClick(selectedList, true)}>
                        Resume Loading Titles
                      </button>
                    </div>
                  ) : (
                    <>
                      {filteredListItems.length === 0 ? (
                        <div className="search-empty actor-credits-empty">
                          <h2>No matching titles</h2>
                          <p>No loaded titles match the current list filters.</p>
                        </div>
                      ) : (
                        <div className="catalog-grid">
                        {filteredListItems.map((item) => {
                          const isTraktOnly = item.id.startsWith('trakt:');
                          const isInWatchlist = watchlistIds.has(item.id);
                          const isWatched = watchedIds.has(item.id);
                          const continueProgress = getContinueWatchingProgress(continueWatching, item.id);
                          return (
                            <article key={item.id} className="catalog-item">
                              <button
                                type="button"
                                className="catalog-item-trigger"
                                onClick={() => handleItemClick(item)}
                                disabled={isTraktOnly}
                                title={isTraktOnly ? 'This title is not available in TMDB.' : undefined}
                                aria-label={isTraktOnly ? `${item.name} is not available in TMDB` : `Open details for ${item.name}`}
                              >
                                <div className={`catalog-item-poster ${isWatched ? 'watched' : ''}`}>
                                  {item.poster ? (
                                    <img src={item.poster} alt={item.name} loading="lazy" width={320} height={480} />
                                  ) : (
                                    <div className="catalog-item-placeholder" />
                                  )}
                                  <XrelQualityBadge item={item} />
                                  {item.rating !== undefined && item.rating > 0 && (
                                    <div className="poster-rating-badge">★ {item.rating.toFixed(1)}</div>
                                  )}
                                  {continueProgress !== null && (
                                    <div className="poster-progress" style={{ width: `${continueProgress}%` }} />
                                  )}
                                </div>
                                <span className="catalog-item-title">{item.name}</span>
                                <span className="catalog-item-year">
                                  {item.type === 'movie' ? 'Movie' : 'TV'}{item.releaseDate ? ` · ${formatReleaseDate(item.releaseDate)}` : ''}
                                </span>
                              </button>
                              {!isTraktOnly && (
                                <div className="board-item-actions">
                                  <button
                                    type="button"
                                    className={`board-item-action ${isInWatchlist ? 'active' : ''}`}
                                    aria-label={isInWatchlist ? `Remove ${item.name} from watchlist` : `Add ${item.name} to watchlist`}
                                    aria-pressed={isInWatchlist}
                                    onClick={() => {
                                      if (isInWatchlist) {
                                        removeFromWatchlist(item.id);
                                        if (traktConnected) pushWatchlistToTrakt(item, 'remove').catch(console.error);
                                      } else {
                                        addToWatchlist(item);
                                        if (traktConnected) pushWatchlistToTrakt(item, 'add').catch(console.error);
                                      }
                                    }}
                                  >
                                    <FiHeart />
                                  </button>
                                  <button
                                    type="button"
                                    className={`board-item-action ${isWatched ? 'active' : ''}`}
                                    aria-label={isWatched ? `Mark ${item.name} as unwatched` : `Mark ${item.name} as watched`}
                                    aria-pressed={isWatched}
                                    onClick={async () => {
                                      if (isWatched) {
                                        removeFromWatched(item.id);
                                        if (useStore.getState().traktConnected) await pushUnwatchedToTrakt(item);
                                      } else {
                                        const watchedMeta = { ...item, watchedAt: new Date().toISOString() };
                                        addToWatched(watchedMeta);
                                        if (useStore.getState().traktConnected) await pushWatchedToTrakt(watchedMeta);
                                      }
                                    }}
                                  >
                                    {isWatched ? <FiEyeOff /> : <FiEye />}
                                  </button>
                                </div>
                              )}
                            </article>
                          );
                        })}
                        </div>
                      )}
                      {listItemsError && (
                        <div className="search-empty actor-credits-empty">
                          <p>{listItemsError}</p>
                          <button className="load-more-btn" onClick={() => selectedList && void handleListClick(selectedList, true)}>
                            Resume Loading Titles
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </section>
              )}
            </>
          )}
          {loadingMore && (
            <div className="search-loading"><div className="loading-spinner" /></div>
          )}
          {hasMore && lists.length > 0 && (
            <button className="load-more-btn" onClick={() => fetchData(pageRef.current, true)}>
              {listSearchError ? 'Retry Loading Lists' : 'Load More Lists'}
            </button>
          )}
        </>
      ) : actorMode ? (
        <>
          <div className="discover-results-header">
            <div>
              <p className="discover-results-kicker">Actor Search</p>
              <h2 className="discover-title">{getTitle()}</h2>
              <p className="discover-results-subtitle">{getSubtitle()}</p>
            </div>
          </div>
          {activeFilterChips.length > 0 && (
            <div className="discover-active-filters" aria-label="Active filters">
              {activeFilterChips.map((chip) => (
                <span key={chip} className="discover-chip">
                  {chip}
                </span>
              ))}
            </div>
          )}
          {people.length === 0 ? (
            <div className="search-empty">
              <h2>{trimmedSearchQuery ? 'No actors found' : 'Search for an actor'}</h2>
              <p>
                {trimmedSearchQuery
                  ? 'Try a shorter name or a different spelling.'
                  : 'Type an actor name above to browse their movies and TV shows.'}
              </p>
            </div>
          ) : (
            <>
              <div className="actor-search-grid">
                {people.map((person) => (
                  <button
                    key={person.id}
                    type="button"
                    className={`actor-search-card ${selectedActor?.id === person.id ? 'active' : ''}`}
                    onClick={() => void handleActorClick(person)}
                    aria-label={`Show credits for ${person.name}`}
                  >
                    <div className="actor-search-photo">
                      {person.profile ? (
                        <img src={person.profile} alt={person.name} loading="lazy" />
                      ) : (
                        <div className="actor-search-photo-placeholder">{person.name.charAt(0)}</div>
                      )}
                    </div>
                    <span className="actor-search-name">{person.name}</span>
                    {person.knownForDepartment && (
                      <span className="actor-search-meta">{person.knownForDepartment}</span>
                    )}
                  </button>
                ))}
              </div>

              {selectedActor && (
                <section className="actor-credits-section" ref={actorCreditsSectionRef}>
                  <div className="actor-credits-header">
                    <div>
                      <p className="discover-results-kicker">Credits</p>
                      <h2 className="discover-title">{selectedActor.name}</h2>
                      <p className="discover-results-subtitle">{actorCredits.length} movie and TV credits</p>
                    </div>
                    <div className="actor-credit-tabs" aria-label="Filter actor credits">
                      <button
                        type="button"
                        className={actorCreditFilter === 'all' ? 'active' : ''}
                        onClick={() => setActorCreditFilter('all')}
                      >
                        All
                      </button>
                      <button
                        type="button"
                        className={actorCreditFilter === 'movie' ? 'active' : ''}
                        onClick={() => setActorCreditFilter('movie')}
                      >
                        <FiFilm /> Movies {actorMovieCount}
                      </button>
                      <button
                        type="button"
                        className={actorCreditFilter === 'series' ? 'active' : ''}
                        onClick={() => setActorCreditFilter('series')}
                      >
                        <FiTv /> TV {actorSeriesCount}
                      </button>
                    </div>
                  </div>

                  {actorCreditsLoading ? (
                    <div className="search-loading actor-credits-loading">
                      <div className="loading-spinner" />
                      <p>Loading credits...</p>
                    </div>
                  ) : actorCreditsError ? (
                    <div className="search-empty actor-credits-empty">
                      <h2>No credits found</h2>
                      <p>{actorCreditsError}</p>
                    </div>
                  ) : (
                    <div className="catalog-grid">
                      {filteredActorCredits.map((credit) => (
                        <article key={credit.id} className="catalog-item">
                          <button
                            type="button"
                            className="catalog-item-trigger"
                            onClick={() => handleActorCreditClick(credit)}
                            aria-label={`Open details for ${credit.name}`}
                          >
                            <div className="catalog-item-poster">
                              {credit.poster ? (
                                <img
                                  src={credit.poster}
                                  alt={credit.name}
                                  loading="lazy"
                                  width={320}
                                  height={480}
                                />
                              ) : (
                                <div className="catalog-item-placeholder" />
                              )}
                              <XrelQualityBadge item={credit} />
                              {credit.rating !== undefined && credit.rating > 0 && (
                                <div className="poster-rating-badge">&#9733; {credit.rating.toFixed(1)}</div>
                              )}
                            </div>
                            <span className="catalog-item-title">{credit.name}</span>
                            <span className="catalog-item-year">
                              {credit.type === 'movie' ? 'Movie' : 'TV'}{credit.releaseDate ? ` - ${formatReleaseDate(credit.releaseDate)}` : ''}
                            </span>
                            {credit.character && (
                              <span className="actor-credit-character">{credit.character}</span>
                            )}
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
          {loadingMore && (
            <div className="search-loading">
              <div className="loading-spinner" />
            </div>
          )}
          {hasMore && people.length > 0 && (
            <button className="load-more-btn" onClick={() => fetchData(pageRef.current, true)}>
              Load More Actors
            </button>
          )}
        </>
      ) : items.length === 0 ? (
        <div className="search-empty">
          <h2>{mode === 'search' && !isTmdbSearchQueryReady(trimmedSearchQuery) ? 'Keep typing' : mode === 'search' ? 'No matches yet' : 'Nothing fits these filters'}</h2>
          <p>
            {mode === 'search' && !isTmdbSearchQueryReady(trimmedSearchQuery)
              ? 'Enter at least two characters to search.'
              : mode === 'search'
              ? 'Try a shorter title, remove a type filter, or jump back into browsing.'
              : 'Relax one or two filters and the catalog will open back up.'}
          </p>
        </div>
      ) : (
        <>
          <div className="discover-results-header">
            <div>
              <p className="discover-results-kicker">{mode === 'search' ? 'Search Results' : 'Browse Results'}</p>
              <h2 className="discover-title">{getTitle()}</h2>
              <p className="discover-results-subtitle">{getSubtitle()}</p>
            </div>
          </div>
          {activeFilterChips.length > 0 && (
            <div className="discover-active-filters" aria-label="Active filters">
              {activeFilterChips.map((chip) => (
                <span key={chip} className="discover-chip">
                  {chip}
                </span>
              ))}
            </div>
          )}
          <div className="catalog-grid">
            {items.map((item) => (
              (() => {
                const isInWatchlist = watchlistIds.has(item.id);
                const isWatched = watchedIds.has(item.id);
                const continueProgress = getContinueWatchingProgress(continueWatching, item.id);

                return (
                  <article key={item.id} className="catalog-item">
                    <button
                      type="button"
                      className="catalog-item-trigger"
                      onClick={() => handleItemClick(item)}
                      aria-label={`Open details for ${item.name}`}
                    >
                      <div className={`catalog-item-poster ${isWatched ? 'watched' : ''}`}>
                        {item.poster ? (
                          <img
                            src={item.poster}
                            alt={item.name}
                            loading="lazy"
                            width={320}
                            height={480}
                          />
                        ) : (
                          <div className="catalog-item-placeholder" />
                        )}
                        <XrelQualityBadge item={item} />
                        {item.rating !== undefined && item.rating > 0 && (
                          <div className="poster-rating-badge">★ {item.rating.toFixed(1)}</div>
                        )}
                        {continueProgress !== null && (
                          <div
                            className="poster-progress"
                            style={{ width: `${continueProgress}%` }}
                          />
                        )}
                      </div>
                      <span className="catalog-item-title">{item.name}</span>
                      {item.releaseDate && <span className="catalog-item-year">{formatReleaseDate(item.releaseDate)}</span>}
                    </button>
                    <div className="board-item-actions">
                      <button
                        type="button"
                        className={`board-item-action ${isInWatchlist ? 'active' : ''}`}
                        aria-label={isInWatchlist ? `Remove ${item.name} from watchlist` : `Add ${item.name} to watchlist`}
                        aria-pressed={isInWatchlist}
                        onClick={() => {
                          if (isInWatchlist) {
                            removeFromWatchlist(item.id);
                            if (traktConnected) pushWatchlistToTrakt(item, 'remove').catch(console.error);
                          } else {
                            addToWatchlist(item);
                            if (traktConnected) pushWatchlistToTrakt(item, 'add').catch(console.error);
                          }
                        }}
                      >
                        <FiHeart />
                      </button>
                      <button
                        type="button"
                        className={`board-item-action ${isWatched ? 'active' : ''}`}
                        aria-label={isWatched ? `Mark ${item.name} as unwatched` : `Mark ${item.name} as watched`}
                        aria-pressed={isWatched}
                        onClick={async () => {
                          if (isWatched) {
                            removeFromWatched(item.id);
                            if (useStore.getState().traktConnected) {
                              await pushUnwatchedToTrakt(item);
                            }
                          } else {
                            const watchedMeta = { ...item, watchedAt: new Date().toISOString() };
                            addToWatched(watchedMeta);
                            if (useStore.getState().traktConnected) {
                              await pushWatchedToTrakt(watchedMeta);
                            }
                          }
                        }}
                      >
                        {isWatched ? <FiEyeOff /> : <FiEye />}
                      </button>
                    </div>
                  </article>
                );
              })()
            ))}
          </div>
          {loadingMore && (
            <div className="search-loading">
              <div className="loading-spinner" />
            </div>
          )}
          {hasMore && items.length > 0 && (
            <button className="load-more-btn" onClick={() => fetchData(pageRef.current, true)}>
              Load More
            </button>
          )}
        </>
      )}
      {showBackToTop && !loading && (
        <button
          type="button"
          className="discover-back-to-top"
          onClick={handleBackToTop}
          aria-label="Back to top"
          style={{ top: `${backToTopTop}px` }}
        >
          <FiArrowUp />
          <span>Top</span>
        </button>
      )}
    </div>
  );
};

export default Discover;
