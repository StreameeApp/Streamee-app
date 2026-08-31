import React, { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo } from 'react';
import { FiArrowLeft, FiHeart, FiEye, FiEyeOff } from 'react-icons/fi';
import { useShallow } from 'zustand/react/shallow';
import { useStore, MetaPreview, type CatalogInfo } from '../../store';
import { enrichTmdbItemsById, getTmdbMovies, getTmdbTv } from '../../services/tmdb';
import { getAnticipatedMovies, getAnticipatedShows, getTrendingMovies, getTrendingShows, hasTraktCredentials } from '../../services/trakt';
import { pushUnwatchedToTrakt, pushWatchedToTrakt, pushWatchlistToTrakt } from '../../services/trakt-sync';
import {
  DISCOVERY_CONTENT_CHANGED_EVENT,
  fetchFilteredDiscoveryPage,
  getDiscoveryContentMode,
  type DiscoveryContentMode,
  type DiscoverySourcePage,
} from '../../services/discovery-content';
import XrelQualityBadge from '../../components/XrelQualityBadge';
import { fetchAddonCatalogBatch, type AddonCatalogPage } from '../../services/addon-catalogs';
import { getSupportedCatalogs, loadInstalledAddons } from '../../services/installed-addons';
import './Catalog.css';

const CATALOG_PAGE_SIZE = 20;
const ADDON_CATALOG_PAGE_SIZE = 100;
const CATALOG_VIRTUALIZE_AFTER = 100;
const CATALOG_GRID_MIN_COLUMN_WIDTH = 172;
const CATALOG_GRID_COLUMN_GAP = 18;
const CATALOG_GRID_ROW_GAP = 24;
const CATALOG_CARD_TEXT_HEIGHT = 50;
const CATALOG_OVERSCAN_ROWS = 4;
const CATALOG_INITIAL_WINDOW_ITEMS = 60;

interface CatalogVirtualWindow {
  columns: number;
  cardHeight: number;
  startIndex: number;
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  measured: boolean;
}

const DEFAULT_VIRTUAL_WINDOW: CatalogVirtualWindow = {
  columns: 1,
  cardHeight: 330,
  startIndex: 0,
  endIndex: CATALOG_INITIAL_WINDOW_ITEMS,
  topSpacerHeight: 0,
  bottomSpacerHeight: 0,
  measured: false,
};

function appendUniqueItems(current: MetaPreview[], incoming: MetaPreview[]): MetaPreview[] {
  const seenIds = new Set(current.map((item) => item.id));
  const merged = [...current];

  for (const item of incoming) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    merged.push(item);
  }

  return merged;
}

function buildCatalogCacheKey(catalog: CatalogInfo, contentMode: DiscoveryContentMode): string {
  return `${catalog.source}-${catalog.addonInstallationId || ''}-${catalog.id}-${catalog.type}-${contentMode}-v5`;
}

async function fetchAddonCatalogSelection(catalog: CatalogInfo, skip: number): Promise<AddonCatalogPage> {
  const addon = loadInstalledAddons().find((candidate) =>
    candidate.installationId === catalog.addonInstallationId && candidate.enabled
  );
  const descriptor = addon && getSupportedCatalogs(addon).find((candidate) =>
    candidate.id === catalog.id && candidate.type === catalog.type
  );
  if (!addon || !descriptor) throw new Error('The selected catalog add-on is unavailable.');
  return fetchAddonCatalogBatch(addon, descriptor, { skip });
}

interface SelectedCatalogPage {
  items: MetaPreview[];
  sourceCount: number;
}

async function fetchSelectedCatalogPage(
  catalog: CatalogInfo,
  page: number,
  contentMode: DiscoveryContentMode,
): Promise<SelectedCatalogPage> {
  if (catalog.source === 'addon') return fetchAddonCatalogSelection(catalog, page);
  if (catalog.source === 'trakt') {
    const items = await fetchTraktCatalogPage(catalog.id as 'trending' | 'anticipated', catalog.type, page, contentMode);
    return { items, sourceCount: items.length };
  }
  const items = catalog.type === 'movie'
    ? getTmdbMovies(catalog.id, page)
    : getTmdbTv(catalog.id, page);
  const resolvedItems = await items;
  return { items: resolvedItems, sourceCount: resolvedItems.length };
}

