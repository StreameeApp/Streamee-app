import { useStore } from '../store';

export async function cleanupPlaylist(): Promise<void> {
  console.log('%c[Playlist]%c Cleaning up playlist', 'color: #ff6b35; font-weight: bold', 'color: inherit');
  const store = useStore.getState();

  store.setPlaylistActive(false);
  store.setPlaylistTorrentHash(null);
  store.setPlaylistFiles([]);
  store.setPlaylistCurrentIndex(0);
  store.setPlaylistTotalFiles(0);
  store.setPlaylistIsBuffering(false);
  store.setPlaylistEpisodeInfo(null);
  store.setCurrentPlayingTitle(null);
  store.setPlayerProgress(0);
  store.clearPlaybackIdentity();
}