function formatEpisodeLabel(item: Pick<MetaPreview, 'continueSeason' | 'continueEpisode'>): string {
  if (typeof item.continueSeason !== 'number' || typeof item.continueEpisode !== 'number') {
    return '';
  }

  return `S${item.continueSeason.toString().padStart(2, '0')}E${item.continueEpisode.toString().padStart(2, '0')}`;
}

function formatReleaseDate(dateStr?: string): string {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

async function fetchTraktCatalogPage(
  id: 'trending' | 'anticipated',
  type: 'movie' | 'series',
  page: number,
  contentMode: DiscoveryContentMode = getDiscoveryContentMode()
): Promise<MetaPreview[]> {
  if (!hasTraktCredentials()) {
    return [];
  }

  const limit = CATALOG_PAGE_SIZE;
  const fetchSourcePage = async (sourcePage: number): Promise<DiscoverySourcePage<MetaPreview>> => {
    if (id === 'trending' && type === 'movie') {
      const items = await getTrendingMovies(sourcePage, limit);
      return {
        items: await enrichTmdbItemsById(items.map((item) => ({
          tmdbId: item.movie.ids.tmdb,
          mediaType: 'movie',
          releaseDate: item.movie.released,
          name: item.movie.title
        }))),
        hasMore: items.length === limit,
      };
    }

    if (id === 'trending' && type === 'series') {
      const items = await getTrendingShows(sourcePage, limit);
      return {
        items: await enrichTmdbItemsById(items.map((item) => ({
          tmdbId: item.show.ids.tmdb,
          mediaType: 'tv',
          releaseDate: item.show.first_aired,
          name: item.show.title
        }))),
        hasMore: items.length === limit,
      };
    }

    if (id === 'anticipated' && type === 'movie') {
      const items = await getAnticipatedMovies(sourcePage, limit);
      return {
        items: await enrichTmdbItemsById(items.map((item) => ({
          tmdbId: item.movie.ids.tmdb,
          mediaType: 'movie',
          releaseDate: item.movie.released,
          name: item.movie.title
        }))),
        hasMore: items.length === limit,
      };
    }

    const items = await getAnticipatedShows(sourcePage, limit);
    return {
      items: await enrichTmdbItemsById(items.map((item) => ({
        tmdbId: item.show.ids.tmdb,
        mediaType: 'tv',
        releaseDate: item.show.first_aired,
        name: item.show.title
      }))),
      hasMore: items.length === limit,
    };
  };

  if (contentMode === 'all') {
    return (await fetchSourcePage(page)).items;
  }

  return fetchFilteredDiscoveryPage(fetchSourcePage, page, contentMode, {
    pageSize: limit,
    maxSourcePages: 500,
  });
}

const Catalog: React.FC = () => {
  const {
    selectedCatalog,
    openCatalogMeta,
    setSelectedCatalog,
    watchlist,
    addToWatchlist,
    removeFromWatchlist,
    watched,
    addToWatched,
    removeFromWatched,
    continueWatching,
    addToContinueWatching,
    catalogScrollPosition,
    catalogItems,
    setCatalogItems,
    catalogPage,
    setCatalogPage,
    catalogCacheKey,
    setCatalogCacheKey,
    view,
    traktConnected,
  } = useStore(useShallow((state) => ({
    selectedCatalog: state.selectedCatalog,
    openCatalogMeta: state.openCatalogMeta,
    setSelectedCatalog: state.setSelectedCatalog,
    watchlist: state.watchlist,
    addToWatchlist: state.addToWatchlist,
    removeFromWatchlist: state.removeFromWatchlist,
    watched: state.watched,
    addToWatched: state.addToWatched,
    removeFromWatched: state.removeFromWatched,
    continueWatching: state.continueWatching,
    addToContinueWatching: state.addToContinueWatching,
    catalogScrollPosition: state.catalogScrollPosition,
    catalogItems: state.catalogItems,
    setCatalogItems: state.setCatalogItems,
    catalogPage: state.catalogPage,
    setCatalogPage: state.setCatalogPage,
    catalogCacheKey: state.catalogCacheKey,
    setCatalogCacheKey: state.setCatalogCacheKey,
    view: state.view,
    traktConnected: state.traktConnected,
  })));
  const [discoveryContentMode, setDiscoveryContentMode] = useState(getDiscoveryContentMode);
  const [items, setItems] = useState<MetaPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [virtualWindow, setVirtualWindow] = useState<CatalogVirtualWindow>(DEFAULT_VIRTUAL_WINDOW);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const restoredScrollKeyRef = useRef<string | null>(null);
  const pageRef = useRef(1);
  const loadingRef = useRef(false);
  const lastLoadRef = useRef(0);
  const initialLoadDone = useRef(false);
  const watchlistIds = useMemo(() => new Set(watchlist.map((item) => item.id)), [watchlist]);
  const watchedIds = useMemo(() => new Set(watched.map((item) => item.id)), [watched]);
  const continueProgressById = useMemo(() => {
    const progressById = new Map<string, number>();
    for (const item of continueWatching) {
      if (typeof item.progress === 'number' && Number.isFinite(item.progress)) {
        progressById.set(item.metaId, Math.max(0, Math.min(100, item.progress)));
      }
    }
    return progressById;
  }, [continueWatching]);
  const isVirtualized = items.length > CATALOG_VIRTUALIZE_AFTER;
  const initialRemainingRows = Math.max(0, items.length - CATALOG_INITIAL_WINDOW_ITEMS);
  const effectiveVirtualWindow = isVirtualized && !virtualWindow.measured
    ? {
        ...virtualWindow,
        endIndex: Math.min(items.length, CATALOG_INITIAL_WINDOW_ITEMS),
        bottomSpacerHeight: initialRemainingRows > 0
          ? Math.max(
              0,
              initialRemainingRows * (virtualWindow.cardHeight + CATALOG_GRID_ROW_GAP)
              - CATALOG_GRID_ROW_GAP
            )
          : 0,
      }
    : virtualWindow;
  const visibleItems = isVirtualized
    ? items.slice(effectiveVirtualWindow.startIndex, effectiveVirtualWindow.endIndex)
    : items;

  const updateVirtualWindow = useCallback(() => {
    if (items.length <= CATALOG_VIRTUALIZE_AFTER) {
      setVirtualWindow(DEFAULT_VIRTUAL_WINDOW);
      return;
    }

    const container = document.querySelector('.main-content');
    const grid = gridRef.current;
    if (!(container instanceof HTMLElement) || !grid || grid.clientWidth <= 0) return;

    const columns = Math.max(
      1,
      Math.floor(
        (grid.clientWidth + CATALOG_GRID_COLUMN_GAP)
        / (CATALOG_GRID_MIN_COLUMN_WIDTH + CATALOG_GRID_COLUMN_GAP)
      )
    );
    const cardWidth = (
      grid.clientWidth - CATALOG_GRID_COLUMN_GAP * (columns - 1)
    ) / columns;
    const cardHeight = cardWidth * 1.5 + CATALOG_CARD_TEXT_HEIGHT;
    const rowStride = cardHeight + CATALOG_GRID_ROW_GAP;
    const totalRows = Math.ceil(items.length / columns);
    const containerRect = container.getBoundingClientRect();
    const gridTop = grid.getBoundingClientRect().top - containerRect.top + container.scrollTop;
    const viewportTopWithinGrid = Math.max(0, container.scrollTop - gridTop);
    const startRow = Math.max(
      0,
      Math.floor(viewportTopWithinGrid / rowStride) - CATALOG_OVERSCAN_ROWS
    );
    const endRow = Math.min(
      totalRows,
      Math.ceil((viewportTopWithinGrid + container.clientHeight) / rowStride) + CATALOG_OVERSCAN_ROWS
    );
    const topSpacerHeight = startRow > 0
      ? Math.max(0, startRow * rowStride - CATALOG_GRID_ROW_GAP)
      : 0;
    const remainingRows = totalRows - endRow;
    const bottomSpacerHeight = remainingRows > 0
      ? Math.max(0, remainingRows * rowStride - CATALOG_GRID_ROW_GAP)
      : 0;
    const nextWindow: CatalogVirtualWindow = {
      columns,
      cardHeight,
      startIndex: startRow * columns,
      endIndex: Math.min(items.length, endRow * columns),
      topSpacerHeight,
      bottomSpacerHeight,
      measured: true,
    };

    setVirtualWindow((current) => (
      current.measured === nextWindow.measured
      && current.columns === nextWindow.columns
      && Math.abs(current.cardHeight - nextWindow.cardHeight) < 0.5
      && current.startIndex === nextWindow.startIndex
      && current.endIndex === nextWindow.endIndex
      && Math.abs(current.topSpacerHeight - nextWindow.topSpacerHeight) < 0.5
      && Math.abs(current.bottomSpacerHeight - nextWindow.bottomSpacerHeight) < 0.5
        ? current
        : nextWindow
    ));
  }, [items.length]);

  useLayoutEffect(() => {
    if (!isVirtualized) {
      setVirtualWindow(DEFAULT_VIRTUAL_WINDOW);
      return;
    }

    updateVirtualWindow();
  }, [isVirtualized, updateVirtualWindow]);

  useEffect(() => {
    if (!isVirtualized) return;

    const container = document.querySelector('.main-content');
    const grid = gridRef.current;
    if (!(container instanceof HTMLElement) || !grid) return;

    let frameId = 0;
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(updateVirtualWindow);
    };

    container.addEventListener('scroll', scheduleUpdate, { passive: true });
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(grid);
    resizeObserver.observe(container);

    return () => {
      window.cancelAnimationFrame(frameId);
      container.removeEventListener('scroll', scheduleUpdate);
      resizeObserver.disconnect();
    };
  }, [isVirtualized, updateVirtualWindow]);

  useEffect(() => {
    const handleContentModeChange = (event: Event) => {
      const mode = (event as CustomEvent<DiscoveryContentMode>).detail;
      setDiscoveryContentMode(mode || getDiscoveryContentMode());
    };
    window.addEventListener(DISCOVERY_CONTENT_CHANGED_EVENT, handleContentModeChange);
    return () => window.removeEventListener(DISCOVERY_CONTENT_CHANGED_EVENT, handleContentModeChange);
  }, []);

  const calculateInitialCount = (): number => {
    const container = document.querySelector('.main-content');
    if (!container) return CATALOG_PAGE_SIZE;
    
    const containerWidth = container.clientWidth;
    const itemWidth = 150 + 20;
    const cols = Math.floor(containerWidth / itemWidth);
    const rows = 10;
    
    return Math.max(CATALOG_PAGE_SIZE, cols * rows);
  };

  const fetchCatalog = useCallback(async (page: number, isLoadMore: boolean = false) => {
    if (!selectedCatalog || loadingRef.current) return;
    if (selectedCatalog.source === 'continue') return;
    
    const now = Date.now();
    if (isLoadMore && now - lastLoadRef.current < 800) {
      return;
    }
    lastLoadRef.current = now;
    loadingRef.current = true;
    
    if (isLoadMore) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    
    try {
      const data = await fetchSelectedCatalogPage(selectedCatalog, page, discoveryContentMode);
      
      if (data.sourceCount === 0) {
        setHasMore(false);
      } else {
        setItems(prev => {
          const newItems = isLoadMore ? appendUniqueItems(prev, data.items) : appendUniqueItems([], data.items);
          const cacheKey = buildCatalogCacheKey(selectedCatalog, discoveryContentMode);
          setCatalogItems(newItems);
          const nextPage = selectedCatalog.source === 'addon' ? page + data.sourceCount : page + 1;
          setCatalogPage(nextPage);
          setCatalogCacheKey(cacheKey);
          return newItems;
        });
        pageRef.current = selectedCatalog.source === 'addon' ? page + data.sourceCount : page + 1;
        if (page === 1 || (selectedCatalog.source === 'addon' && page === 0)) {
          initialLoadDone.current = true;
        }
      }
    } catch (error) {
      console.error('Failed to fetch catalog:', error);
    } finally {
      setLoading(false);
      setLoadingMore(false);
      loadingRef.current = false;
    }
  }, [selectedCatalog, discoveryContentMode]);

  useEffect(() => {
    if (!selectedCatalog) return;
    pageRef.current = selectedCatalog.source === 'addon' ? 0 : 1;
    initialLoadDone.current = false;
    setHasMore(true);
    
    // Use cached items if we have them for this catalog
    const cacheKey = buildCatalogCacheKey(selectedCatalog, discoveryContentMode);

    if (selectedCatalog.source === 'continue') {
      setItems(catalogItems);
      setLoading(false);
      setHasMore(false);
      pageRef.current = 1;
      initialLoadDone.current = true;
      return;
    }
    
    if (catalogItems.length > 0 && catalogCacheKey === cacheKey) {
      const restoredItems = appendUniqueItems([], catalogItems);
      setItems(restoredItems);
      if (restoredItems.length !== catalogItems.length) {
        setCatalogItems(restoredItems);
      }
      const restoredPage = selectedCatalog.source === 'addon'
        ? (catalogPage > 0 ? catalogPage : restoredItems.length)
        : catalogPage > 1
          ? catalogPage
          : Math.ceil(restoredItems.length / CATALOG_PAGE_SIZE) + 1;
      pageRef.current = restoredPage;
      if (restoredPage !== catalogPage) {
        setCatalogPage(restoredPage);
      }
      setLoading(false);
      initialLoadDone.current = true;
      return;
    }
    
    setCatalogItems([]);
    setCatalogPage(selectedCatalog.source === 'addon' ? 0 : 1);
    setCatalogCacheKey('');
    setItems([]);
    
    // Calculate how many items to load based on screen size
    const initialCount = calculateInitialCount();
    const pageSize = selectedCatalog.source === 'addon' ? ADDON_CATALOG_PAGE_SIZE : CATALOG_PAGE_SIZE;
    const pagesToLoad = Math.ceil(initialCount / pageSize);
    
    // Load multiple pages if needed
    const loadMultiple = async () => {
      setLoading(true);
      try {
        let allData: MetaPreview[] = [];
        let lastFetchedPage = 0;
        let addonSkip = 0;
        let reachedEnd = false;
        for (let i = 1; i <= pagesToLoad; i++) {
          const requestPage = selectedCatalog.source === 'addon' ? addonSkip : i;
          const data = await fetchSelectedCatalogPage(selectedCatalog, requestPage, discoveryContentMode);
          if (data.sourceCount === 0) {
            reachedEnd = true;
            break;
          }

          allData = appendUniqueItems(allData, data.items);
          addonSkip += data.sourceCount;
          lastFetchedPage = selectedCatalog.source === 'addon' ? addonSkip : i;
          if (data.sourceCount < pageSize && selectedCatalog.source !== 'addon' && discoveryContentMode !== 'exclude-anime') {
            reachedEnd = true;
            break;
          }
        }
        const nextPage = selectedCatalog.source === 'addon' ? lastFetchedPage : lastFetchedPage + 1;
        setItems(allData);
        setCatalogItems(allData);
        setCatalogPage(nextPage);
        setCatalogCacheKey(cacheKey);
        setHasMore(!reachedEnd);
        pageRef.current = nextPage;
        initialLoadDone.current = true;
      } catch (error) {
        console.error('Failed to fetch catalog:', error);
      } finally {
        setLoading(false);
      }
    };
    
    loadMultiple();
  }, [selectedCatalog, fetchCatalog]);

  useEffect(() => {
    if (!selectedCatalog || loadingMore || !hasMore) {
      return;
    }
    
    const checkScroll = () => {
      if (!initialLoadDone.current) return;
      
      const container = document.querySelector('.main-content');
      if (!container) return;
      
      const scrollTop = container.scrollTop;
      const scrollHeight = container.scrollHeight;
      const clientHeight = container.clientHeight;
      
      const isNearBottom = scrollTop + clientHeight >= scrollHeight - 600;
      
      if (isNearBottom) {
        fetchCatalog(pageRef.current, true);
      }
    };

    // Check on scroll
    const container = document.querySelector('.main-content');
    if (container) {
      container.addEventListener('scroll', checkScroll);
    }
    
    // Check on resize
    const onResize = () => {
      if (initialLoadDone.current) {
        checkScroll();
      }
    };
    window.addEventListener('resize', onResize);
    
    return () => {
      if (container) {
        container.removeEventListener('scroll', checkScroll);
      }
      window.removeEventListener('resize', onResize);
    };
  }, [selectedCatalog, fetchCatalog, loadingMore, hasMore]);

  const handleBack = () => {
    // setSelectedCatalog already switches back to Board. Keep this atomic so a
    // large catalog is not re-rendered by redundant store updates before unmount.
    setSelectedCatalog(null);
  };

  const handleItemClick = (item: MetaPreview) => {
    const container = document.querySelector('.main-content');
    const scrollPosition = container instanceof HTMLElement ? container.scrollTop : 0;

    if (
      selectedCatalog?.source === 'continue' &&
      item.continueSource === 'up-next' &&
      typeof item.continueSeason === 'number' &&
      typeof item.continueEpisode === 'number'
    ) {
      addToContinueWatching({
        metaId: item.id,
        type: item.type,
        title: item.name,
        poster: item.poster || '',
        progress: item.continueProgress ?? 0,
        rating: item.rating,
        pausedAt: item.continuePausedAt,
        episodeId: item.continueEpisodeId,
        season: item.continueSeason,
        episode: item.continueEpisode
      });
    }

    openCatalogMeta({
      id: item.id,
      type: item.type,
      name: item.name,
      poster: item.poster,
      background: item.background,
      year: item.year,
      imdbId: item.imdbId,
      rating: item.rating,
      metadataSource: item.metadataSource,
      addonInstallationId: item.addonInstallationId,
    }, scrollPosition);
  };

  // Restore only after cached items and the virtual scroll height are ready.
  useLayoutEffect(() => {
    const restoreKey = selectedCatalog
      ? `${selectedCatalog.source}:${selectedCatalog.id}:${selectedCatalog.type}:${catalogScrollPosition}`
      : null;
    if (
      view !== 'catalog'
      || !selectedCatalog
      || catalogScrollPosition <= 0
      || loading
      || items.length === 0
      || (isVirtualized && !virtualWindow.measured)
      || restoredScrollKeyRef.current === restoreKey
    ) {
      return;
    }

    const container = document.querySelector('.main-content');
    if (!(container instanceof HTMLElement)) return;

    restoredScrollKeyRef.current = restoreKey;
    container.scrollTop = catalogScrollPosition;
    if (isVirtualized) updateVirtualWindow();
  }, [
    catalogScrollPosition,
    isVirtualized,
    items.length,
    loading,
    selectedCatalog,
    updateVirtualWindow,
    view,
    virtualWindow.measured,
  ]);

  if (!selectedCatalog) return null;
  const hideWatchedToggle = !!selectedCatalog.hideWatchedToggle;
  const isContinueCatalog = selectedCatalog.source === 'continue';

  const handleLoadMore = () => {
    fetchCatalog(pageRef.current, true);
  };

  return (
    <div className="catalog">
      <header className="catalog-header">
        <button className="catalog-back" onClick={handleBack}>
          <FiArrowLeft />
        </button>
        <h1>{selectedCatalog.title}</h1>
      </header>

      {loading ? (
        <div className="catalog-loading">
          <div className="loading-spinner" />
        </div>
      ) : (
        <>
          <div
            ref={gridRef}
            className={`catalog-grid ${isVirtualized ? 'is-virtualized' : ''}`}
            style={isVirtualized
              ? { '--catalog-card-height': `${effectiveVirtualWindow.cardHeight}px` } as React.CSSProperties
              : undefined}
          >
            {isVirtualized && effectiveVirtualWindow.topSpacerHeight > 0 && (
              <div
                className="catalog-grid-spacer"
                style={{ height: effectiveVirtualWindow.topSpacerHeight }}
                aria-hidden="true"
              />
            )}
            {visibleItems.map((item) => {
              const isInWatchlist = watchlistIds.has(item.id);
              const isWatched = watchedIds.has(item.id);
              const continueProgress = continueProgressById.get(item.id) ?? null;

              return (
                <div
                  key={item.id}
                  className="catalog-item"
                  onClick={() => handleItemClick(item)}
                >
                <div className={`catalog-item-poster ${!isContinueCatalog && isWatched ? 'watched' : ''}`}>
                  {item.poster ? (
                    <img src={item.poster} alt={item.name} loading="lazy" decoding="async" />
                  ) : (
                    <div className="catalog-item-placeholder" />
                  )}
                  <XrelQualityBadge item={item} />
                  {item.rating !== undefined && item.rating > 0 && (
                    <div className="poster-rating-badge">★ {item.rating.toFixed(1)}</div>
                  )}
                  {!isContinueCatalog && continueProgress !== null && (
                    <div
                      className="poster-progress"
                      style={{ width: `${continueProgress}%` }}
                    />
                  )}
                  {isContinueCatalog && item.continueSource === 'resume' && typeof item.continueProgress === 'number' && (
                    <div
                      className="poster-progress"
                      style={{ width: `${item.continueProgress}%` }}
                    />
                  )}
                  <div className="board-item-actions">
                    <button
                      className={`board-item-action ${isInWatchlist ? 'active' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isInWatchlist) {
                          removeFromWatchlist(item.id);
                          if (traktConnected) pushWatchlistToTrakt(item, 'remove').catch(console.error);
                        } else {
                          const wlMeta = { id: item.id, type: item.type, name: item.name, poster: item.poster, background: item.background, year: item.year, imdbId: item.imdbId, rating: item.rating };
                          addToWatchlist(wlMeta);
                          if (traktConnected) pushWatchlistToTrakt(wlMeta, 'add').catch(console.error);
                        }
                      }}
                      title={isInWatchlist ? 'Remove from Watchlist' : 'Add to Watchlist'}
                    >
                      <FiHeart />
                    </button>
                    {!hideWatchedToggle && (
                      <button
                        className={`board-item-action ${isWatched ? 'active' : ''}`}
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (isWatched) {
                            removeFromWatched(item.id);
                            if (useStore.getState().traktConnected) {
                              await pushUnwatchedToTrakt(item);
                            }
                          } else {
                            const watchedMeta = { id: item.id, type: item.type, name: item.name, poster: item.poster, background: item.background, year: item.year, imdbId: item.imdbId, rating: item.rating, watchedAt: new Date().toISOString() };
                            addToWatched(watchedMeta);
                            if (useStore.getState().traktConnected) {
                              await pushWatchedToTrakt(watchedMeta);
                            }
                          }
                        }}
                        title={isWatched ? 'Mark as Unwatched' : 'Mark as Watched'}
                      >
                        {isWatched ? <FiEyeOff /> : <FiEye />}
                      </button>
                    )}
                  </div>
                </div>
                <span className="catalog-item-title">{item.name}</span>
                {isContinueCatalog && (
                  <span className="catalog-item-year">
                    {item.continueSource === 'up-next'
                      ? `Next ${formatEpisodeLabel(item)}`
                      : item.continueProgress ? `${Math.round(item.continueProgress)}% complete` : 'Resume'}
                  </span>
                )}
                {!isContinueCatalog && item.releaseDate && <span className="catalog-item-year">{formatReleaseDate(item.releaseDate)}</span>}
                </div>
              );
            })}
            {isVirtualized && effectiveVirtualWindow.bottomSpacerHeight > 0 && (
              <div
                className="catalog-grid-spacer"
                style={{ height: effectiveVirtualWindow.bottomSpacerHeight }}
                aria-hidden="true"
              />
            )}
          </div>
          {loadingMore && (
            <div className="catalog-loading-more">
              <div className="loading-spinner" />
            </div>
          )}
          {hasMore && (
            <div className="catalog-load-more">
              <button className="load-more-btn" onClick={handleLoadMore}>
                Load More
              </button>
            </div>
          )}
          {!hasMore && items.length > 0 && (
            <div className="catalog-end">No more results</div>
          )}
        </>
      )}
    </div>
  );
};

export default Catalog;
