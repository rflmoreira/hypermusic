/**
 * HyperMusic Player — Standalone Music Player
 * 
 * Dependências:
 * - js/playlists.js (dados das playlists)
 * - css/player.css (estilos do player)
 * - index.html (estrutura HTML inline)
 */

// HTML já está inline no index.html — nenhuma injeção necessária
let playerHtmlInjected = true;

async function injectPlayerHtml() {
  // No modo standalone o HTML já está presente no documento
  return true;
}

const MUSIC_PLAYER = (() => {
  const CACHE_TTL_MS = 5 * 60 * 60 * 1000; // 5 horas para buscas de vídeo
  const AUDIO_URL_TTL_MS = 10 * 60 * 1000; // 10 minutos para URLs de áudio (expiram rápido)
  const COVER_CACHE_TTL_MS = 5 * 60 * 60 * 1000; // 5 horas para capas
  const COVER_PROXY_BLOCK_MS = 45 * 1000; // cooldown curto por proxy
  const COVER_SUSPEND_MS = 5 * 60 * 1000; // suspender tentativas após muitos erros
  const COVER_FAILURE_THRESHOLD = 5;
  const AUDIO_RESET_DELAY_MS = 100; // delay após reset do áudio
  
  const localDevFlag = (() => {
    if (typeof window === 'undefined') return false;
    const hostname = window.location.hostname;
    const port = window.location.port;
    const protocol = window.location.protocol;
    return ['localhost', '127.0.0.1', '0.0.0.0'].includes(hostname) ||
      port === '5500' ||
      protocol === 'file:';
  })();

  // Netlify functions disponíveis: produção ou `netlify dev` (porta 888x)
  const backendAvailable = (() => {
    if (typeof window === 'undefined') return false;
    if (!localDevFlag) return true;
    return window.location.port.toString().startsWith('888');
  })();

  // --- ApiClient: Camada única de resolução e requisições para o Backend ---
  const ApiClient = (() => {
    let apiBaseUrl = "";
    
    return {
      configure(options) {
        if (options && typeof options.apiBaseUrl === 'string') {
          apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
        }
      },
      urls: {
        audio: (videoId) => `${apiBaseUrl}/audio?v=${videoId}`,
        youtubeSearch: (query, limit, offset, typeParam) => `${apiBaseUrl}/youtube?action=search&q=${encodeURIComponent(query)}` + (limit ? `&limit=${limit}` : '') + (offset ? `&offset=${offset}` : '') + (typeParam ? typeParam : ''),
        youtubePlaylist: (playlistId) => `${apiBaseUrl}/youtube?action=playlist&playlistId=${playlistId}`,
        deezer: (type, query) => `${apiBaseUrl}/deezer?type=${type}&q=${encodeURIComponent(query)}`,
        fourshared: (query, limit) => `${apiBaseUrl}/fourshared?action=search&q=${encodeURIComponent(query)}&limit=${limit || 10}`,
        proxy: (url) => `${apiBaseUrl}/proxy?url=${encodeURIComponent(url)}`,
        lyrics: (title, artist) => {
          const base = 'https://lrclib.net/api/search';
          if (artist) return `${base}?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`;
          return `${base}?q=${encodeURIComponent(title)}`;
        }
      }
    };
  })();

  let initPromise = null;
  let initCompleted = false;

  // Helper para delay
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // === Funções Helper Locais (independentes do index.html) ===
  
  // Formatação de tempo (ms para mm:ss ou hh:mm:ss)
  function formatDuration(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return '--:--';
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
  }

  // Escape HTML para prevenir XSS
  function escapeHTML(value) {
    if (!value && value !== 0) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value).replace(/[&<>"']/g, (c) => map[c]);
  }

  // Lock/unlock body scroll para modais
  function lockBodyScroll() {
    if (document.body.classList.contains('modal-open')) return;
    const scrollY = window.scrollY;
    document.body.style.top = `-${scrollY}px`;
    document.body.classList.add('modal-open');
  }

  function unlockBodyScroll() {
    if (!document.body.classList.contains('modal-open')) return;
    const scrollY = document.body.style.top;
    document.body.classList.remove('modal-open');
    document.body.style.top = '';
    window.scrollTo(0, parseInt(scrollY || '0') * -1);
  }

  // Helper para parar propagação de evento
  function stopEvent(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  // Múltiplos proxies para Deezer API com fallback
  const DEEZER_PROXIES = localDevFlag
    ? [
      (base) => ({ id: 'corsproxy', url: `https://corsproxy.io/?${encodeURIComponent(base)}` }),
      (base) => ({ id: 'allorigins', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(base)}` }),
      (base) => ({ id: 'codetabs', url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(base)}` })
    ]
    : [
      // Produção: exclusivamente infraestrutura própria. A function /deezer é o
      // caminho principal de capas; /proxy é o único fallback interno. Proxies
      // públicos (corsproxy/allorigins/codetabs) são permitidos APENAS em dev local.
      (base) => ({ id: 'netlify-proxy', url: ApiClient.urls.proxy(base) })
    ];

  const state = {
    playlists: [],
    tracks: [],
    currentPlaylist: null,
    currentTrackIndex: -1,
    // Estado de reprodução (separado da visualização)
    playingPlaylistId: null,
    playingTrackIndex: -1,
    playingTracks: [],
    playlistsLoaded: false,
    isLoadingTrack: false,
    isPlaying: false,
    audioRecoveryInProgress: false,
    importInProgress: false,
    currentAttemptUrl: '', // URL sendo tentada atualmente (para marcar falhas corretamente)
    searchCache: new Map(),
    searchPromises: new Map(),
    officialVideoCache: new Map(),
    officialVideoPromises: new Map(),
    audioCache: new Map(),
    audioErrorCounts: new Map(),
    coverCache: new Map(),
    coverProxyBlock: new Map(),
    coverProxyCooldown: new Map(),
    coverProxyFailCount: new Map(),
    coverFailureStreak: 0,
    coverSuspendedUntil: 0,
    coverLastSuccessProxy: null,
    playlistCoverPromise: null,
    playlistUiAppliedPromise: null,
    playlistCoversReady: false,
    playlistUiApplied: false,
    currentImportSessionId: 0,
    playRequestId: 0,
    preloadedPlaylists: new Set() // Playlists que já tiveram preload executado
  };

  // Retomada pendente após reload/crash do navegador (restaura faixa + posição).
  let pendingResume = null;

  // Expor state globalmente para debug
  window.__hyperMusicState = state;

  // Estado de paginação do YouTube (infinite scroll)
  const youtubeSearchState = {
    query: '',
    offset: 0,
    hasMore: false,
    isLoading: false,
    results: [],
    searchType: 'tracks' // 'tracks' ou 'playlists'
  };

  // Função para alternar tipo de busca
  function setSearchType(type) {
    youtubeSearchState.searchType = type;
    
    if (type === 'tracks') {
      if (ui.searchTypeTracks) {
        ui.searchTypeTracks.style.background = 'rgba(255,122,31,0.8)';
        ui.searchTypeTracks.style.color = 'white';
      }
      if (ui.searchTypePlaylists) {
        ui.searchTypePlaylists.style.background = 'transparent';
        ui.searchTypePlaylists.style.color = 'rgba(255,255,255,0.5)';
      }
      if (ui.manualSearchInput) ui.manualSearchInput.placeholder = 'O que quer ouvir?';
    } else {
      if (ui.searchTypePlaylists) {
        ui.searchTypePlaylists.style.background = 'rgba(147,51,234,0.8)';
        ui.searchTypePlaylists.style.color = 'white';
      }
      if (ui.searchTypeTracks) {
        ui.searchTypeTracks.style.background = 'transparent';
        ui.searchTypeTracks.style.color = 'rgba(255,255,255,0.5)';
      }
      if (ui.manualSearchInput) ui.manualSearchInput.placeholder = 'Buscar playlists...';
    }
  }

  // Playlist fixa "Músicas Favoritas"
  const WATCH_LATER_PLAYLIST_ID = 'watch-later-fixed';
  const WATCH_LATER_STORAGE_KEY = 'hypermusic-watch-later';

  function createWatchLaterPlaylist() {
    return {
      id: WATCH_LATER_PLAYLIST_ID,
      name: 'Músicas Favoritas',
      images: [],
      tracks: [],
      coverSources: [],
      playlistCover: null,
      isFixed: true
    };
  }

  function loadWatchLaterPlaylist() {
    try {
      const stored = localStorage.getItem(WATCH_LATER_STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        return {
          ...createWatchLaterPlaylist(),
          tracks: data.tracks || []
        };
      }
    } catch (e) {
      console.warn('Erro ao carregar playlist "Músicas Favoritas":', e);
    }
    return createWatchLaterPlaylist();
  }

  // Helper para obter a playlist de favoritos
  function getWatchLaterPlaylist() {
    return state.playlists.find(p => p.id === WATCH_LATER_PLAYLIST_ID);
  }

  function saveWatchLaterPlaylist() {
    if (!canPersist()) return;
    try {
      const watchLater = getWatchLaterPlaylist();
      if (watchLater) {
        localStorage.setItem(WATCH_LATER_STORAGE_KEY, JSON.stringify({
          tracks: watchLater.tracks
        }));
      }
    } catch (e) {
      console.warn('Erro ao salvar playlist "Músicas Favoritas":', e);
    }
  }

  function addToWatchLater(track) {
    const watchLater = getWatchLaterPlaylist();
    if (!watchLater) return false;

    // Verifica se a track já existe (por nome e artista)
    const exists = watchLater.tracks.some(t => isSameTrack(t, track));

    if (exists) {
      setFeedback('Já está nos favoritos', 'info', getTrackFeedbackInfo(track));
      return false;
    }

    watchLater.tracks.push({ ...track, addedAt: Date.now() });
    saveWatchLaterPlaylist();
    renderPlaylists();
    
    // Atualiza o ícone do botão para preenchido
    const trackIndex = state.tracks.findIndex(t => isSameTrack(t, track));
    if (trackIndex !== -1) {
      const button = ui.tracksContainer?.querySelector(`[data-add-index="${trackIndex}"]`);
      updateFavoriteButtonState(button, true);
    }
    
    // Mostra feedback com capa e nome da música
    setFeedback('Adicionado aos favoritos', 'success', getTrackFeedbackInfo(track));
    return true;
  }

  function removeFromWatchLater(trackIndex) {
    const watchLater = getWatchLaterPlaylist();
    if (!watchLater || trackIndex < 0 || trackIndex >= watchLater.tracks.length) return false;

    // Guarda informações da track antes de remover para o feedback
    const removedTrack = watchLater.tracks[trackIndex];
    const feedbackInfo = getTrackFeedbackInfo(removedTrack);

    // Verifica se a faixa sendo removida é a que está tocando
    const isPlayingThisPlaylist = state.playingPlaylistId === WATCH_LATER_PLAYLIST_ID;
    const isPlayingThisTrack = isPlayingThisPlaylist && state.playingTrackIndex === trackIndex;
    const isPlayingAfterThis = isPlayingThisPlaylist && state.playingTrackIndex > trackIndex;

    watchLater.tracks.splice(trackIndex, 1);
    saveWatchLaterPlaylist();

    // Função auxiliar para mostrar feedback
    const showRemovedFeedback = () => {
      setFeedback('Removido dos favoritos', 'success', feedbackInfo);
    };

    // Se estamos visualizando a playlist "Músicas Favoritas", atualiza a view
    if (state.currentPlaylist?.id === WATCH_LATER_PLAYLIST_ID) {
      state.tracks = [...watchLater.tracks];

      // Ajusta o índice atual se necessário
      if (state.currentTrackIndex === trackIndex) {
        state.currentTrackIndex = -1;
      } else if (state.currentTrackIndex > trackIndex) {
        state.currentTrackIndex--;
      }

      renderTracks(state.tracks);
    }

    // Se a faixa removida estava tocando, para a reprodução
    if (isPlayingThisTrack) {
      // Para o áudio imediatamente
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch (_) { }

      safeResetAudio();
      stopPlaying();

      // Se a playlist ficou vazia, limpa completamente o estado de reprodução
      if (watchLater.tracks.length === 0) {
        state.playingTrackIndex = -1;
        state.playingPlaylistId = null;
        state.playingTracks = [];
        state.currentTrackIndex = -1;
        stopPlaybackCountdown({ resetLabel: true });
        updateUiState();
        renderPlaylists();
        showRemovedFeedback();
        return true;
      } else {
        // Toca a próxima faixa
        state.playingTracks = [...watchLater.tracks];
        const nextIndex = Math.min(trackIndex, watchLater.tracks.length - 1);
        state.playingTrackIndex = nextIndex;
        state.currentTrackIndex = nextIndex;
        updateUiState();
        playTrack(nextIndex);
        renderPlaylists();
        showRemovedFeedback();
        return true;
      }
    } else if (isPlayingAfterThis) {
      // Ajusta o índice de reprodução se a faixa removida estava antes
      state.playingTrackIndex--;
      state.playingTracks = [...watchLater.tracks];
      updateUiState();
    }

    renderPlaylists();
    showRemovedFeedback();
    return true;
  }

  function removeFromWatchLaterByTrack(track) {
    const watchLater = getWatchLaterPlaylist();
    if (!watchLater || !track) return false;

    // Encontra o índice da track nos favoritos
    const trackIndex = watchLater.tracks.findIndex(t => isSameTrack(t, track));

    if (trackIndex === -1) return false;

    // Guarda informações da track para o feedback
    const removedTrack = watchLater.tracks[trackIndex];

    // Remove a track
    watchLater.tracks.splice(trackIndex, 1);
    saveWatchLaterPlaylist();
    renderPlaylists();

    // Feedback
    setFeedback('Removido dos favoritos', 'success', getTrackFeedbackInfo(removedTrack));

    return true;
  }

  function ensureWatchLaterPlaylist() {
    const exists = state.playlists.some(p => p.id === WATCH_LATER_PLAYLIST_ID);
    if (!exists) {
      const watchLater = loadWatchLaterPlaylist();
      state.playlists.unshift(watchLater);
    }
  }

  // Persistência geral de playlists
  const PLAYLISTS_STORAGE_KEY = 'hypermusic-playlists';
  const AUDIO_CACHE_STORAGE_KEY = 'hypermusic-audio-cache';
  const CURRENT_STATE_STORAGE_KEY = 'hypermusic-current-state';
  // Sentinel plantado no init: se sumir com a aba aberta, o storage foi limpo
  // externamente (Clear Site Data / Cookies) e o estado em memória NÃO deve
  // ser regravado — caso clássico de beforeunload/interval ressuscitando dados.
  const STORAGE_SENTINEL_KEY = 'hypermusic-storage-sentinel';

  // Flag para impedir salvamento após limpeza manual ou Clear Site Data
  let preventSaveOnUnload = false;
  let storageSentinelPlanted = false;
  // Preenchido após o setup do IndexedDB (fecha conexão + deleteDatabase + UI).
  let discardPlayerRuntimeAfterStorageClear = null;

  function plantStorageSentinel() {
    try {
      localStorage.setItem(STORAGE_SENTINEL_KEY, '1');
      storageSentinelPlanted = true;
    } catch (_) {
      storageSentinelPlanted = false;
    }
  }

  function wasStorageExternallyCleared() {
    if (!storageSentinelPlanted || preventSaveOnUnload) return false;
    try {
      return localStorage.getItem(STORAGE_SENTINEL_KEY) === null;
    } catch (_) {
      return true;
    }
  }

  function handleExternalStorageClear() {
    if (preventSaveOnUnload) return;
    preventSaveOnUnload = true;
    storageSentinelPlanted = false;
    console.warn('🧹 [PLAYER] Storage limpo externamente — descartando estado em memória e bloqueando regravação');
    try {
      discardPlayerRuntimeAfterStorageClear?.();
    } catch (e) {
      console.warn('Erro ao descartar estado do player após limpeza de storage:', e);
    }
  }

  function canPersist() {
    if (preventSaveOnUnload) return false;
    if (wasStorageExternallyCleared()) {
      handleExternalStorageClear();
      return false;
    }
    return true;
  }

  function checkStorageIntegrity() {
    if (wasStorageExternallyCleared()) handleExternalStorageClear();
  }

  // Função para limpar todos os dados do player (exposta globalmente para debug)
  window.clearAllPlayerData = function () {
    try {
      preventSaveOnUnload = true;
      storageSentinelPlanted = false;

      localStorage.removeItem(PLAYLISTS_STORAGE_KEY);
      localStorage.removeItem(AUDIO_CACHE_STORAGE_KEY);
      localStorage.removeItem(CURRENT_STATE_STORAGE_KEY);
      localStorage.removeItem(WATCH_LATER_STORAGE_KEY);
      localStorage.removeItem('hypermusic_lyric_offsets');
      localStorage.removeItem(STORAGE_SENTINEL_KEY);

      if (typeof discardPlayerRuntimeAfterStorageClear === 'function') {
        discardPlayerRuntimeAfterStorageClear();
      } else {
        state.playlists = [];
        state.tracks = [];
        state.currentPlaylist = null;
        state.currentTrackIndex = -1;
        resetPlaybackState({ resetTrackIndex: true, clearTracks: true, clearCaches: true });
        state.audioCache.clear();
        state.playlistsLoaded = false;
      }
      return true;
    } catch (e) {
      console.error('Erro ao limpar dados:', e);
      return false;
    }
  };

  function savePlaylistsToStorage() {
    if (!canPersist()) return;
    try {
      // Filtra a playlist "Músicas Favoritas" (já tem seu próprio storage)
      const playlistsToSave = state.playlists
        .filter(p => p.id !== WATCH_LATER_PLAYLIST_ID)
        .map(p => ({
          id: p.id,
          name: p.name,
          images: p.images,
          cover: p.cover,
          background: p.background || null,
          playlistCover: p.playlistCover,
          tracks: p.tracks.map(t => ({
            name: t.name,
            artists: t.artists,
            album: t.album,
            duration_ms: t.duration_ms,
            durationMs: t.durationMs,
            thumbnail: t.thumbnail,
            playlistName: t.playlistName,
            videoId: t.videoId,
            audioUrl: t.audioUrl
          }))
        }));

      localStorage.setItem(PLAYLISTS_STORAGE_KEY, JSON.stringify(playlistsToSave));
    } catch (e) {
      console.warn('Erro ao salvar playlists:', e);
    }
  }

  function deletePlaylist(playlistId) {
    if (!playlistId) return;
    
    const playlistIndex = state.playlists.findIndex(p => p.id === playlistId);
    if (playlistIndex === -1) return;
    
    const playlist = state.playlists[playlistIndex];
    
    // Tratamento especial para "Músicas Favoritas" - limpa as faixas ao invés de remover
    if (playlistId === WATCH_LATER_PLAYLIST_ID) {
      // Para a reprodução se estiver tocando
      if (state.currentPlaylist && state.currentPlaylist.id === playlistId) {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch (_) {}
        state.isPlaying = false;
        state.currentPlaylist = null;
        state.tracks = [];
        state.currentTrackIndex = -1;
        updateUiState();
        renderTracks([]);
      }
      
      // Limpa as faixas da playlist
      playlist.tracks = [];
      saveWatchLaterPlaylist();
      renderPlaylists();
      setFeedback('Playlist limpa', 'success', {
        name: 'Músicas Favoritas',
        cover: 'assets/images/favoriteSongs.png'
      });
      return;
    }
    
    // Se a playlist sendo deletada é a atual, para a reprodução e limpa as faixas
    if (state.currentPlaylist && state.currentPlaylist.id === playlistId) {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch (_) {}
      state.isPlaying = false;
      state.currentPlaylist = null;
      state.tracks = [];
      state.currentTrackIndex = -1;
      updateUiState();
      renderTracks([]);
    }
    
    // Remove a playlist
    state.playlists.splice(playlistIndex, 1);
    
    // Salva e atualiza a UI
    savePlaylistsToStorage();
    renderPlaylists();
    
    const playlistCover = getPlaylistCover(playlist);
    setFeedback('Playlist removida', 'success', {
      name: playlist.name,
      cover: playlistCover,
      subtitle: `${playlist.tracks?.length || 0} faixas`
    });
  }

  function loadPlaylistsFromStorage() {
    try {
      const stored = localStorage.getItem(PLAYLISTS_STORAGE_KEY);
      if (stored) {
        const playlists = JSON.parse(stored);
        return playlists;
      }
    } catch (e) {
      console.warn('Erro ao carregar playlists:', e);
    }
    return [];
  }

  function saveCurrentStateToStorage() {
    if (!canPersist()) return;
    try {
      // Posição da faixa: no modo Vídeo o MP3 fica pausado, então usamos o tempo
      // do clipe como melhor aproximação; caso contrário, o tempo do <audio>.
      let posSec = 0;
      try {
        posSec = (videoMode && videoMode.isVideo()) ? (videoMode.getCurrentTime() || 0) : (audio.currentTime || 0);
      } catch (_) { posSec = audio.currentTime || 0; }

      const currentState = {
        currentPlaylistId: state.currentPlaylist?.id || null,
        currentTrackIndex: state.currentTrackIndex,
        // Fila/posição REAL de reprodução, para retomar após reload/crash do navegador.
        playingPlaylistId: state.playingPlaylistId || null,
        playingTrackIndex: state.playingTrackIndex,
        positionMs: Math.max(0, Math.floor(posSec * 1000)),
        wasPlaying: !!state.isPlaying
      };
      localStorage.setItem(CURRENT_STATE_STORAGE_KEY, JSON.stringify(currentState));
    } catch (e) {
      console.warn('Erro ao salvar estado atual:', e);
    }
  }

  function loadCurrentStateFromStorage() {
    try {
      const stored = localStorage.getItem(CURRENT_STATE_STORAGE_KEY);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {
      console.warn('Erro ao carregar estado atual:', e);
    }
    return null;
  }

  // Restaura a fila e a posição de reprodução após um reload/crash do navegador.
  // NÃO auto-reproduz (políticas de autoplay exigem gesto do usuário); apenas
  // deixa a faixa selecionada e a posição pronta para retomar em 1 toque.
  function restorePlaybackState(saved) {
    if (!saved) return;
    const { playingPlaylistId, playingTrackIndex, positionMs } = saved;
    if (!playingPlaylistId || playingPlaylistId === 'youtube-search') return;
    if (!Number.isInteger(playingTrackIndex) || playingTrackIndex < 0) return;

    const playlist = state.playlists.find(p => p.id === playingPlaylistId);
    if (!playlist || !Array.isArray(playlist.tracks) || playingTrackIndex >= playlist.tracks.length) return;

    // Restaura a fila de reprodução (sem iniciar o áudio).
    state.playingPlaylistId = playingPlaylistId;
    state.playingTracks = [...playlist.tracks];
    state.playingTrackIndex = playingTrackIndex;

    // Se a visualização é a mesma playlist, alinha o índice destacado.
    if (state.currentPlaylist?.id === playingPlaylistId) {
      state.currentTrackIndex = playingTrackIndex;
    }

    // Guarda a posição para saltar assim que a faixa começar a tocar.
    pendingResume = {
      playlistId: playingPlaylistId,
      index: playingTrackIndex,
      positionSec: Math.max(0, (positionMs || 0) / 1000)
    };

    updateUiState();
  }

  // Cache de áudio reproduzido (videoId -> audioUrl)
  function saveAudioCacheToStorage() {
    if (!canPersist()) return;
    try {
      const cacheToSave = {};
      state.audioCache.forEach((entry, key) => {
        if (entry.value && entry.timestamp) {
          cacheToSave[key] = {
            value: entry.value,
            timestamp: entry.timestamp
          };
        }
      });
      localStorage.setItem(AUDIO_CACHE_STORAGE_KEY, JSON.stringify(cacheToSave));
    } catch (e) {
      console.warn('Erro ao salvar cache de áudio:', e);
    }
  }

  function loadAudioCacheFromStorage() {
    try {
      const stored = localStorage.getItem(AUDIO_CACHE_STORAGE_KEY);
      if (stored) {
        const cache = JSON.parse(stored);
        Object.entries(cache).forEach(([key, entry]) => {
          // Só carrega se ainda estiver válido (dentro do TTL)
          if (isCacheValid(entry.timestamp)) {
            state.audioCache.set(key, entry);
          }
        });
      }
    } catch (e) {
      console.warn('Erro ao carregar cache de áudio:', e);
    }
  }

  // Salva automaticamente ao modificar playlists
  function saveAllData() {
    if (!canPersist()) return;

    savePlaylistsToStorage();
    saveWatchLaterPlaylist();
    saveCurrentStateToStorage();
    saveAudioCacheToStorage();
  }

  // Debounce para não salvar muito frequentemente
  let saveDebounceTimer = null;
  function debouncedSave() {
    if (preventSaveOnUnload) return;
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(saveAllData, 1000);
  }

  // Funções auxiliares de cache com TTL
  function isCacheValid(timestamp, ttl = CACHE_TTL_MS) {
    return timestamp && (Date.now() - timestamp) < ttl;
  }

  function getCacheEntry(cache, key, ttl = CACHE_TTL_MS) {
    if (!cache.has(key)) return null;
    const entry = cache.get(key);
    if (!isCacheValid(entry.timestamp, ttl)) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  function setCacheEntry(cache, key, value) {
    cache.set(key, { value, timestamp: Date.now() });
  }

  // ============================================================
  // Infraestrutura de produção: métricas, backoff, circuit breaker
  // e cache persistente (IndexedDB). Ver docs/player-architecture.md
  // ============================================================

  const APP_STARTED_AT = Date.now();

  // --- Métricas internas em tempo real ---
  const metrics = {
    resolve: { api: 0, cache: 0, persistentCache: 0, fallback: 0, failures: 0, permanentFailures: 0, retries: 0, totalTimeMs: 0, count: 0, deduped: 0 },
    preload: { batches: 0, totalTimeMs: 0, tracksResolved: 0, tracksFailed: 0 },
    playback: { plays: 0, ttfpTotalMs: 0, ttfpLastMs: null, ttfpBestMs: null, ttfpWorstMs: null, optimisticPlays: 0, recoveries: 0 },
    anticipate: { warmups: 0, hits: 0 },
    firstPlayMs: null,
    fourshared: { accepted: 0, rejected: 0 },
    audioCache: { hits: 0, misses: 0 },
    coverCache: { hits: 0, misses: 0 },
    circuit: { opens: 0, closes: 0, halfOpens: 0, shortCircuited: 0 }
  };

  function getMetricsSnapshot() {
    const r = metrics.resolve;
    const resolved = r.api + r.cache + r.persistentCache + r.fallback;
    const total = resolved + r.failures;
    const pct = (n, d) => d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a';
    const audioTotal = metrics.audioCache.hits + metrics.audioCache.misses;
    const coverTotal = metrics.coverCache.hits + metrics.coverCache.misses;
    const fsTotal = metrics.fourshared.accepted + metrics.fourshared.rejected;
    return {
      resolucoes: {
        total,
        viaApi: pct(r.api, total),
        viaCache: pct(r.cache + r.persistentCache, total),
        viaFallback: pct(r.fallback, total),
        falhas: r.failures,
        falhasPermanentes: r.permanentFailures,
        retriesExecutados: r.retries,
        resolucoesDeduplicadas: r.deduped,
        tempoMedioMs: r.count > 0 ? Math.round(r.totalTimeMs / r.count) : 0
      },
      preload: {
        lotes: metrics.preload.batches,
        tempoMedioLoteMs: metrics.preload.batches > 0 ? Math.round(metrics.preload.totalTimeMs / metrics.preload.batches) : 0,
        faixasResolvidas: metrics.preload.tracksResolved,
        faixasFalhas: metrics.preload.tracksFailed
      },
      tempoAtePrimeiraMusicaMs: metrics.firstPlayMs,
      reproducao: {
        plays: metrics.playback.plays,
        ttfpMedioMs: metrics.playback.plays > 0 ? Math.round(metrics.playback.ttfpTotalMs / metrics.playback.plays) : null,
        ttfpUltimoMs: metrics.playback.ttfpLastMs,
        ttfpMelhorMs: metrics.playback.ttfpBestMs,
        ttfpPiorMs: metrics.playback.ttfpWorstMs,
        playsOtimistas: metrics.playback.optimisticPlays,
        recuperacoes: metrics.playback.recoveries
      },
      antecipacao: {
        aquecimentos: metrics.anticipate.warmups,
        acertosNoPlay: metrics.anticipate.hits
      },
      fourshared: {
        aceitos: metrics.fourshared.accepted,
        rejeitados: metrics.fourshared.rejected,
        taxaAcerto: pct(metrics.fourshared.accepted, fsTotal)
      },
      cacheHitRatio: {
        audio: pct(metrics.audioCache.hits, audioTotal),
        capas: pct(metrics.coverCache.hits, coverTotal)
      },
      circuitBreaker: { ...metrics.circuit, estadoAtual: audioCircuit.state }
    };
  }

  // --- Instrumentação TTFP (clique → áudio tocando) ---
  // Mede cada fase da preparação da faixa atual (resolução, carregamento, play)
  // e alimenta metrics.playback. O requestId protege contra logs de tentativas
  // abandonadas (usuário trocou de faixa no meio da preparação).
  let playTiming = null;

  function beginPlayTiming(label) {
    playTiming = { label, requestId: state.playRequestId, start: performance.now(), last: performance.now(), marks: [] };
  }

  function markPlayPhase(phase) {
    if (!playTiming) return;
    const now = performance.now();
    playTiming.marks.push(`${phase}=${Math.round(now - playTiming.last)}ms`);
    playTiming.last = now;
  }

  function finishPlayTiming() {
    if (!playTiming) return;
    if (playTiming.requestId !== state.playRequestId) {
      playTiming = null;
      return;
    }
    markPlayPhase('play');
    const totalMs = Math.round(performance.now() - playTiming.start);
    const p = metrics.playback;
    p.plays += 1;
    p.ttfpTotalMs += totalMs;
    p.ttfpLastMs = totalMs;
    p.ttfpBestMs = p.ttfpBestMs === null ? totalMs : Math.min(p.ttfpBestMs, totalMs);
    p.ttfpWorstMs = p.ttfpWorstMs === null ? totalMs : Math.max(p.ttfpWorstMs, totalMs);
    console.log(`⏱️ [TTFP] "${playTiming.label}" tocando em ${totalMs}ms · ${playTiming.marks.join(' · ')}`);
    playTiming = null;
  }

  // --- Retry exponencial com jitter ---
  // 1s -> 2s -> 4s -> 8s (com jitter de 50–100% para evitar rajadas simultâneas)
  function backoffDelay(attempt, baseMs = 1000, maxMs = 8000) {
    const exp = Math.min(maxMs, baseMs * Math.pow(2, attempt));
    return Math.round(exp * (0.5 + Math.random() * 0.5));
  }

  // Motivos de erro do /audio que NUNCA devem gerar retry (falha permanente do vídeo)
  const PERMANENT_AUDIO_REASONS = new Set([
    'video-not-found', 'video-private', 'private', 'deleted',
    'geo-blocked', 'video-blocked', 'extraction-failed', 'video-too-long'
  ]);
  // Motivos transitórios que justificam retry
  const RETRYABLE_AUDIO_REASONS = new Set(['processing', 'timeout', 'rate-limited', 'upstream-error']);

  // Falhas permanentes por videoId (sessão): nunca repetir chamadas para esses vídeos
  const permanentAudioFailures = new Map(); // videoId -> reason

  // --- Circuit Breaker da API /audio ---
  // Abre após muitas falhas de INFRAESTRUTURA consecutivas (5xx/timeout/rede),
  // não conta erros específicos de vídeo (not-found etc.). Enquanto aberto,
  // getAudioUrl falha imediatamente e o resolveTrackAudio degrada para 4shared/cache.
  const audioCircuit = {
    state: 'closed', // closed | open | half-open
    consecutiveFailures: 0,
    openedAt: 0,
    openMs: 30000,          // tempo base com o circuito aberto
    maxOpenMs: 4 * 60 * 1000,
    failureThreshold: 5,    // falhas de infra consecutivas para abrir
    transition(next) {
      if (this.state === next) return;
      console.warn(`🔌 [CIRCUIT] /audio: ${this.state} -> ${next}`);
      if (next === 'open') { metrics.circuit.opens += 1; this.openedAt = Date.now(); }
      if (next === 'half-open') metrics.circuit.halfOpens += 1;
      if (next === 'closed') { metrics.circuit.closes += 1; this.openMs = 30000; }
      this.state = next;
    },
    canRequest() {
      if (this.state === 'closed') return true;
      if (this.state === 'open') {
        if (Date.now() - this.openedAt >= this.openMs) {
          // Período de espera terminou: permite UMA sonda (half-open)
          this.transition('half-open');
          return true;
        }
        metrics.circuit.shortCircuited += 1;
        return false;
      }
      // half-open: apenas a sonda em andamento; demais aguardam
      metrics.circuit.shortCircuited += 1;
      return false;
    },
    recordSuccess() {
      this.consecutiveFailures = 0;
      if (this.state !== 'closed') this.transition('closed');
    },
    recordInfraFailure() {
      this.consecutiveFailures += 1;
      if (this.state === 'half-open') {
        // Sonda falhou: reabre com backoff no tempo de espera
        this.openMs = Math.min(this.maxOpenMs, this.openMs * 2);
        this.transition('open');
      } else if (this.state === 'closed' && this.consecutiveFailures >= this.failureThreshold) {
        this.transition('open');
      }
    }
  };

  // --- Cache persistente (IndexedDB) ---
  // Stores: 'audio' (resoluções por trackKey) e 'covers' (capas por cacheKey).
  // Todas as operações são fire-and-forget e degradam graciosamente sem IDB.
  const IDB_NAME = 'hypermusic-player';
  const IDB_VERSION = 1;
  const IDB_AUDIO_STORE = 'audio';
  const IDB_COVER_STORE = 'covers';
  const IDB_VIDEO_ID_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // videoId/fileId valem 7 dias
  const IDB_COVER_TTL_MS = 7 * 24 * 60 * 60 * 1000;     // capas valem 7 dias
  const IDB_MAX_AUDIO_ENTRIES = 800;
  const IDB_MAX_COVER_ENTRIES = 1500;

  let idbPromise = null;
  let idbConnection = null;

  function openPlayerDb() {
    if (preventSaveOnUnload) return Promise.resolve(null);
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve) => {
      try {
        if (preventSaveOnUnload || typeof indexedDB === 'undefined') return resolve(null);
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_AUDIO_STORE)) {
            db.createObjectStore(IDB_AUDIO_STORE, { keyPath: 'key' });
          }
          if (!db.objectStoreNames.contains(IDB_COVER_STORE)) {
            db.createObjectStore(IDB_COVER_STORE, { keyPath: 'key' });
          }
        };
        req.onsuccess = () => {
          if (preventSaveOnUnload) {
            try { req.result.close(); } catch (_) { }
            return resolve(null);
          }
          idbConnection = req.result;
          idbConnection.onclose = () => {
            if (idbConnection === req.result) idbConnection = null;
          };
          resolve(idbConnection);
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
    return idbPromise;
  }

  async function closeAndDeletePlayerDb() {
    try {
      if (idbConnection) {
        try { idbConnection.close(); } catch (_) { }
        idbConnection = null;
      }
      idbPromise = null;
      if (typeof indexedDB === 'undefined') return;
      await new Promise((resolve) => {
        try {
          const req = indexedDB.deleteDatabase(IDB_NAME);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        } catch (_) {
          resolve();
        }
      });
    } catch (_) { }
  }

  async function idbPut(storeName, entry) {
    if (!canPersist()) return;
    try {
      const db = await openPlayerDb();
      if (!db || preventSaveOnUnload) return;
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(entry);
    } catch (_) { }
  }

  async function idbDelete(storeName, key) {
    try {
      const db = await openPlayerDb();
      if (!db) return;
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
    } catch (_) { }
  }

  async function idbGetAll(storeName) {
    try {
      const db = await openPlayerDb();
      if (!db) return [];
      return await new Promise((resolve) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    } catch (_) {
      return [];
    }
  }

  // Remove entradas expiradas e limita o tamanho do store (mais antigas primeiro)
  async function idbPrune(storeName, maxEntries) {
    try {
      const all = await idbGetAll(storeName);
      const now = Date.now();
      const expired = all.filter(e => e.expiresAt && now >= e.expiresAt);
      for (const e of expired) idbDelete(storeName, e.key);
      const alive = all.filter(e => !e.expiresAt || now < e.expiresAt);
      if (alive.length > maxEntries) {
        alive.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
        for (const e of alive.slice(0, alive.length - maxEntries)) idbDelete(storeName, e.key);
      }
    } catch (_) { }
  }

  // Hints persistidos de resoluções (trackKey -> entrada do IDB), consultados
  // por resolveTrackAudio após miss no cache em memória. Sobrevive a
  // searchCache.clear() nas trocas de playlist.
  const persistentResolveHints = new Map();

  // Descarta estado em memória + IDB quando o storage some com a aba aberta
  // (Clear Site Data) ou via clearAllPlayerData(). Não regrava nada.
  discardPlayerRuntimeAfterStorageClear = function discardPlayerRuntimeAfterStorageClear() {
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch (_) { }

    state.playlists = [];
    state.tracks = [];
    state.currentPlaylist = null;
    state.currentTrackIndex = -1;
    state.playlistsLoaded = false;
    state.audioCache.clear();
    state.searchCache.clear();
    state.searchPromises.clear();
    state.coverCache.clear();
    persistentResolveHints.clear();

    closeAndDeletePlayerDb();

    ensureWatchLaterPlaylist();
    try { renderPlaylists(); } catch (_) { }
    try { renderTracks([]); } catch (_) { }
    resetPlaybackState({ resetTrackIndex: true, clearTracks: true, clearCaches: true });
    try { updateUiState(); } catch (_) { }
  };

  // Grava/atualiza a resolução de uma faixa no cache persistente
  function persistResolvedAudio(trackKey, result, track) {
    if (!trackKey || !result?.audioUrl) return;
    const now = Date.now();
    const entry = {
      key: trackKey,
      videoId: result.videoId || null,
      audioUrl: result.audioUrl,
      source: result.instance || 'youtube',
      lengthSeconds: result.lengthSeconds || 0,
      thumbnail: sanitizeImageUrl(track?.thumbnail) || null,
      foursharedFileId: track?._foursharedFileId || null,
      audioExpiresAt: now + AUDIO_URL_TTL_MS,
      expiresAt: now + IDB_VIDEO_ID_TTL_MS,
      savedAt: now
    };
    persistentResolveHints.set(trackKey, entry);
    idbPut(IDB_AUDIO_STORE, entry);
  }

  // Hidrata os hints do IDB para a memória (chamado no init, em background)
  async function hydratePersistentCaches() {
    const startedAt = Date.now();
    try {
      const [audioEntries, coverEntries] = await Promise.all([
        idbGetAll(IDB_AUDIO_STORE),
        idbGetAll(IDB_COVER_STORE)
      ]);
      const now = Date.now();

      let audioLoaded = 0;
      for (const entry of audioEntries) {
        if (!entry?.key || (entry.expiresAt && now >= entry.expiresAt)) continue;
        persistentResolveHints.set(entry.key, entry);
        audioLoaded += 1;
      }

      let coversLoaded = 0;
      for (const entry of coverEntries) {
        if (!entry?.key || !entry.url || (entry.expiresAt && now >= entry.expiresAt)) continue;
        // Alimenta o cache em memória sem sobrescrever entradas mais recentes
        if (!state.coverCache.has(entry.key)) {
          state.coverCache.set(entry.key, { value: entry.url, timestamp: entry.savedAt || now });
          coversLoaded += 1;
        }
      }

      if (audioLoaded || coversLoaded) {
        console.log(`💾 [IDB] Cache persistente hidratado: ${audioLoaded} resoluções, ${coversLoaded} capas (${Date.now() - startedAt}ms)`);
      }

      // Validação de expiração/limpeza em background (não bloqueia nada)
      idbPrune(IDB_AUDIO_STORE, IDB_MAX_AUDIO_ENTRIES);
      idbPrune(IDB_COVER_STORE, IDB_MAX_COVER_ENTRIES);
    } catch (_) { }
  }

  // Extrai id e resolução de uma URL de capa do Deezer (para metadata do cache)
  function parseDeezerCoverMeta(url = '') {
    const idMatch = String(url).match(/\/cover\/([a-f0-9]{16,64})\//i);
    const resMatch = String(url).match(/(\d{2,4})x(\d{2,4})/);
    return {
      deezerId: idMatch ? idMatch[1] : null,
      resolution: resMatch ? `${resMatch[1]}x${resMatch[2]}` : null
    };
  }

  // Wrappers para cover cache com TTL específico (memória + persistência IDB)
  const getCoverCache = (key) => {
    const value = getCacheEntry(state.coverCache, key, COVER_CACHE_TTL_MS);
    if (value) metrics.coverCache.hits += 1;
    else metrics.coverCache.misses += 1;
    return value;
  };
  const setCoverCache = (key, value) => {
    setCacheEntry(state.coverCache, key, value);
    // Persiste apenas capas reais (URLs http), nunca fallbacks/SVGs gerados
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      const meta = parseDeezerCoverMeta(value);
      idbPut(IDB_COVER_STORE, {
        key,
        url: value,
        deezerId: meta.deezerId,
        resolution: meta.resolution,
        savedAt: Date.now(),
        expiresAt: Date.now() + IDB_COVER_TTL_MS
      });
    }
  };

  // Funções de controle de proxy
  function isProxyExpired(cache, proxyId) {
    const expires = cache.get(proxyId);
    if (!expires) return true;
    if (Date.now() > expires) {
      cache.delete(proxyId);
      return true;
    }
    return false;
  }

  const isCoverProxyBlocked = (proxyId) => !isProxyExpired(state.coverProxyBlock, proxyId);
  const isCoverProxyCooling = (proxyId) => !isProxyExpired(state.coverProxyCooldown, proxyId);

  function setCoverProxyCooldown(proxyId, duration = 2000) {
    if (proxyId) state.coverProxyCooldown.set(proxyId, Date.now() + duration);
  }

  function resetCoverProxyFail(proxyId) {
    if (proxyId) state.coverProxyFailCount.delete(proxyId);
  }

  function blockCoverProxy(proxyId, reason = 'unknown', duration = COVER_PROXY_BLOCK_MS) {
    if (!proxyId) return;
    const reasonText = String(reason).toLowerCase();
    // Isomorphic 403/failed fetch são comuns; evita bloquear
    if (proxyId === 'isomorphic' && (reasonText.includes('403') || reasonText.includes('failed'))) return;
    // Allorigins aborta com frequência; não bloquear por abort
    if (proxyId === 'allorigins' && reasonText.includes('abort')) return;
    // Jina só bloqueia em 429 explícito
    if (proxyId === 'jina' && !reasonText.includes('429')) return;
    state.coverProxyBlock.set(proxyId, Date.now() + duration);
    console.warn(`⏳ [COVER] Proxy bloqueado (${proxyId}) por ${Math.round(duration / 1000)}s (${reason})`);
  }

  function resetCoverProxies(reason = 'manual-reset') {
    state.coverProxyBlock.clear();
    state.coverProxyFailCount.clear();
    state.coverSuspendedUntil = 0;
    console.warn(`♻️ [COVER] Reset proxies (${reason})`);
  }

  const AUDIO_ERROR_RESET_MS = 15000;
  const MEDIA_ERROR_ABORTED_CODE = (typeof MediaError !== 'undefined' && MediaError.MEDIA_ERR_ABORTED) ? MediaError.MEDIA_ERR_ABORTED : 1;

  // Limpa caches associados a uma faixa específica (resultado de busca e áudio)
  function clearTrackCaches(trackKey, cachedResult = null, { preserveFailures = false } = {}) {
    if (!trackKey) return;

    const result = cachedResult || getCacheEntry(state.searchCache, trackKey);
    if (result?.videoId) {
      state.audioCache.delete(result.videoId);
    }

    state.searchCache.delete(trackKey);
    state.searchPromises.delete(trackKey);
  }

  // Helper para limpar videoId de uma track e retornar o original
  function clearTrackVideoId(track) {
    const originalVideoId = track._videoId || track.videoId;
    delete track._videoId;
    delete track.videoId;
    return originalVideoId;
  }

  // Helper para obter o videoId de uma track
  function getTrackVideoId(track) {
    return track?._videoId || track?.videoId || null;
  }

  // ===== Detecção de videoclipe oficial (modo Vídeo do expanded-cover) =====

  const OFFICIAL_VIDEO_TTL_MS = CACHE_TTL_MS; // 5h

  // Palavras que indicam que NÃO é um clipe oficial (áudio/lyric/etc.)
  const NON_VIDEOCLIP_HINTS = /\b(audio|áudio|lyric|lyrics|letra|visualizer|topic|provided to youtube|slowed|reverb|8d|nightcore|cover)\b/i;

  // Verifica se um resultado de busca aparenta ser um videoclipe oficial
  function looksLikeOfficialVideo(video, track) {
    if (!video || !video.videoId) return false;
    const title = (video.title || '').toLowerCase();
    // Descarta claramente não-clipes
    if (NON_VIDEOCLIP_HINTS.test(title)) return false;
    // Precisa citar o nome da música (parcial) para evitar falsos positivos
    const trackTitle = getTrackTitle(track).toLowerCase().trim();
    if (trackTitle) {
      const firstWords = trackTitle.split(/\s+/).slice(0, 2).join(' ');
      if (firstWords && !title.includes(firstWords) && !title.includes(trackTitle)) {
        // título do resultado não bate com a música
        return false;
      }
    }
    return true;
  }

  // Busca o videoId do videoclipe oficial de uma faixa (ou null).
  async function findOfficialVideoId(track) {
    const title = getTrackTitle(track);
    const artists = getTrackArtists(track);
    if (!title) return null;

    const query = `${title} ${artists} videoclipe oficial`.trim();
    try {
      const data = await searchYouTubeManual(query, 0, undefined, 'tracks');
      const videos = (data && data.videos) || [];
      if (!videos.length) return null;
      // Prioriza o primeiro resultado que aparente ser clipe oficial
      const match = videos.find(v => looksLikeOfficialVideo(v, track));
      return match ? match.videoId : null;
    } catch (e) {
      console.warn(`⚠️ [VIDEOCLIP] Falha ao buscar clipe: ${e.message}`);
      return null;
    }
  }

  // Garante (com cache/dedup) a detecção do clipe oficial de uma faixa.
  // Retorna o videoId (string) ou null. Nunca lança.
  function ensureOfficialVideo(track) {
    if (!track) return Promise.resolve(null);

    // Faixas sem origem no YouTube (ex.: fallback 4shared) nunca têm clipe.
    const trackVideoId = getTrackVideoId(track);
    if (trackVideoId && String(trackVideoId).startsWith('4s-')) {
      return Promise.resolve(null);
    }

    const key = getTrackKey(track);
    if (!key) return Promise.resolve(null);

    const cached = getCacheEntry(state.officialVideoCache, key, OFFICIAL_VIDEO_TTL_MS);
    if (cached !== null) {
      return Promise.resolve(cached.videoId || null);
    }

    if (state.officialVideoPromises.has(key)) {
      return state.officialVideoPromises.get(key);
    }

    const promise = findOfficialVideoId(track)
      .then(videoId => {
        setCacheEntry(state.officialVideoCache, key, { videoId: videoId || null });
        return videoId || null;
      })
      .catch(() => {
        setCacheEntry(state.officialVideoCache, key, { videoId: null });
        return null;
      })
      .finally(() => {
        state.officialVideoPromises.delete(key);
      });

    state.officialVideoPromises.set(key, promise);
    return promise;
  }

  // Retorna o videoId do clipe oficial já detectado (sincrono) ou null.
  function getCachedOfficialVideoId(track) {
    if (!track) return null;
    const key = getTrackKey(track);
    if (!key) return null;
    const cached = getCacheEntry(state.officialVideoCache, key, OFFICIAL_VIDEO_TTL_MS);
    return cached ? (cached.videoId || null) : null;
  }

  // true se a busca do clipe já foi resolvida (com ou sem resultado) para a faixa.
  function isOfficialVideoResolved(track) {
    if (!track) return false;
    const key = getTrackKey(track);
    if (!key) return false;
    return getCacheEntry(state.officialVideoCache, key, OFFICIAL_VIDEO_TTL_MS) !== null;
  }

  // ===== Modo Vídeo (clipe oficial do YouTube no expanded-cover) =====
  const videoMode = (() => {
    let ytApiLoading = null;
    let ytPlayer = null;
    let ytReady = false;
    let ytEngineActive = false;      // fonte ativa é o YouTube?
    let currentMode = 'cover';       // 'cover' | 'video'
    let userPreference = 'cover';    // último modo escolhido pelo usuário
    let available = false;           // faixa atual tem clipe?
    let progressRaf = null;
    let videoResumeAt = 0;           // posição do clipe salva ao minimizar (restauração)
    let videoWasPlaying = false;     // intenção de reprodução do usuário no modo Vídeo (mantida continuamente)
    let videoHandoffPending = false; // handoff Vídeo→MP3 feito ao minimizar; reentra no Vídeo ao voltar

    function getEls() {
      return {
        wrapper: document.getElementById('expanded-cover-wrapper'),
        toggle: document.getElementById('cover-mode-toggle'),
        host: document.getElementById('yt-video-host')
      };
    }

    function isExpandedCoverOpen() {
      const w = document.getElementById('expanded-cover-wrapper');
      return !!w && w.classList.contains('visible');
    }

    const isPageVisible = () => document.visibilityState === 'visible';

    // ---- YouTube IFrame API ----
    function loadYouTubeApi() {
      if (window.YT && window.YT.Player) return Promise.resolve();
      if (ytApiLoading) return ytApiLoading;
      ytApiLoading = new Promise((resolve) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
          if (typeof prev === 'function') { try { prev(); } catch (e) {} }
          resolve();
        };
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        tag.async = true;
        document.head.appendChild(tag);
      });
      return ytApiLoading;
    }

    let playerCreating = null;
    async function ensurePlayer() {
      await loadYouTubeApi();
      if (ytPlayer) return ytPlayer;
      if (playerCreating) return playerCreating;
      const { host } = getEls();
      if (!host) return null;
      playerCreating = new Promise((resolve) => {
        const p = new YT.Player(host, {
          width: '100%',
          height: '100%',
          // Conjunto MÁXIMO de opções suportadas pela IFrame Player API para
          // ocultar/limitar os controles nativos do YouTube:
          // - controls: 0    -> remove a barra de controles (play/pause, progresso, volume, engrenagem, legendas, tela cheia)
          // - fs: 0          -> remove o botão de tela cheia nativo (usamos o nosso)
          // - disablekb: 1   -> desativa os atalhos de teclado do player
          // - iv_load_policy: 3 -> não exibe anotações/cards interativos
          // - cc_load_policy: 0 -> não força a exibição de legendas
          // - rel: 0         -> limita os vídeos relacionados ao mesmo canal
          // - playsinline: 1 -> reprodução inline (sem fullscreen forçado no iOS)
          // - modestbranding: 1 -> (descontinuado pelo YouTube, mantido por compatibilidade)
          playerVars: {
            playsinline: 1,
            controls: 0,
            modestbranding: 1,
            rel: 0,
            fs: 0,
            iv_load_policy: 3,
            disablekb: 1,
            cc_load_policy: 0,
            origin: window.location.origin
          },
          events: {
            onReady: () => {
              ytReady = true;
              try { p.setPlaybackQuality('large'); } catch (e) {}
              resolve(p);
            },
            onStateChange: onYtStateChange,
            onError: onYtError
          }
        });
      });
      ytPlayer = await playerCreating;
      playerCreating = null;
      return ytPlayer;
    }

    // Destrói COMPLETAMENTE o player do YouTube (remove o <iframe> do DOM).
    // Diferente de pauseVideo()/stopVideo() (comandos via postMessage, que NÃO
    // são processados de forma confiável com o iframe em segundo plano), a
    // remoção do DOM é síncrona e funciona sempre — garantindo que o iframe
    // libere a Media Session e pare de tocar. O host é recriado para permitir
    // recriar o player sob demanda depois.
    function destroyPlayer() {
      try { if (ytPlayer && typeof ytPlayer.destroy === 'function') ytPlayer.destroy(); } catch (e) {}
      ytPlayer = null;
      ytReady = false;
      playerCreating = null;
      // Recria o host dentro do wrapper de vídeo de nível superior. Se destroy()
      // falhou e o <iframe> permaneceu, remove-o manualmente do DOM — é a
      // remoção do DOM que efetivamente encerra a mídia e libera a Media Session.
      const vw = document.getElementById('expanded-video-wrapper');
      if (vw) {
        const existing = document.getElementById('yt-video-host');
        if (existing) { try { existing.remove(); } catch (e) {} }
        const host = document.createElement('div');
        host.id = 'yt-video-host';
        vw.insertBefore(host, vw.firstChild);
      }
    }

    function onYtStateChange(e) {
      if (!ytEngineActive) return;
      const S = window.YT && YT.PlayerState;
      if (!S) return;
      if (e.data === S.ENDED) { handleEnded(); return; }
      if (e.data === S.PLAYING) {
        try { ytPlayer?.setPlaybackQuality('large'); } catch (e) {}
        // Garante o áudio do clipe: ao voltar do segundo plano, o iOS pode ter
        // retomado/recarregado o iframe MUDO (política de autoplay). Desmutar
        // AQUI, quando o vídeo já está de fato tocando, é o momento em que o
        // unMute() "gruda" (nunca mutamos o player intencionalmente no modo Vídeo).
        try { ytPlayer?.unMute(); } catch (e) {}
        // Reprodução confirmada: registra a intenção de reprodução. Ela é
        // mantida continuamente (e não recalculada ao minimizar), pois o iOS
        // pausa o iframe ANTES do visibilitychange e apagaria a intenção.
        videoWasPlaying = true;
        state.isPlaying = true;
        updateUiState();
        startProgressLoop();
      } else if (e.data === S.PAUSED) {
        // NÃO limpa videoWasPlaying aqui: este PAUSED pode ser do SISTEMA
        // (iOS ao minimizar/app switcher/bloqueio) e a intenção do usuário
        // precisa sobreviver para a retomada automática ao voltar ao app.
        // Pausas do usuário passam por togglePlay, que atualiza a intenção.
        state.isPlaying = false;
        updateUiState();
      }
    }

    function onYtError() {
      // Clipe indisponível/embedding bloqueado: volta para a capa sem interromper o áudio.
      console.warn('⚠️ [VIDEOCLIP] Erro no player do YouTube, voltando para a capa.');
      enterCoverMode({ resume: true });
      available = false;
      updateToggleVisibility();
    }

    function handleEnded() {
      stopProgressLoop();
      // A "música" terminou (via clipe): avança para a próxima faixa.
      // A troca de faixa reentra no modo Vídeo se houver clipe.
      try { playNextTrack(); } catch (e) {}
    }

    // ---- Progresso (dirigido pelo tempo do YouTube) ----
    function startProgressLoop() {
      if (progressRaf) return;
      const tick = () => {
        if (!ytEngineActive) { progressRaf = null; return; }
        updateVideoProgress();
        progressRaf = requestAnimationFrame(tick);
      };
      progressRaf = requestAnimationFrame(tick);
    }

    function stopProgressLoop() {
      if (progressRaf) cancelAnimationFrame(progressRaf);
      progressRaf = null;
    }

    function updateVideoProgress() {
      if (!ytPlayer || !ytReady) return;
      let cur = 0, dur = 0;
      try { cur = ytPlayer.getCurrentTime() || 0; dur = ytPlayer.getDuration() || 0; } catch (e) { return; }
      const index = getActiveLibraryIndex();
      if (index < 0 || dur <= 0) return;
      const remainingMs = Math.max(0, (dur - cur) * 1000);
      setTrackDurationLabel(index, remainingMs);
      updateTrackProgress(index, Math.min(100, (cur / dur) * 100));
      updateLyricHighlight();
    }

    // Posiciona o #expanded-video-wrapper (nível superior, position:fixed) para
    // sobrepor exatamente a área da capa (16:9 centralizado sobre a arte quadrada).
    function positionVideoWrapper() {
      const wrapper = document.getElementById('expanded-video-wrapper');
      const coverImg = document.getElementById('ctrl-expanded-cover');
      if (!wrapper || !coverImg) return;
      // Em tela cheia o posicionamento é controlado pelo CSS (!important).
      if (isFullscreen()) return;
      // Usa offsetWidth/offsetHeight (tamanho de layout, ignora transforms)
      // em vez de getBoundingClientRect width/height (que retorna o rect
      // pós-transform — em mode-video a capa tem scale(0.96), o que tornaria
      // o wrapper 4% menor que o correto).
      const layoutWidth = coverImg.offsetWidth;
      const layoutHeight = coverImg.offsetHeight;
      if (!layoutWidth || !layoutHeight) return;
      // Para a posição, usa getBoundingClientRect (coordenadas reais no viewport).
      const rect = coverImg.getBoundingClientRect();
      // Calcula o centro da capa a partir do rect (que inclui o transform).
      // Como o transform é uniforme (scale), o centro é o mesmo pré ou pós-transform.
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      // Constrói o retângulo 16:9 usando o tamanho de layout (sem scale).
      const width = layoutWidth;
      const height = width * 9 / 16;
      // Desktop: amplia o wrapper para maior imersão (1.6x sobre a capa).
      const isDesktop = window.matchMedia('(min-width: 769px)').matches;
      const scale = isDesktop ? 1.6 : 1;
      const scaledWidth = width * scale;
      const scaledHeight = height * scale;
      const left = centerX - scaledWidth / 2;
      const top = centerY - scaledHeight / 2;
      wrapper.style.left = `${Math.round(left)}px`;
      wrapper.style.top = `${Math.round(top)}px`;
      wrapper.style.width = `${Math.round(scaledWidth)}px`;
      wrapper.style.height = `${Math.round(scaledHeight)}px`;
    }

    // Coalesce das atualizações: durante rotação/resize o navegador dispara
    // vários eventos em sequência; agrupa tudo em um único frame.
    let positionRaf = null;
    function schedulePositionVideoWrapper() {
      if (positionRaf) return;
      positionRaf = requestAnimationFrame(() => {
        positionRaf = null;
        positionVideoWrapper();
      });
    }

    // ---- Visual (fade + scale) ----
    function applyModeVisual(mode) {
      const els = getEls();
      if (els.wrapper) els.wrapper.classList.toggle('mode-video', mode === 'video');
      if (els.toggle) {
        els.toggle.querySelectorAll('[data-mode]').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.mode === mode);
        });
      }
      // Exibe/oculta o player de vídeo de nível superior e o posiciona sobre a capa.
      const videoWrapper = document.getElementById('expanded-video-wrapper');
      if (videoWrapper) {
        if (mode === 'video') {
          positionVideoWrapper();
          videoWrapper.classList.add('is-visible');
          videoWrapper.setAttribute('aria-hidden', 'false');
          // Reposiciona após a animação de abertura da capa assentar (o rect muda
          // durante o scale), garantindo alinhamento exato.
          requestAnimationFrame(positionVideoWrapper);
          setTimeout(positionVideoWrapper, 380);
        } else {
          videoWrapper.classList.remove('is-visible');
          videoWrapper.setAttribute('aria-hidden', 'true');
          videoWrapper.querySelector(':focus')?.blur();
        }
      }
    }

    function updateToggleVisibility() {
      // O alternador permanece sempre visível; apenas o botão "Vídeo"
      // é habilitado/desabilitado conforme a disponibilidade do clipe.
      const { toggle } = getEls();
      const videoBtn = toggle?.querySelector('[data-mode="video"]');
      if (videoBtn) {
        videoBtn.disabled = !available;
        videoBtn.setAttribute('aria-disabled', String(!available));
      }
      if (!available && ytEngineActive) {
        // A faixa atual perdeu o clipe: força modo Capa (mantém preferência).
        enterCoverMode({ resume: true });
      }
    }

    // ---- Transições de modo ----
    async function enterVideoMode() {
      const { track } = getCurrentPlayingTrack();
      const videoId = getCachedOfficialVideoId(track);
      if (!videoId) return false;

      const startAt = Math.max(0, audio.currentTime || 0);
      const wasPlaying = state.isPlaying && !audio.paused;
      // Marca engine como YouTube ANTES de silenciar o MP3 para que o handler
      // de 'pause' do áudio não altere o estado/UI.
      ytEngineActive = true;
      currentMode = 'video';
      userPreference = 'video';
      videoWasPlaying = wasPlaying;
      videoResumeAt = 0; // posição salva pertence ao clipe anterior
      applyModeVisual('video');

      // Exclusividade: silencia COMPLETAMENTE o MP3 (pause + mute) para evitar
      // qualquer sobreposição com o áudio do clipe, mesmo se algum watchdog
      // tentar retomar o <audio> enquanto o vídeo estiver ativo.
      // OBS.: audio.muted é usado EXCLUSIVAMENTE pelo modo Vídeo (o mudo do app
      // é baseado em volume/userVolume). Por isso ao sair restauramos sempre
      // audio.muted = false, de forma determinística — nunca dependemos de um
      // estado capturado, que poderia ficar preso em "true" (som some no áudio).
      try { audio.pause(); } catch (e) {}
      audio.muted = true;

      const player = await ensurePlayer();
      if (!player) {
        // Falha ao criar o player: reverte para capa.
        ytEngineActive = false;
        currentMode = 'cover';
        applyModeVisual('cover');
        audio.muted = false;
        if (wasPlaying) { try { audio.play(); } catch (e) {} }
        return false;
      }

      try {
        // Se a música estava tocando, autoplay; se pausada, apenas prepara (cue).
        if (wasPlaying) player.loadVideoById({ videoId, startSeconds: startAt });
        else player.cueVideoById({ videoId, startSeconds: startAt });
      } catch (e) {
        ytEngineActive = false;
        currentMode = 'cover';
        applyModeVisual('cover');
        audio.muted = false;
        if (wasPlaying) { try { audio.play(); } catch (e2) {} }
        return false;
      }

      state.isPlaying = wasPlaying; // confirmado pelo onStateChange
      updateUiState();
      if (wasPlaying) startProgressLoop();
      return true;
    }

    function enterCoverMode({ resume = true } = {}) {
      currentMode = 'cover';
      applyModeVisual('cover');
      // Sair do modo Vídeo também encerra qualquer tela cheia ativa.
      exitFullscreenIfActive();

      if (!ytEngineActive) {
        return;
      }

      let t = 0;
      try { if (ytPlayer && ytReady) t = ytPlayer.getCurrentTime() || 0; } catch (e) {}
      const shouldPlay = state.isPlaying;

      // Marca o engine como inativo ANTES de encerrar o vídeo, para que a
      // mudança de estado do YouTube (disparada por stopVideo) não seja tratada
      // como fim de faixa (evita avanço indevido).
      ytEngineActive = false;
      videoWasPlaying = false;
      stopProgressLoop();

      // Encerra o vídeo DESTRUINDO o iframe (remoção do DOM), como na troca de
      // faixa. Um stopVideo() via postMessage deixa o iframe vivo e ele
      // permanece registrado na Media Session do sistema: o iOS mantém a sessão
      // presa ao iframe (metadados/estado antigos), ignorando o nosso <audio>.
      // Remover o iframe libera a sessão de forma síncrona e confiável; o player
      // é recriado sob demanda ao reentrar no modo Vídeo (enterVideoMode sempre
      // recarrega o clipe via loadVideoById/cueVideoById).
      destroyPlayer();

      // Handoff de posição (melhor esforço) para o MP3.
      if (Number.isFinite(t) && t > 0 && audio.src) {
        try { audio.currentTime = t; } catch (e) {}
      }

      // Restaura o áudio do MP3 (remove o mute aplicado no modo Vídeo).
      audio.muted = false;

      if (resume && shouldPlay) {
        startPlaying();
        startPlaybackCountdown();
        updateUiState();
      } else {
        updateUiState();
      }
      // Reafirma os METADADOS de forma síncrona para o <audio> assumir os
      // controles do sistema após a liberação do iframe (faz os controles
      // aparecerem imediatamente). A re-registração atrasada dos action handlers
      // (para reabilitar avançar/retroceder) é feita em handlePlaybackStarted,
      // disparado pelo evento 'play' do <audio> — cobrindo também o caso do
      // vídeo terminar em segundo plano e avançar para a próxima faixa.
      updateMediaSession();
    }

    function stopVideo() {
      ytEngineActive = false;
      videoWasPlaying = false;
      stopProgressLoop();
      exitFullscreenIfActive();
      // DESTRÓI o iframe (remoção do DOM), em vez de apenas stopVideo(). Na troca
      // de faixa vinda do modo Vídeo — especialmente quando o vídeo termina em
      // SEGUNDO PLANO e avança para a próxima música — um simples stopVideo()
      // (postMessage) não é processado com o app em background: o iframe fica
      // "vivo", segura a Media Session (metadados/estado antigos), pode ser
      // retomado pelo Play do sistema e volta a tocar em paralelo com o MP3 ao
      // reabrir o app. Remover o iframe do DOM encerra tudo isso de forma
      // síncrona e confiável.
      destroyPlayer();
      // Garante que o MP3 volte a ser audível ao encerrar o vídeo.
      audio.muted = false;
    }

    // Restaura o modo Vídeo ao voltar ao app após minimizar. O iOS pausa o
    // iframe em segundo plano e pode descartá-lo/recarregá-lo, fazendo-o voltar
    // MUDO e/ou do início. Aqui, SEM recarregar o player: re-sincronizamos a
    // posição (se o iframe resetou), DESMUTAMOS o clipe e retomamos a reprodução
    // se ela estava ativa antes de minimizar — preservando estado e áudio.
    function restoreVideoOnReturn() {
      if (!ytPlayer || !ytReady) return;
      let cur = 0;
      try { cur = ytPlayer.getCurrentTime() || 0; } catch (e) {}
      // Se o iframe voltou do início mas tínhamos uma posição salva, re-sincroniza.
      if (videoResumeAt > 1 && cur < 1) {
        try { ytPlayer.seekTo(videoResumeAt, true); } catch (e) {}
      }
      // Retoma a reprodução. O áudio é garantido no handler de PLAYING
      // (onYtStateChange), que desmuta o clipe quando ele volta a tocar —
      // o momento correto para o unMute() "grudar" após a política de autoplay
      // do iOS. Desmutar aqui (antes de tocar) não gruda.
      if (videoWasPlaying) {
        try { ytPlayer.playVideo(); } catch (e) {}
        state.isPlaying = true;
      }
      updateUiState();
      updateMediaSession();
    }

    // ---- Overlay de controles personalizados + tela cheia ----
    const OVERLAY_HIDE_DELAY_MS = 2800;
    let overlayHideTimer = null;

    function showVideoOverlay() {
      const overlay = document.getElementById('video-overlay');
      if (!overlay) return;
      overlay.classList.add('visible');
      if (overlayHideTimer) clearTimeout(overlayHideTimer);
      overlayHideTimer = setTimeout(hideVideoOverlay, OVERLAY_HIDE_DELAY_MS);
    }

    function hideVideoOverlay() {
      if (overlayHideTimer) { clearTimeout(overlayHideTimer); overlayHideTimer = null; }
      document.getElementById('video-overlay')?.classList.remove('visible');
    }

    // Fullscreen CSS (fallback para navegadores sem element fullscreen, ex.: iPhone Safari)
    let cssFullscreen = false;

    function nativeFullscreenElement() {
      return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    function isFullscreen() {
      return !!nativeFullscreenElement() || cssFullscreen;
    }

    function enterCssFullscreen() {
      const el = document.getElementById('expanded-video-wrapper');
      if (!el) return;
      el.classList.add('css-fullscreen');
      cssFullscreen = true;
      updateFullscreenIcon();
      syncFullscreenChrome();
    }

    function exitCssFullscreen() {
      document.getElementById('expanded-video-wrapper')?.classList.remove('css-fullscreen');
      cssFullscreen = false;
      updateFullscreenIcon();
      syncFullscreenChrome();
      // Volta a posicionar o vídeo sobre a capa (modo Vídeo normal).
      positionVideoWrapper();
    }

    function exitAnyFullscreen() {
      if (cssFullscreen) { exitCssFullscreen(); return; }
      if (nativeFullscreenElement()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        try { exit?.call(document); } catch (e) {}
      }
    }

    async function toggleFullscreen() {
      const el = document.getElementById('expanded-video-wrapper');
      if (!el) return;

      if (isFullscreen()) {
        exitAnyFullscreen();
        return;
      }

      // 1) Fullscreen API nativa (Desktop, Android Chrome, iPad Safari).
      //    Deve ser chamada dentro do gesto do usuário (o clique do botão).
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) {
        try {
          const result = req.call(el);
          if (result && typeof result.then === 'function') {
            await result; // pode rejeitar em navegadores que não permitem fullscreen de <div>
          }
          return; // sucesso: o ícone é atualizado via fullscreenchange
        } catch (e) {
          // Ex.: iOS iPhone não permite fullscreen de elementos que não sejam <video>.
        }
      }

      // 2) Fallback CSS (iPhone Safari e afins): "tela cheia" cobrindo o viewport
      //    via position:fixed, sem recarregar o iframe (preserva reprodução/sincronização).
      enterCssFullscreen();
    }

    function updateFullscreenIcon() {
      const icon = document.querySelector('#video-fullscreen-btn i');
      if (icon) icon.className = isFullscreen() ? 'ph-bold ph-arrows-in' : 'ph-bold ph-arrows-out';
    }

    // Mantém uma classe no <body> refletindo o estado de tela cheia, para que a
    // interface fora da experiência de reprodução (ex.: quick-actions-nav) seja
    // ocultada tanto no fullscreen nativo quanto no CSS.
    function syncFullscreenChrome() {
      document.body.classList.toggle('video-fullscreen-active', isFullscreen());
    }

    function onNativeFullscreenChange() {
      updateFullscreenIcon();
      syncFullscreenChrome();
      // Ao sair da tela cheia nativa, reposiciona o vídeo sobre a capa.
      if (!isFullscreen()) positionVideoWrapper();
    }

    function initVideoControls() {
      const overlay = document.getElementById('video-overlay');
      const fsBtn = document.getElementById('video-fullscreen-btn');
      if (!overlay) return;

      // Exibe o overlay ao mover o mouse (desktop) ou tocar (mobile).
      const reveal = () => showVideoOverlay();
      overlay.addEventListener('pointermove', reveal);
      overlay.addEventListener('pointerdown', reveal);
      overlay.addEventListener('touchstart', reveal, { passive: true });

      // Clique no botão personalizado entra/sai da tela cheia.
      fsBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        showVideoOverlay(); // reinicia o timer
        toggleFullscreen();
      });

      document.addEventListener('fullscreenchange', onNativeFullscreenChange);
      document.addEventListener('webkitfullscreenchange', onNativeFullscreenChange);
      // Escape encerra a tela cheia CSS (a nativa já é tratada pelo navegador).
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && cssFullscreen) exitCssFullscreen();
      });
    }

    // Encerra qualquer tela cheia ativa (nativa ou CSS). Usado ao sair do modo Vídeo.
    function exitFullscreenIfActive() {
      if (isFullscreen()) exitAnyFullscreen();
    }

    // ---- Disponibilidade / restauração ----
    function refreshAvailability() {
      const { track } = getCurrentPlayingTrack();
      if (!track) { available = false; updateToggleVisibility(); return; }

      if (isOfficialVideoResolved(track)) {
        available = !!getCachedOfficialVideoId(track);
        updateToggleVisibility();
        maybeAutoRestore();
        return;
      }

      // Ainda não resolvido: dispara detecção e atualiza ao concluir.
      available = false;
      updateToggleVisibility();
      const keyAtRequest = getTrackKey(track);
      ensureOfficialVideo(track).then(id => {
        const cur = getCurrentPlayingTrack().track;
        if (!cur || getTrackKey(cur) !== keyAtRequest) return;
        available = !!id;
        updateToggleVisibility();
        maybeAutoRestore();
      });
    }

    function maybeAutoRestore() {
      if (userPreference === 'video' && available && !ytEngineActive &&
          isExpandedCoverOpen() && isPageVisible()) {
        enterVideoMode();
      }
    }

    // ---- Hooks externos ----
    function onExpandedCoverOpen() {
      applyModeVisual('cover');
      refreshAvailability();
      maybeAutoRestore();
    }

    function onExpandedCoverClose() {
      if (ytEngineActive) enterCoverMode({ resume: true });
    }

    // Chamado no INÍCIO da troca de faixa (antes do novo áudio começar).
    // Encerra o vídeo anterior e volta o visual para a Capa. A detecção do
    // clipe e a eventual reentrada no modo Vídeo são adiadas para
    // onTrackPlaying(), garantindo que só haja uma fonte de mídia ativa.
    function onTrackChanged() {
      if (ytEngineActive) stopVideo();
      currentMode = 'cover';
      applyModeVisual('cover');
      // Desabilita o botão Vídeo até detectar o clipe da nova faixa.
      available = false;
      updateToggleVisibility();
    }

    // Chamado quando o áudio da nova faixa começou a tocar de fato.
    // Detecta o clipe e, se a preferência do usuário for Vídeo e a capa estiver
    // aberta, reentra no modo Vídeo (carregando e reproduzindo o novo clipe).
    // Evita buscas desnecessárias quando a capa está fechada e o usuário não
    // está no modo Vídeo (o botão só é visível com a capa aberta).
    function onTrackPlaying() {
      if (isExpandedCoverOpen() || userPreference === 'video') {
        refreshAvailability();
      }
    }

    function init() {
      initVideoControls();
      const { toggle } = getEls();
      toggle?.querySelectorAll('[data-mode]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const mode = btn.dataset.mode;
          if (mode === 'video') {
            userPreference = 'video';
            if (available) enterVideoMode();
          } else {
            userPreference = 'cover';
            enterCoverMode({ resume: true });
          }
        });
      });

      // Segundo plano (handoff imediato): ao minimizar no modo Vídeo, o iOS
      // pausa o iframe e congela a página — nada tocaria em segundo plano e a
      // Media Session morreria. Para preservá-la, forçamos o AUTOPLAY do MP3 no
      // ponto MAIS PRECOCE e confiável do ciclo de vida: SINCRONAMENTE dentro
      // do próprio 'visibilitychange: hidden'.
      //  - 'blur' dispara antes, mas tem falsos positivos (teclado, diálogos,
      //    app switcher sem minimizar) e derrubaria o modo Vídeo à toa;
      //  - 'pagehide' NÃO dispara ao minimizar (só em navegação) e 'freeze'
      //    não existe no WebKit;
      //  - setTimeout/promessas NÃO servem: timers congelam em segundo plano.
      // Tudo acontece na MESMA task do evento, antes da suspensão:
      // enterCoverMode captura a posição do clipe, DESTRÓI o iframe (libera a
      // Media Session dele de forma síncrona), desmuta e dá play() no MP3 — o
      // <audio> já tem ativação de usuário na sessão, então o autoplay é
      // permitido — e reafirma metadados/posição na Media Session. Ao voltar,
      // reentramos no modo Vídeo na posição atual do MP3.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          if (!ytEngineActive) return; // só age no modo Vídeo
          try {
            const cur = (ytPlayer && ytReady) ? (ytPlayer.getCurrentTime() || 0) : 0;
            if (cur > 0) videoResumeAt = cur;
          } catch (e) {}
          // Intenção preservada (videoWasPlaying é mantida continuamente): o
          // PAUSED do sistema pode ter zerado state.isPlaying ANTES deste
          // evento (app switcher/bloqueio) — restaura para o handoff retomar.
          if (videoWasPlaying) state.isPlaying = true;
          videoHandoffPending = true;
          enterCoverMode({ resume: true });
        } else if (videoHandoffPending) {
          videoHandoffPending = false;
          // O play() do handoff pode ter sido bloqueado em segundo plano;
          // retoma agora que a página está visível.
          if (state.isPlaying && audio.paused && audio.src) {
            const p = audio.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          }
          // Reentra no modo Vídeo na posição atual do MP3 (se a preferência
          // continuar sendo Vídeo, com clipe disponível e capa aberta).
          maybeAutoRestore();
        } else if (ytEngineActive) {
          // Fallback: engine ainda ativo sem handoff pendente — restaura o
          // estado do próprio iframe (posição/reprodução).
          restoreVideoOnReturn();
        }
      });

      // Mantém o vídeo alinhado quando o viewport muda (rotação, barra de URL
      // mostrando/ocultando, tela cheia). Como o iframe tem tamanho de layout
      // FIXO e é ajustado apenas por transform, isto atualiza só a geometria do
      // wrapper e o fator de escala — barato e seguro em qualquer quantidade de
      // rotações.
      const onViewportChange = () => {
        if (!ytEngineActive) return;
        if (isFullscreen()) return;
        // Reposiciona imediatamente (via RAF coalesced) e escalona
        // retentativas para capturar o rect definitivo após cada
        // estágio da animação de rotação do iOS (~100-700ms).
        schedulePositionVideoWrapper();
        setTimeout(schedulePositionVideoWrapper, 100);
        setTimeout(schedulePositionVideoWrapper, 300);
        setTimeout(schedulePositionVideoWrapper, 500);
        setTimeout(schedulePositionVideoWrapper, 700);
      };
      window.addEventListener('resize', onViewportChange, { passive: true });
      window.addEventListener('orientationchange', onViewportChange, { passive: true });
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onViewportChange, { passive: true });
      }
    }

    return {
      init,
      onExpandedCoverOpen,
      onExpandedCoverClose,
      onTrackChanged,
      onTrackPlaying,
      // engine (roteamento de controles)
      isVideo: () => ytEngineActive,
      getCurrentTime: () => {
        try { return (ytPlayer && ytReady) ? (ytPlayer.getCurrentTime() || 0) : 0; } catch (e) { return 0; }
      },
      getDuration: () => {
        try { return (ytPlayer && ytReady) ? (ytPlayer.getDuration() || 0) : 0; } catch (e) { return 0; }
      },
      togglePlay: () => {
        if (!ytPlayer || !ytReady) return;
        try {
          const S = YT.PlayerState;
          if (ytPlayer.getPlayerState() === S.PLAYING) {
            videoWasPlaying = false; // pausa explícita do usuário
            ytPlayer.pauseVideo();
          } else {
            videoWasPlaying = true;
            ytPlayer.playVideo();
          }
        } catch (e) {}
      },
      seekTo: (sec) => {
        try { if (ytPlayer && ytReady) ytPlayer.seekTo(sec, true); } catch (e) {}
      }
    };
  })();

  function trackAudioError(index) {
    if (!Number.isInteger(index)) return 1;
    const now = Date.now();
    const entry = state.audioErrorCounts.get(index) || { count: 0, ts: 0 };
    const withinWindow = now - entry.ts < AUDIO_ERROR_RESET_MS;
    const count = withinWindow ? entry.count + 1 : 1;
    state.audioErrorCounts.set(index, { count, ts: now });
    return count;
  }

  function resetAudioError(index) {
    if (!Number.isInteger(index)) return;
    state.audioErrorCounts.delete(index);
  }

  // Helper para marcar reprodução bem-sucedida
  function markPlaybackSuccess(index) {
    // Métrica: tempo até a primeira música tocar na sessão
    if (metrics.firstPlayMs === null) {
      metrics.firstPlayMs = Date.now() - APP_STARTED_AT;
      console.log(`⏱️ [METRICS] Primeira música tocando após ${Math.round(metrics.firstPlayMs / 1000)}s da inicialização`);
    }
    finishPlayTiming();
    state.isPlaying = true;
    resetAudioError(index);

    // Retomada após reload/crash: salta para a posição salva na primeira vez que
    // a faixa restaurada começar a tocar.
    if (pendingResume) {
      if (index === pendingResume.index && state.playingPlaylistId === pendingResume.playlistId) {
        const pos = pendingResume.positionSec;
        pendingResume = null;
        if (pos > 1) {
          const seekTo = () => {
            try {
              if (!Number.isFinite(audio.duration) || pos < audio.duration - 1) {
                audio.currentTime = pos;
              }
            } catch (_) {}
          };
          if (audio.readyState >= 1) seekTo();
          else audio.addEventListener('loadedmetadata', seekTo, { once: true });
        }
      } else {
        // Usuário escolheu outra faixa: descarta a retomada pendente.
        pendingResume = null;
      }
    }

    updateUiState();
    advanceScheduled = false;
    // Com o áudio da nova faixa já tocando, tenta reentrar no modo Vídeo
    // (se for a preferência do usuário e houver clipe disponível).
    videoMode.onTrackPlaying();
  }

  // Helper para parar a reprodução
  function stopPlaying() {
    state.isPlaying = false;
    state.isLoadingTrack = false;
    resetTrackEndFallback();
  }

  // Helper para iniciar reprodução do áudio
  function startPlaying() {
    const p = audio.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    state.isPlaying = true;
  }

  // Helper para pausar reprodução do áudio
  function pausePlaying() {
    audio.pause();
    state.isPlaying = false;
  }

  // Helper para atualizar o estado visual do botão de favorito
  function updateFavoriteButtonState(button, isFavorite) {
    const icon = button?.querySelector('i');
    if (!icon) return;
    
    icon.className = isFavorite ? 'ph-fill ph-heart text-base' : 'ph-bold ph-heart text-base';
    button.classList.toggle('is-favorite', isFavorite);
    button.setAttribute('aria-label', isFavorite ? 'Já nos favoritos' : 'Adicionar aos favoritos');
    button.setAttribute('title', isFavorite ? 'Já nos favoritos' : 'Adicionar aos favoritos');
  }

  // Helper para criar objeto de feedback de track
  function getTrackFeedbackInfo(track) {
    return {
      name: track.name,
      cover: getTrackImage(track),
      subtitle: getTrackArtists(track)
    };
  }

  // Helper para criar objeto de feedback de playlist
  function getPlaylistFeedbackInfo(playlist) {
    return {
      name: playlist.name,
      cover: getPlaylistCover(playlist)
    };
  }

  // Helper para obter contagem de tracks de uma playlist
  function getPlaylistTrackCount(playlist) {
    return playlist?.tracks?.length || 0;
  }

  // Helper para falha de reprodução e pular para próxima
  function handlePlaybackFailure(index) {
    stopPlaying();
    stopPlaybackCountdown({ resetLabel: true, index });
    safeResetAudio();
    updateUiState();
    playNextFrom(index + 1);
  }

  // Helper para marcar track como indisponível e tratar falha de reprodução
  function handleUnavailableTrack(index) {
    markTrackUnavailable(index);
    handlePlaybackFailure(index);
  }

  // Orquestra a resolução de uma faixa, compartilhando promessas em andamento
  async function resolveTrackWithCache(track, index, { forceRefresh = false, preserveFailures = false } = {}) {
    if (!track) return null;

    const key = getTrackKey(track);
    if (!key) return null;

    if (forceRefresh) {
      // Corrida preload vs play: se já existe resolução em andamento para a
      // mesma faixa, espera terminar antes de limpar caches e refazer.
      // Evita duas resoluções de rede simultâneas para a mesma key.
      const inflight = state.searchPromises.get(key);
      if (inflight) {
        metrics.resolve.deduped += 1;
        await inflight.catch(() => null);
      }
      clearTrackCaches(key, null, { preserveFailures });
    } else {
      const cached = getCacheEntry(state.searchCache, key);
      if (cached !== null) {
        updateTrackDurationFromResult(track, index, cached);
        return cached;
      }

      const pending = state.searchPromises.get(key);
      if (pending) {
        metrics.resolve.deduped += 1;
        try {
          return await pending;
        } catch {
          // Se a promessa falhar, continua para uma nova tentativa
        }
      }
    }

    const task = (async () => {
      const result = await resolveTrackAudio(track, index, forceRefresh);
      updateTrackDurationFromResult(track, index, result);
      return result;
    })();

    state.searchPromises.set(key, task);

    try {
      const result = await task;
      updateTrackDurationFromResult(track, index, result);
      return result;
    } finally {
      if (state.searchPromises.get(key) === task) {
        state.searchPromises.delete(key);
      }
    }
  }

  const ui = {
    playerModal: null,
    myPlaylistsSection: null,
    myPlaylistsGrid: null,
    reorderPlaylistsBtn: null,
    tracksContainer: null,
    playlistEmptyState: null,
    reimportBtn: null,
    playerSettingsBtn: null,
    playerSettingsDropdown: null,
    playerSettingsOverlay: null,
    settingsImportCsvBtn: null,
    settingsImportInfoBtn: null,
    fileInput: null,
    feedback: null,
    feedbackText: null,
    feedbackTitle: null,
    feedbackCover: null,
    feedbackIcon: null,
    closePlayerBtn: null,
    tabDiscover: null,
    tabPlaylist: null,
    tabYoutube: null,
    tabRadio: null,
    screenDiscover: null,
    screenPlaylist: null,
    screenYoutube: null,
    screenRadio: null,
    youtubeEmptyState: null,
    youtubeSearchContent: null,
    featuredPlaylistsGrid: null,
    specialPlaylistsGrid: null,
    manualSearchInput: null,
    manualSearchBtn: null,
    manualSearchResults: null,
    playlistPickerModal: null,
    playlistPickerCard: null,
    playlistPickerTrack: null,
    playlistPickerList: null,
    closePlaylistPickerBtn: null,
    showNewPlaylistBtn: null,
    newPlaylistForm: null,
    newPlaylistName: null,
    confirmNewPlaylistBtn: null,
    cancelNewPlaylistBtn: null,
    youtubeSearchBarWrapper: null,
    youtubeSearchBtnContainer: null,
    youtubeSearchOverlay: null,
    youtubeSearchTrigger: null,
    youtubeSearchCancel: null,
    searchTypeTracks: null,
    searchTypePlaylists: null,
    importInfoModal: null,
    closeImportInfoBtn: null,
    ctrlPlay: null,
    ctrlPrev: null,
    ctrlNext: null,
    ctrlShuffle: null,
    ctrlRepeat: null,
    ctrlVolumeBtn: null,
    ctrlVolume: null,
    ctrlTitle: null,
    ctrlArtist: null,
    ctrlCover: null,
    volumeContainer: null,
    miniPlay: null,
    miniPrev: null,
    miniNext: null,
    miniShuffle: null,
    miniRepeat: null,
    miniVolumeBtn: null,
    miniVolume: null,
    miniVolumeContainer: null,
    miniPlayerBar: null,
    miniTitle: null,
    miniArtist: null,
    miniCover: null
  };

  // Função para popular o objeto ui após o HTML ser injetado
  function populateUiElements() {
    ui.playerModal = document.getElementById('player-modal');
    ui.myPlaylistsSection = document.getElementById('my-playlists-section');
    ui.myPlaylistsGrid = document.getElementById('my-playlists-grid');
    ui.reorderPlaylistsBtn = document.getElementById('reorder-playlists-btn');
    ui.tracksContainer = document.getElementById('tracks-container');
    ui.playlistEmptyState = document.getElementById('playlist-empty-state');
    ui.reimportBtn = document.getElementById('reimport-btn');
    ui.playerSettingsBtn = document.getElementById('player-settings-btn');
    ui.playerSettingsDropdown = document.getElementById('player-settings-dropdown');
    ui.playerSettingsOverlay = document.getElementById('player-settings-overlay');
    ui.settingsImportCsvBtn = document.getElementById('settings-import-csv-btn');
    ui.settingsImportInfoBtn = document.getElementById('settings-import-info-btn');
    ui.fileInput = document.getElementById('csv-file-input');
    ui.feedback = document.getElementById('player-feedback');
    ui.feedbackText = document.getElementById('player-feedback-text');
    ui.feedbackTitle = document.getElementById('player-feedback-title');
    ui.feedbackCover = document.getElementById('player-feedback-cover');
    ui.feedbackIcon = document.getElementById('player-feedback-icon');

    ui.tabDiscover = document.getElementById('tab-discover');
    ui.tabPlaylist = document.getElementById('tab-playlist');
    ui.tabYoutube = document.getElementById('tab-youtube');
    ui.tabRadio = document.getElementById('tab-radio');
    ui.screenDiscover = document.getElementById('player-screen-discover');
    ui.screenPlaylist = document.getElementById('player-screen-playlist');
    ui.screenYoutube = document.getElementById('player-screen-youtube');
    ui.screenRadio = document.getElementById('player-screen-radio');
    ui.youtubeEmptyState = document.getElementById('youtube-empty-state');
    ui.youtubeSearchContent = document.getElementById('youtube-search-content');
    ui.featuredPlaylistsGrid = document.getElementById('featured-playlists-grid');
    ui.specialPlaylistsGrid = document.getElementById('special-playlists-grid');
    ui.manualSearchInput = document.getElementById('manual-search-input');
    ui.manualSearchBtn = document.getElementById('manual-search-btn');
    ui.manualSearchResults = document.getElementById('manual-search-results');
    ui.playlistPickerModal = document.getElementById('playlist-picker-modal');
    ui.playlistPickerCard = document.getElementById('playlist-picker-card');
    ui.playlistPickerTrack = document.getElementById('playlist-picker-track');
    ui.playlistPickerList = document.getElementById('playlist-picker-list');
    ui.closePlaylistPickerBtn = document.getElementById('close-playlist-picker-btn');
    ui.showNewPlaylistBtn = document.getElementById('show-new-playlist-btn');
    ui.newPlaylistForm = document.getElementById('new-playlist-form');
    ui.newPlaylistName = document.getElementById('new-playlist-name');
    ui.confirmNewPlaylistBtn = document.getElementById('confirm-new-playlist-btn');
    ui.cancelNewPlaylistBtn = document.getElementById('cancel-new-playlist-btn');
    ui.youtubeSearchBarWrapper = document.getElementById('youtube-search-bar-wrapper');
    ui.youtubeSearchBtnContainer = document.getElementById('youtube-search-btn-container');
    ui.youtubeSearchOverlay = document.getElementById('youtube-search-overlay');
    ui.youtubeSearchTrigger = document.getElementById('youtube-search-trigger');
    ui.youtubeSearchCancel = document.getElementById('youtube-search-cancel');
    ui.searchTypeTracks = document.getElementById('search-type-tracks');
    ui.searchTypePlaylists = document.getElementById('search-type-playlists');
    ui.importInfoModal = document.getElementById('import-info-modal');
    ui.closeImportInfoBtn = document.getElementById('close-import-info-modal');
    ui.ctrlPlay = document.getElementById('ctrl-play');
    ui.ctrlPrev = document.getElementById('ctrl-prev');
    ui.ctrlNext = document.getElementById('ctrl-next');
    ui.ctrlShuffle = document.getElementById('ctrl-shuffle');
    ui.ctrlRepeat = document.getElementById('ctrl-repeat');
    ui.ctrlVolumeBtn = document.getElementById('ctrl-volume-btn');
    ui.ctrlVolume = document.getElementById('ctrl-volume');
    ui.ctrlTitle = document.getElementById('ctrl-title');
    ui.ctrlArtist = document.getElementById('ctrl-artist');
    ui.ctrlCover = document.getElementById('ctrl-cover');
    ui.volumeContainer = document.getElementById('volume-slider-container');
    ui.ctrlExpandedCover = document.getElementById('ctrl-expanded-cover');
    ui.expandedCoverWrapper = document.getElementById('expanded-cover-wrapper');
    ui.expandedLyrics = document.getElementById('expanded-lyrics');
    ui.lyricsScroll = ui.expandedLyrics?.querySelector('.lyrics-scroll') || null;
    ui.coverShareBtn = document.getElementById('cover-share-btn');

  }

  const createAudioElement = (existing = null) => {
    let el = existing;
    if (!el) {
      el = new Audio();
      el.style.display = 'none';
      if (document.body) {
        document.body.appendChild(el);
      } else {
        window.addEventListener('DOMContentLoaded', () => document.body.appendChild(el));
      }
    }
    el.preload = 'auto';
    el.playsInline = true;
    return el;
  };

  let audio = createAudioElement(document.getElementById('audio-player'));
  let secondaryAudio = createAudioElement();
  let fadingOutAudio = null;

  const CROSSFADE_DURATION_MS = 10000;
  const MIN_CROSSFADE_TRACK_MS = 12000;

  let crossfadeInProgress = false;
  let crossfadeTimer = null;
  let autoCrossfadeTriggeredKey = null;
  let crossfadePending = false;
  let fadeInLevel = 1;
  let fadeOutLevel = 0;
  let userVolume = 1;
  let handlingEnded = false;
  let advancingToNext = false;
  let advanceScheduled = false;
  let trackEndFallbackKey = null;
  let trackEndWatchdogTimer = null;

  // Conjunto de elementos cujos erros devem ser ignorados durante reset
  const ignoringErrorsSet = new WeakSet();

  // Helper para verificar se o áudio está realmente tocando
  function isAudioPlaying() {
    return state.isPlaying && !audio.paused && !audio.ended;
  }

  // Helper para verificar se há uma track válida selecionada
  function hasValidTrack() {
    if (state.playingPlaylistId === 'youtube-search' || isPlayingFromYouTube()) return false;
    return state.tracks.length > 0 && state.currentTrackIndex >= 0;
  }

  // Helper para verificar se a playlist em visualização é a mesma em reprodução
  function isViewingPlayingPlaylist() {
    return state.playingPlaylistId === state.currentPlaylist?.id;
  }

  const clampVolume = (value) => Math.max(0, Math.min(1, value));

  function applyVolumeLevels(includeFading = true) {
    const activeVolume = clampVolume(userVolume * (crossfadeInProgress ? fadeInLevel : 1));
    if (audio) audio.volume = activeVolume;
    if (secondaryAudio && secondaryAudio !== audio && !crossfadeInProgress) {
      secondaryAudio.volume = clampVolume(userVolume);
    }
    if (includeFading && fadingOutAudio) {
      fadingOutAudio.volume = clampVolume(userVolume * (crossfadeInProgress ? fadeOutLevel : 0));
    }
  }

  function setUserVolume(value) {
    userVolume = clampVolume(value);
    applyVolumeLevels(true);
  }

  function resetAutoCrossfadeState() {
    autoCrossfadeTriggeredKey = null;
  }

  function resetTrackEndFallback() {
    trackEndFallbackKey = null;
    if (trackEndWatchdogTimer) {
      clearTimeout(trackEndWatchdogTimer);
      trackEndWatchdogTimer = null;
    }
  }

  // Agenda um timer de segurança que verifica se a faixa deveria ter terminado.
  // Cobre o caso em que nem 'ended' nem 'timeupdate' disparam (ex.: áudio fora do DOM + Media Session).
  function scheduleTrackEndWatchdog() {
    if (trackEndWatchdogTimer) {
      clearTimeout(trackEndWatchdogTimer);
      trackEndWatchdogTimer = null;
    }
    const dur = audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const remaining = dur - audio.currentTime;
    if (remaining <= 0) return;
    // Dispara 1.5s após o término esperado como margem de segurança
    trackEndWatchdogTimer = setTimeout(() => {
      trackEndWatchdogTimer = null;
      maybeForceTrackEnd();
    }, (remaining + 1.5) * 1000);
  }

  // Fallback: detecta fim da faixa via currentTime quando 'ended' não dispara.
  // Chamado por timeupdate e pelo watchdog timer.
  function maybeForceTrackEnd() {
    if (crossfadeInProgress || crossfadePending) return;
    if (state.isLoadingTrack || advancingToNext || advanceScheduled) return;
    if (handlingEnded) return;
    // Se o usuário pausou explicitamente, não tratar como fim da faixa
    if (!state.isPlaying) return;
    if (!hasValidTrack()) return;
    if (isPlayingFromYouTube()) return;

    const dur = audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;

    const remaining = dur - audio.currentTime;
    // Só dispara se muito próximo do final (< 300ms) ou se o áudio já terminou (ended)
    if (remaining > 0.3 && !audio.ended) return;

    const { index } = getCurrentPlayingTrack();
    const key = `end-${state.playingPlaylistId || 'library'}-${index}`;
    if (trackEndFallbackKey === key) return;
    trackEndFallbackKey = key;

    audioHandlers.ended();
  }

  function handlePlaybackStarted() {
    state.isPlaying = true;
    state.isLoadingTrack = false;
    if (!isPlayingFromYouTube() && isLibraryPlaybackVisible()) {
      const activeIndex = getActiveLibraryIndex();
      if (activeIndex >= 0) {
        setTrackLoading(activeIndex, false); // Esconde spinner
      }
    }
    applyVolumeLevels(true);
    updateUiState();
    if (!isPlayingFromYouTube()) {
      startPlaybackCountdown();
    } else {
      stopPlaybackCountdown({ resetLabel: false });
    }
    // Força remoção dos handlers de seek ao iniciar reprodução
    forceRemoveSeekHandlers();
    // Atualiza visual do YouTube se estiver tocando de lá
    if (isPlayingFromYouTube()) {
      updateYouTubeSearchHighlight();
      startYouTubeSearchCountdown();
    } else {
      stopYouTubeSearchCountdown();
    }
    // Só reseta estado do auto-crossfade se NÃO houver crossfade em andamento/pendente
    if (!crossfadeInProgress && !crossfadePending) {
      resetAutoCrossfadeState();
    }
    // Reseta fallback de fim de faixa e agenda watchdog para a nova faixa
    resetTrackEndFallback();
    scheduleTrackEndWatchdog();

    // Reafirma a MediaSession (handlers + metadados) com um pequeno atraso ao
    // iniciar a reprodução do <audio>. Isso cobre TODAS as transições do modo
    // Vídeo para o modo Áudio — inclusive quando o vídeo TERMINA em segundo
    // plano e avança para a próxima faixa (fluxo que não passa por
    // enterCoverMode). Nesses casos o iframe do YouTube era o dono da sessão;
    // sem reafirmar, os controles do sistema não aparecem ou vêm com
    // avançar/retroceder desabilitados. O atraso evita reafirmar durante a
    // transição de sessão do iOS (síncrono demais faz o iOS descartar a sessão).
    if (!isPlayingFromYouTube()) {
      setTimeout(() => {
        if (videoMode.isVideo()) return; // voltou ao modo Vídeo nesse intervalo
        setupMediaSessionHandlers();
        updateMediaSession();
      }, 400);
    }
  }

  function cancelCrossfade() {
    if (crossfadeTimer) {
      clearTimeout(crossfadeTimer);
      crossfadeTimer = null;
    }
    crossfadeInProgress = false;
    crossfadePending = false;
    resetTrackEndFallback();
    fadeInLevel = 1;
    fadeOutLevel = 0;
    if (secondaryAudio && secondaryAudio !== audio) {
      safeResetAudio(secondaryAudio);
    }
    if (fadingOutAudio) {
      try { fadingOutAudio.volume = userVolume; } catch (_) { }
      detachCoreAudioListeners(fadingOutAudio);
      resetAudioElement(fadingOutAudio);
      // Recicla o elemento fading out como secondaryAudio em vez de descartá-lo
      if (!secondaryAudio || secondaryAudio === audio) {
        secondaryAudio = fadingOutAudio;
      }
      fadingOutAudio = null;
    }
    applyVolumeLevels(false);
  }

  async function tryPlayElement(target) {
    // Espera o áudio estar pronto antes de tentar reproduzir
    if (target.readyState < 2) {
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            target.removeEventListener('canplay', onReady);
            target.removeEventListener('error', onError);
            reject(new Error('canplay timeout'));
          }, 15000);
          const onReady = () => {
            clearTimeout(timeout);
            target.removeEventListener('error', onError);
            resolve();
          };
          const onError = () => {
            clearTimeout(timeout);
            target.removeEventListener('canplay', onReady);
            reject(new Error('audio load error'));
          };
          target.addEventListener('canplay', onReady, { once: true });
          target.addEventListener('error', onError, { once: true });
        });
      } catch (_) {
        return false;
      }
    }
    const retryDelays = [0, 50, 100];
    for (const waitMs of retryDelays) {
      if (waitMs > 0) await delay(waitMs);
      try {
        await target.play();
        return true;
      } catch (_) {
        continue;
      }
    }
    return false;
  }

  async function playWithCrossfade(audioUrl, { isStale } = {}) {
    // Nota: cancelCrossfade() já foi chamada por playTrackInternal antes desta função

    // Se não estiver tocando nada, volta para reprodução normal
    if (!isAudioPlaying() || audio.paused || audio.ended || isPlayingFromYouTube()) {
      await resetAudioWithDelay(audio);
      loadAudioSource(audioUrl, audio);
      state.currentAttemptUrl = audioUrl;
      return tryPlayElement(audio);
    }

    // Garante que temos um secondaryAudio válido (pode ser null se foi reciclado)
    if (!secondaryAudio || secondaryAudio === audio) {
      secondaryAudio = createAudioElement();
    }

    // Prepara áudio secundário
    await resetAudioWithDelay(secondaryAudio);
    state.currentAttemptUrl = audioUrl;
    loadAudioSource(audioUrl, secondaryAudio);
    secondaryAudio.volume = 0;

    const started = await tryPlayElement(secondaryAudio);
    if (!started) {
      // Fallback: reprodução normal
      await resetAudioWithDelay(audio);
      loadAudioSource(audioUrl, audio);
      return tryPlayElement(audio);
    }

    // Troca o elemento principal para o novo áudio e mantém o antigo para fade-out
    const outgoing = audio;
    detachCoreAudioListeners(outgoing);
    fadingOutAudio = outgoing;

    audio = secondaryAudio;
    attachCoreAudioListeners(audio);
    // Não cria novo elemento; secondaryAudio será reciclado de fadingOutAudio ao fim do crossfade
    secondaryAudio = null;

    // Define estado do crossfade ANTES de handlePlaybackStarted para evitar
    // glitch de volume (applyVolumeLevels precisa saber que crossfade está ativo)
    crossfadeInProgress = true;
    crossfadePending = false;
    fadeInLevel = 0;
    fadeOutLevel = 1;
    applyVolumeLevels(true);

    handlePlaybackStarted();

    const startTs = performance.now();
    const duration = CROSSFADE_DURATION_MS;
    // Usa setTimeout em vez de requestAnimationFrame para que o crossfade
    // continue em background (tela bloqueada / Media Session API).
    // RAF para completamente em background; setTimeout continua (~1s de intervalo).
    const CROSSFADE_STEP_MS = 50;

    return await new Promise((resolve) => {
      const step = () => {
        if (isStale?.()) {
          cancelCrossfade();
          resolve(false);
          return;
        }
        const now = performance.now();
        const progress = Math.min(1, (now - startTs) / duration);
        fadeInLevel = progress;
        fadeOutLevel = 1 - progress;
        applyVolumeLevels(true);

        if (progress < 1) {
          crossfadeTimer = setTimeout(step, CROSSFADE_STEP_MS);
          return;
        }

        // Finaliza crossfade
        crossfadeTimer = null;
        crossfadeInProgress = false;
        fadeInLevel = 1;
        fadeOutLevel = 0;

        if (fadingOutAudio) {
          detachCoreAudioListeners(fadingOutAudio);
          resetAudioElement(fadingOutAudio);
          // Recicla o elemento antigo como secondaryAudio para o próximo crossfade
          secondaryAudio = fadingOutAudio;
          fadingOutAudio = null;
        }

        // Garante que temos um secondaryAudio pronto
        if (!secondaryAudio || secondaryAudio === audio) {
          secondaryAudio = createAudioElement();
        }

        applyVolumeLevels(false);
        resetAutoCrossfadeState();
        startPlaybackCountdown();
        // Atualiza Media Session para sincronizar com o novo elemento de áudio
        updateMediaSession();
        // Agenda watchdog para a nova faixa após crossfade
        resetTrackEndFallback();
        scheduleTrackEndWatchdog();
        resolve(true);
      };

      crossfadeTimer = setTimeout(step, CROSSFADE_STEP_MS);
    });
  }

  function findNextPlayableForCrossfade() {
    const tracks = hasLibraryPlaybackQueue() ? state.playingTracks : state.tracks;
    const currentIndex = hasLibraryPlaybackQueue() ? state.playingTrackIndex : state.currentTrackIndex;
    for (let i = currentIndex + 1; i < tracks.length; i++) {
      if (!tracks[i].unavailable) return i;
    }
    if (repeatEnabled && tracks.length > 0) return 0;
    return -1;
  }

  function maybeTriggerAutoCrossfade() {
    if (crossfadeInProgress || crossfadePending) return;
    if (state.isLoadingTrack) return;
    if (advancingToNext || advanceScheduled) return;
    if (!state.isPlaying || audio.paused || audio.ended) return;
    if (!hasValidTrack()) return;

    const { track, index } = getCurrentPlayingTrack();
    const trackDurationMs = getTrackDurationMs(track);
    const audioDurationMs = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : null;

    // Preferir duração real do áudio se disponível e mais confiável
    const durationMs = Number.isFinite(audioDurationMs) ? audioDurationMs : trackDurationMs;
    if (!Number.isFinite(durationMs) || durationMs < MIN_CROSSFADE_TRACK_MS) return;

    const remainingMs = (durationMs - (audio.currentTime * 1000));
    const thresholdMs = Math.max(1500, CROSSFADE_DURATION_MS - 400);

    const key = `${state.playingPlaylistId || 'library'}-${index}-${durationMs}`;
    if (autoCrossfadeTriggeredKey === key) return;

    if (remainingMs <= thresholdMs) {
      const nextIndex = findNextPlayableForCrossfade();
      if (nextIndex !== -1) {
        autoCrossfadeTriggeredKey = key;
        const fromPlaying = hasLibraryPlaybackQueue();
        playTrackInternal(nextIndex, { fromPlayingTracks: fromPlaying, useCrossfade: true });
      }
    }
  }

  function resetAudioElement(element) {
    if (!element) return;
    try { element.pause(); } catch (_) { }
    try { element.removeAttribute('src'); } catch (_) { }
    try { element.load(); } catch (_) { }
  }

  // Função para resetar o elemento audio de forma segura
  function safeResetAudio(target = audio) {
    if (!target) return;
    ignoringErrorsSet.add(target);
    if (target === audio) {
      state.currentAttemptUrl = '';
    }
    try {
      target.pause();
      target.removeAttribute('src');
      target.load();
    } catch (_) { }
    // Restaura após um pequeno delay (captura ref para WeakSet)
    const ref = target;
    setTimeout(() => { ignoringErrorsSet.delete(ref); }, 100);
  }

  // Helper para resetar áudio e aguardar delay
  async function resetAudioWithDelay(target = audio) {
    safeResetAudio(target);
    await delay(AUDIO_RESET_DELAY_MS);
  }

  // Função para definir a URL do áudio e rastrear para marcação de falhas
  function setAudioSource(url, target = audio) {
    if (target === audio) {
      state.currentAttemptUrl = url || '';
    }
    target.src = url;
  }

  // Helper para definir URL e carregar áudio
  function loadAudioSource(url, target = audio) {
    setAudioSource(url, target);
    target.load();
  }

  // Event listeners para garantir reprodução estável
  const audioHandlers = {
    ended: () => {
      if (crossfadeInProgress || state.isLoadingTrack || advancingToNext || advanceScheduled) {
        // Já avançamos via crossfade; não dispare novo avanço
        return;
      }
      // Se a faixa terminou com pending stale, limpa e segue com avanço normal
      if (crossfadePending) {
        crossfadePending = false;
      }
      if (handlingEnded) return;
      handlingEnded = true;

      resetTrackEndFallback();
      stopPlaying();

      // Limpa timers de stalled/buffering para evitar reconexão desnecessária
      clearBufferingTimer();
      if (state.stalledTimer) {
        clearTimeout(state.stalledTimer);
        state.stalledTimer = null;
      }

      // Se estava tocando do YouTube, toca a próxima da busca
      if (isPlayingFromYouTube()) {
        stopYouTubeSearchCountdown();
        playNextYouTubeSearchResult();
        return;
      }

      const { track, index } = getCurrentPlayingTrack();
      const hasTrack = !!track && index >= 0;

      if (isLibraryPlaybackVisible() && hasTrack) {
        setTrackLoading(index, false); // Esconde spinner quando termina
        stopPlaybackCountdown({ resetLabel: true, index });
      } else {
        stopPlaybackCountdown({ resetLabel: false });
      }

      if (hasTrack) {
        const fromPlaying = hasLibraryPlaybackQueue();
        if (fromPlaying) {
          playNextFromPlaying(index + 1);
        } else {
          playNextFrom(index + 1);
        }
      }

      // Libera flag após fila atual
      queueMicrotask(() => { handlingEnded = false; });
    },
    error: (e) => {
      // Ignora erros durante reset do elemento
      if (ignoringErrorsSet.has(audio)) {
        return;
      }
      if (isPlayingFromYouTube()) {
        console.warn(`⚠️ [AUDIO] Error during YouTube playback, skipping to next result`);
        stopYouTubeSearchCountdown();
        playNextYouTubeSearchResult();
        return;
      }
      if (!hasValidTrack()) {
        // Ignora erros causados por limpar o src antes de importar faixas
        return;
      }
      const errorCode = audio.error?.code;
      const label = errorCode ? ` (code ${errorCode})` : '';
      console.error(`❌ [AUDIO] Error event${label}:`, e);
      handleAudioError(e);
    },
    play: () => {
      // No modo Vídeo o MP3 é manipulado internamente; ignore os efeitos de UI.
      if (videoMode.isVideo()) return;
      handlePlaybackStarted();
    },
    pause: () => {
      // No modo Vídeo o MP3 é pausado internamente; não altere estado/UI.
      if (videoMode.isVideo()) return;
      state.isPlaying = false;
      updateUiState();
      stopPlaybackCountdown({ resetLabel: false });
      // Atualiza visual do YouTube
      if (isPlayingFromYouTube()) {
        updateYouTubeSearchHighlight();
        stopYouTubeSearchCountdown();
      }
    },
    stalled: () => {
      if (!hasValidTrack()) return;
      if (state.connectionLost || state.reconnectAttempts > 0) return;
      if (state.stalledTimer) return; // Já tem um timer pendente
      if (state.isLoadingTrack) return; // Ainda está carregando, não interferir
      // Só considera stalled se já estava tocando (currentTime > 0)
      // Durante carregamento inicial, stalled é normal e não deve disparar reconexão
      if (audio.currentTime === 0) return;

      // Aguarda antes de considerar como problema real
      state.stalledTimer = setTimeout(() => {
        state.stalledTimer = null;
        // Verifica se ainda está travado (não recebeu dados) E não está pausado pelo usuário
        // readyState < 3 = HAVE_FUTURE_DATA, significa que não tem dados suficientes
        // Também verifica se já estava tocando (currentTime > 0) para evitar falsos positivos
        if (audio.readyState < 3 && !audio.paused && !audio.ended && hasValidTrack() && !state.isLoadingTrack && audio.currentTime > 0) {
          console.warn(`⏸️ [AUDIO] Stalled persistente - conexão fraca detectada`);
          setTrackLoading(state.currentTrackIndex, true);
          handleSlowConnection();
        }
      }, STALLED_DELAY_MS);
    },
    waiting: () => {
      if (!hasValidTrack()) return;
      if (state.connectionLost || state.reconnectAttempts > 0) return;
      if (state.isBuffering) return; // Já está tratando
      if (state.isLoadingTrack) return; // Ainda está carregando, não interferir

      // Só loga se já estava tocando (buffering real, não carregamento inicial)
      if (audio.currentTime > 0) {
        console.warn(`⏳ [AUDIO] Buffering...`);
      }
      state.isBuffering = true;
      state.bufferingStartTime = Date.now();

      // Só mostra spinner se já estava tocando (não durante carregamento inicial)
      if (audio.currentTime > 0) {
        setTrackLoading(state.currentTrackIndex, true);
      }

      // Timer para detectar buffering muito longo (conexão fraca)
      state.bufferingTimer = setTimeout(() => {
        if (state.isBuffering && state.currentTrackIndex >= 0 && !state.isLoadingTrack) {
          console.warn(`🐢 [AUDIO] Buffering demorado (>${BUFFERING_TIMEOUT_MS}ms) - tentando reconectar`);
          handleSlowConnection();
        }
      }, BUFFERING_TIMEOUT_MS);
    },
    playing: () => {
      if (state.isBuffering) {
        const bufferingDuration = Date.now() - state.bufferingStartTime;
        if (bufferingDuration > SLOW_CONNECTION_THRESHOLD_MS) {
          console.warn(`🐢 [AUDIO] Conexão lenta - buffering levou ${(bufferingDuration / 1000).toFixed(1)}s`);
        }
        clearBufferingTimer();
        setTrackLoading(state.currentTrackIndex, false); // Esconde spinner após buffering
      }
      // Limpa estado de reconexão se estava tentando
      if (state.reconnectAttempts > 0) {
        resetReconnectState();
      }
    },
    canplaythrough: () => {
      clearBufferingTimer();
    },
    durationchange: () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
      const track = state.tracks[state.currentTrackIndex];
      if (!track) return;
      
      const durationMs = Math.floor(audio.duration * 1000);
      if (!track.duration_ms || Math.abs(track.duration_ms - durationMs) > 1000) {
        track.duration_ms = durationMs;
        track.durationMs = durationMs;
        setTrackDurationLabel(state.currentTrackIndex, durationMs);
        // Força remoção dos handlers de seek quando a duração muda
        forceRemoveSeekHandlers();
      }
      // Re-agenda watchdog com a duração real agora disponível
      if (state.isPlaying && !audio.paused && !crossfadeInProgress) {
        scheduleTrackEndWatchdog();
      }
    },
    timeupdate: () => {
      maybeTriggerAutoCrossfade();
      maybeForceTrackEnd();
      updateLyricHighlight();
    }
  };

  function attachCoreAudioListeners(target) {
    if (!target) return;
    target.addEventListener('ended', audioHandlers.ended);
    target.addEventListener('error', audioHandlers.error);
    target.addEventListener('play', audioHandlers.play);
    target.addEventListener('pause', audioHandlers.pause);
    target.addEventListener('stalled', audioHandlers.stalled);
    target.addEventListener('waiting', audioHandlers.waiting);
    target.addEventListener('playing', audioHandlers.playing);
    target.addEventListener('canplaythrough', audioHandlers.canplaythrough);
    target.addEventListener('durationchange', audioHandlers.durationchange);
    target.addEventListener('timeupdate', audioHandlers.timeupdate);
  }

  function detachCoreAudioListeners(target) {
    if (!target) return;
    target.removeEventListener('ended', audioHandlers.ended);
    target.removeEventListener('error', audioHandlers.error);
    target.removeEventListener('play', audioHandlers.play);
    target.removeEventListener('pause', audioHandlers.pause);
    target.removeEventListener('stalled', audioHandlers.stalled);
    target.removeEventListener('waiting', audioHandlers.waiting);
    target.removeEventListener('playing', audioHandlers.playing);
    target.removeEventListener('canplaythrough', audioHandlers.canplaythrough);
    target.removeEventListener('durationchange', audioHandlers.durationchange);
    target.removeEventListener('timeupdate', audioHandlers.timeupdate);
  }

  attachCoreAudioListeners(audio);

  // Estado para controle de reconexão e buffering
  state.connectionLost = false;
  state.savedPlaybackTime = 0;
  state.reconnectAttempts = 0;
  state.reconnectTimer = null;
  state.bufferingTimer = null;
  state.isBuffering = false;
  state.bufferingStartTime = 0;
  state.stalledTimer = null;
  const MAX_RECONNECT_ATTEMPTS = 5;
  const RECONNECT_INTERVAL_MS = 2000; // 2s base com backoff progressivo
  const BUFFERING_TIMEOUT_MS = 15000; // Reduzido de 30000ms
  const SLOW_CONNECTION_THRESHOLD_MS = 10000; // Aumentado para 10s - evita avisos frequentes
  const STALLED_DELAY_MS = 12000; // Aumentado para 12s - evita falsos positivos durante carregamento inicial

  // Limpa timers de buffering e stalled
  function clearBufferingTimer() {
    if (state.bufferingTimer) {
      clearTimeout(state.bufferingTimer);
      state.bufferingTimer = null;
    }
    if (state.stalledTimer) {
      clearTimeout(state.stalledTimer);
      state.stalledTimer = null;
    }
    state.isBuffering = false;
  }

  // Helper para resetar estado de reconexão
  function resetReconnectState() {
    state.reconnectAttempts = 0;
    state.savedPlaybackTime = 0;
  }

  // Trata conexão fraca - salva posição e tenta reconectar
  // ===== Helpers de fonte 4shared =====
  // Uma URL de stream do 4shared passa pelo proxy /fourshared (Range em chunks).
  function isFoursharedUrl(url) {
    return typeof url === 'string' && url.includes('/fourshared');
  }
  // A reprodução atual está usando o stream do 4shared?
  function isFoursharedActive() {
    return isFoursharedUrl(state.currentAttemptUrl) ||
      isFoursharedUrl(audio.currentSrc) ||
      isFoursharedUrl(audio.src);
  }

  function handleSlowConnection() {
    if (state.reconnectAttempts > 0) return; // Já está tentando
    if (state.audioRecoveryInProgress) return; // Não interfere com recovery em andamento

    // O 4shared serve o áudio via proxy em chunks (Range de 2MB), o que é lento
    // para bufferizar. A rotina de reconexão (que pausa e re-resolve via /audio)
    // atrapalha e interrompe o play(), gerando loops. Para 4shared, deixamos o
    // elemento <audio> bufferizar naturalmente, sem reconectar.
    if (isFoursharedActive()) {
      clearBufferingTimer();
      state.isBuffering = false;
      return;
    }

    state.savedPlaybackTime = audio.currentTime || 0;
    clearBufferingTimer();

    // Tenta recarregar o áudio na mesma posição
    attemptReconnect();
  }

  // Detecta perda total de conexão do navegador
  window.addEventListener('offline', () => {
    if (!hasValidTrack()) return;
    console.warn(`📡 [NETWORK] Conexão perdida`);
    state.connectionLost = true;
    state.savedPlaybackTime = audio.currentTime || 0;
    clearBufferingTimer();
    setTrackLoading(state.currentTrackIndex, true); // Mostra spinner quando offline
    try {
      audio.pause();
    } catch (_) { }
    updateUiState();
  });

  // Detecta quando a conexão volta
  window.addEventListener('online', () => {
    if (state.connectionLost && state.currentTrackIndex >= 0) {
      state.connectionLost = false;
      attemptReconnect();
    }
  });

  // Função para tentar reconectar e retomar reprodução
  async function attemptReconnect() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    const trackIndex = state.currentTrackIndex;
    if (trackIndex < 0 || !state.tracks[trackIndex]) return;

    const track = state.tracks[trackIndex];

    // Se offline, aguarda conexão voltar
    if (!navigator.onLine) {
      console.warn(`📡 [RECONNECT] Aguardando conexão...`);
      state.connectionLost = true;
      return;
    }

    // Se já está tocando normalmente, não precisa reconectar
    if (!audio.paused && audio.readyState >= 3) {
      resetReconnectState();
      clearBufferingTimer();
      return;
    }

    // Se a track terminou, não tenta reconectar - vai para próxima
    if (audio.ended) {
      resetReconnectState();
      clearBufferingTimer();
      playNextFrom(trackIndex + 1);
      return;
    }

    state.reconnectAttempts++;
    setTrackLoading(trackIndex, true);
    let attemptedUrl = '';
    try {
      // Pausa antes de tentar nova URL
      try { audio.pause(); } catch (_) { }
      await delay(AUDIO_RESET_DELAY_MS);

      // Busca uma nova URL (sempre força refresh para evitar URLs expiradas)
      const forceRefresh = true;
      const resolved = await resolveTrackWithCache(track, trackIndex, { forceRefresh, preserveFailures: true });

      if (!resolved?.audioUrl) {
        throw new Error('Não foi possível obter URL de áudio');
      }

      attemptedUrl = resolved.audioUrl;
      setAudioSource(resolved.audioUrl);

      // Aguarda o áudio estar pronto antes de tentar tocar (reduzido para 8s)
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout aguardando canplay')), 15000);
        const onCanPlay = () => {
          clearTimeout(timeout);
          audio.removeEventListener('canplay', onCanPlay);
          audio.removeEventListener('canplaythrough', onCanPlayThrough);
          audio.removeEventListener('error', onError);
          resolve();
        };
        const onCanPlayThrough = onCanPlay;
        const onError = () => {
          clearTimeout(timeout);
          audio.removeEventListener('canplay', onCanPlay);
          audio.removeEventListener('canplaythrough', onCanPlayThrough);
          audio.removeEventListener('error', onError);
          reject(new Error('Erro ao carregar áudio'));
        };
        audio.addEventListener('canplay', onCanPlay, { once: true });
        audio.addEventListener('canplaythrough', onCanPlayThrough, { once: true });
        audio.addEventListener('error', onError, { once: true });

        // Inicia o carregamento
        audio.load();
      });

      // Restaura posição de reprodução se possível
      if (state.savedPlaybackTime > 0 && isFinite(state.savedPlaybackTime)) {
        try {
          audio.currentTime = Math.max(0, state.savedPlaybackTime - 1); // Volta 1s para garantir
        } catch (_) { }
      }

      await audio.play();
      resetReconnectState();
      clearBufferingTimer();
      updateUiState();
      return;
    } catch (error) {
      console.warn(`⚠️ [RECONNECT] Falha na tentativa ${state.reconnectAttempts}: ${error.message}`);
      // Limpa cache de áudio para forçar nova URL na próxima tentativa
      if (attemptedUrl) {
        const videoId = getTrackVideoId(track);
        if (videoId) state.audioCache.delete(videoId);
      }
    }

    // Se ainda não atingiu o máximo de tentativas, agenda próxima
    if (state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const reconnectDelay = RECONNECT_INTERVAL_MS * Math.min(state.reconnectAttempts, 3); // Backoff progressivo
      state.reconnectTimer = setTimeout(attemptReconnect, reconnectDelay);
    } else {
      console.warn(`❌ [RECONNECT] Máximo de tentativas atingido, pulando para próxima faixa`);
      resetReconnectState();
      clearBufferingTimer();
      setTrackLoading(trackIndex, false);
      // Pula para próxima faixa em vez de ficar parado
      skipUnavailableTrack(trackIndex);
    }
  }

  function updateUiState() {
    updateTrackHighlight();
    updateControlsBar();
    updateMediaSession();
  }

  // Media Session API - controles do sistema e informações da mídia
  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    
    const { track, index } = getCurrentPlayingTrack();
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }
    
    const title = getTrackTitle(track) || 'Faixa desconhecida';
    const artist = getTrackArtists(track) || track.author || 'Artista desconhecido';
    const album = track.album?.name || state.currentPlaylist?.name || '';
    
    // Obtém a capa da faixa ou da playlist
    const artwork = [];
    const coverUrl = track.thumbnail || 
                    track.album?.images?.[0]?.url || 
                    state.currentPlaylist?.cover || 
                    state.currentPlaylist?.images?.[0]?.url;
    
    if (coverUrl) {
      artwork.push({ src: coverUrl, sizes: '512x512', type: 'image/jpeg' });
    }
    
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album,
      artwork
    });
    
    // Atualiza o estado de reprodução
    navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';

    // Força remoção dos handlers de seek após atualizar metadata
    // Alguns navegadores podem resetar os handlers ao mudar metadata
    forceRemoveSeekHandlers();
  }

  function setupMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;
    
    navigator.mediaSession.setActionHandler('play', () => {
      if (audio.paused) {
        startPlaying();
        updateUiState();
        startPlaybackCountdown();
      }
    });
    
    navigator.mediaSession.setActionHandler('pause', () => {
      if (!audio.paused) {
        pausePlaying();
        updateUiState();
        stopPlaybackCountdown({ resetLabel: false });
      }
    });
    
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      playPreviousTrack();
    });

    navigator.mediaSession.setActionHandler('nexttrack', () => {
      playNextTrack();
    });
    
    // Remove handlers de seek para garantir que apenas prev/next apareçam
    forceRemoveSeekHandlers();
  }

  // Força a remoção dos handlers de seek
  function forceRemoveSeekHandlers() {
    if (!('mediaSession' in navigator)) return;
    
    try {
      navigator.mediaSession.setActionHandler('seekbackward', null);
      navigator.mediaSession.setActionHandler('seekforward', null);
      navigator.mediaSession.setActionHandler('seekto', null);
    } catch (e) {
      // Ignora erros se o navegador não suportar
    }
  }

  function resetPlaybackState(options = {}) {
    const {
      resetTrackIndex = true,
      clearTracks = false,
      clearCaches = false
    } = options;

    safeResetAudio();
    stopPlaying();
    state.audioRecoveryInProgress = false;
    
    // Reseta estado de reprodução
    state.playingPlaylistId = null;
    state.playingTrackIndex = -1;
    state.playingTracks = [];
    
    if (resetTrackIndex) {
      state.currentTrackIndex = -1;
    }
    if (clearTracks) {
      state.tracks = [];
    }
    if (clearCaches) {
      state.searchCache.clear();
      state.searchPromises.clear();
      state.audioCache.clear();
      state.audioErrorCounts.clear();
    }
    updateUiState();
  }

  function getTrackKey(track) {
    if (!track) return '';
    const baseName = getTrackTitle(track);
    const artistNames = getTrackArtists(track).replace(/, /g, ',');
    return track.id || track.isrc || `${baseName}-${artistNames}`;
  }

  let feedbackTimeout = null;

  function setFeedback(message, variant = 'info', playlistInfo = null) {
    if (!ui.feedback) return;
    
    // Limpa timeout anterior se existir
    if (feedbackTimeout) {
      clearTimeout(feedbackTimeout);
      feedbackTimeout = null;
    }
    
    // Ícones por variante
    const variantIcons = {
      success: 'ph-check-circle',
      error: 'ph-x-circle',
      info: 'ph-info',
      warning: 'ph-warning'
    };
    
    // Mostra informações se fornecidas (playlist ou track)
    if (playlistInfo && playlistInfo.name) {
      if (ui.feedbackTitle) {
        ui.feedbackTitle.textContent = playlistInfo.name;
        ui.feedbackTitle.classList.remove('hidden');
      }
      if (ui.feedbackCover && playlistInfo.cover) {
        ui.feedbackCover.src = playlistInfo.cover;
        ui.feedbackCover.alt = playlistInfo.name;
        ui.feedbackCover.classList.remove('hidden');
      } else if (ui.feedbackCover) {
        ui.feedbackCover.classList.add('hidden');
      }
      if (ui.feedbackIcon) ui.feedbackIcon.classList.add('hidden');
      
      // Texto: mensagem principal + subtitle/trackCount
      if (ui.feedbackText) {
        let text = message || '';
        if (playlistInfo.subtitle) {
          text = text ? `${text} • ${playlistInfo.subtitle}` : playlistInfo.subtitle;
        } else if (playlistInfo.trackCount !== undefined) {
          const trackText = `${playlistInfo.trackCount} ${playlistInfo.trackCount === 1 ? 'faixa' : 'faixas'}`;
          text = text ? `${text} • ${trackText}` : trackText;
        }
        ui.feedbackText.textContent = text;
      }
    } else {
      // Mostra ícone ao invés da capa
      if (ui.feedbackCover) ui.feedbackCover.classList.add('hidden');
      if (ui.feedbackTitle) ui.feedbackTitle.classList.add('hidden');
      if (ui.feedbackText) ui.feedbackText.textContent = message || '';
      if (ui.feedbackIcon && message) {
        const iconClass = variantIcons[variant] || variantIcons.info;
        ui.feedbackIcon.innerHTML = `<i class="ph-bold ${iconClass} text-xl"></i>`;
        ui.feedbackIcon.className = 'w-11 h-11 rounded-xl flex items-center justify-center';
        ui.feedbackIcon.classList.add(variant);
        ui.feedbackIcon.classList.remove('hidden');
      } else if (ui.feedbackIcon) {
        ui.feedbackIcon.classList.add('hidden');
      }
    }
    
    if (message || playlistInfo) {
      ui.feedback.classList.add('visible');
      ui.feedback.classList.remove('opacity-0', 'invisible');
      
      // Auto-fecha após 4 segundos
      feedbackTimeout = setTimeout(() => {
        closeFeedback();
      }, 4000);
    } else {
      hideVisibleElement(ui.feedback);
    }
  }

  function closeFeedback() {
    if (!ui.feedback) return;
    
    // Limpa o timeout se existir
    if (feedbackTimeout) {
      clearTimeout(feedbackTimeout);
      feedbackTimeout = null;
    }
    
    hideVisibleElement(ui.feedback);
  }

  function showSettingsOverlay() {
    if (!ui.playerSettingsOverlay) return;
    ui.playerSettingsOverlay.style.display = '';
    void ui.playerSettingsOverlay.offsetWidth;
    ui.playerSettingsOverlay.classList.remove('pointer-events-none');
    ui.playerSettingsOverlay.classList.add('pointer-events-auto');
    ui.playerSettingsOverlay.style.opacity = '1';
  }

  function hideSettingsOverlay() {
    if (!ui.playerSettingsOverlay) return;
    ui.playerSettingsOverlay.style.opacity = '0';
    ui.playerSettingsOverlay.classList.add('pointer-events-none');
    ui.playerSettingsOverlay.classList.remove('pointer-events-auto');
    setTimeout(() => {
      if (ui.playerSettingsOverlay.style.opacity === '0') {
        ui.playerSettingsOverlay.style.display = 'none';
      }
    }, 260);
  }

  function positionSettingsDropdown() {
    if (!ui.playerSettingsBtn || !ui.playerSettingsDropdown) return;
    const rect = ui.playerSettingsBtn.getBoundingClientRect();
    ui.playerSettingsDropdown.style.top = `${rect.bottom + 8}px`;
    ui.playerSettingsDropdown.style.left = `${rect.left}px`;
  }

  function toggleSettingsDropdown() {
    if (!ui.playerSettingsDropdown) return;
    const isOpen = !ui.playerSettingsDropdown.classList.contains('hidden');
    if (isOpen) {
      closeSettingsDropdown();
    } else {
      positionSettingsDropdown();
      ui.playerSettingsDropdown.classList.remove('hidden');
      showSettingsOverlay();
      requestAnimationFrame(() => ui.playerSettingsDropdown.classList.remove('opacity-0', 'scale-95'));
    }
  }

  function closeSettingsDropdown() {
    if (!ui.playerSettingsDropdown) return;
    ui.playerSettingsDropdown.classList.add('opacity-0', 'scale-95');
    hideSettingsOverlay();
    setTimeout(() => ui.playerSettingsDropdown.classList.add('hidden'), 200);
  }

  function openImportInfoModal() {
    if (!ui.importInfoModal) return;
    
    ui.importInfoModal.classList.remove('opacity-0', 'invisible');
    ui.importInfoModal.classList.add('opacity-100', 'visible');
    ui.importInfoModal.style.pointerEvents = 'auto';
    
    const card = ui.importInfoModal.querySelector('div[class*="scale-95"]');
    if (card) {
      setTimeout(() => {
        card.style.transform = 'scale(1)';
      }, 10);
    }
  }

  function closeImportInfoModal() {
    if (!ui.importInfoModal) return;
    
    const card = ui.importInfoModal.querySelector('div[class*="scale-95"]');
    if (card) {
      card.style.transform = 'scale(0.95)';
    }
    
    setTimeout(() => {
      ui.importInfoModal.classList.add('opacity-0', 'invisible');
      ui.importInfoModal.classList.remove('opacity-100', 'visible');
      ui.importInfoModal.style.pointerEvents = 'none';
    }, 150);
  }

  function waitForNextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  // Helper para aguardar um frame (layout)
  function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve));
  }

  function bindUi() {
    ui.fileInput?.addEventListener('change', handleFileSelection);


    // Settings dropdown
    ui.playerSettingsBtn?.addEventListener('click', toggleSettingsDropdown);
    ui.settingsImportCsvBtn?.addEventListener('click', () => {
      closeSettingsDropdown();
      openFilePicker();
    });
    ui.settingsImportInfoBtn?.addEventListener('click', () => {
      closeSettingsDropdown();
      openImportInfoModal();
    });
    ui.playerSettingsOverlay?.addEventListener('click', closeSettingsDropdown);

    // Modal de informações sobre importação
    ui.closeImportInfoBtn?.addEventListener('click', closeImportInfoModal);
    ui.importInfoModal?.addEventListener('click', (e) => {
      if (e.target === ui.importInfoModal) closeImportInfoModal();
    });
    


    // Tabs do player
    ui.tabDiscover?.addEventListener('click', () => switchPlayerTab('discover'));
    ui.tabPlaylist?.addEventListener('click', () => switchPlayerTab('playlist'));
    ui.tabYoutube?.addEventListener('click', () => switchPlayerTab('youtube'));
    ui.tabRadio?.addEventListener('click', () => switchPlayerTab('radio'));

    // Botão de reordenar playlists (modo de edição com drag-and-drop e exclusão)
    ui.reorderPlaylistsBtn?.addEventListener('click', togglePlaylistsReorderMode);

    // Swipe lateral para trocar abas
    setupTabSwipeGesture();

    // Botão de busca do YouTube (abre a barra de busca)
    ui.youtubeSearchTrigger?.addEventListener('click', openYoutubeSearchBar);
    ui.youtubeSearchCancel?.addEventListener('click', closeYoutubeSearchBar);
    ui.youtubeSearchOverlay?.addEventListener('click', closeYoutubeSearchBar);

    // Toggle de tipo de busca (faixas/playlists)
    ui.searchTypeTracks?.addEventListener('click', () => setSearchType('tracks'));
    ui.searchTypePlaylists?.addEventListener('click', () => setSearchType('playlists'));

    // Scroll do YouTube com efeito progressivo no header + infinite scroll
    ui.youtubeSearchContent?.addEventListener('scroll', handleYoutubeScroll, { passive: true });

    // Busca manual
    ui.manualSearchInput?.addEventListener('input', (e) => {
      const hasText = e.target.value.trim().length > 0;
      if (ui.manualSearchBtn) ui.manualSearchBtn.disabled = !hasText;
    });
    // Seleciona todo o texto ao focar/clicar quando o campo já contém um valor,
    // permitindo substituir ou apagar com um único toque (mantém o padrão se estiver vazio).
    const selectManualSearchIfFilled = (input) => {
      if (!input || !input.value.length) return;
      input.select();
    };
    ui.manualSearchInput?.addEventListener('focus', (e) => {
      // rAF garante que a seleção persista após o tratamento padrão de foco (ex.: Safari)
      requestAnimationFrame(() => selectManualSearchIfFilled(e.target));
    });
    ui.manualSearchInput?.addEventListener('click', (e) => {
      selectManualSearchIfFilled(e.target);
    });
    ui.manualSearchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !ui.manualSearchBtn?.disabled) {
        performManualSearch();
      }
      if (e.key === 'Escape') {
        closeYoutubeSearchBar();
      }
    });
    ui.manualSearchBtn?.addEventListener('click', performManualSearch);

    // Playlist picker modal
    ui.closePlaylistPickerBtn?.addEventListener('click', closePlaylistPicker);
    ui.playlistPickerModal?.addEventListener('click', (e) => {
      if (e.target === ui.playlistPickerModal) closePlaylistPicker();
    });
    ui.showNewPlaylistBtn?.addEventListener('click', showNewPlaylistForm);
    ui.cancelNewPlaylistBtn?.addEventListener('click', hideNewPlaylistForm);
    ui.confirmNewPlaylistBtn?.addEventListener('click', createNewPlaylistAndAdd);
    ui.newPlaylistName?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createNewPlaylistAndAdd();
      if (e.key === 'Escape') hideNewPlaylistForm();
    });

    // Player Controls Bar
    bindPlayerControlsBar();
  }

  // === Player Controls Bar ===
  function bindPlayerControlsBar() {
    ui.ctrlPlay?.addEventListener('click', togglePlayback);
    ui.ctrlPrev?.addEventListener('click', playPreviousTrack);
    ui.ctrlNext?.addEventListener('click', playNextTrack);
    ui.ctrlShuffle?.addEventListener('click', toggleShuffle);
    ui.ctrlRepeat?.addEventListener('click', toggleRepeat);
    ui.ctrlVolumeBtn?.addEventListener('click', toggleMute);
    // Fallback: listener no container volume-control para mobile
    document.querySelector('#player-controls-bar .volume-control')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMute();
    });



    // Clique no controls-left mostra/esconde a capa flutuante
    const ctrlBar = document.getElementById('player-controls-bar');
    const ctrlLeft = ctrlBar?.querySelector('.controls-left');
    if (ctrlLeft) {
      ctrlLeft.style.cursor = 'pointer';
      ctrlLeft.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        toggleExpandedCover();
      });
    }

    // Clique na capa expandida fecha (exceto no alternador Capa/Vídeo e na
    // área de letras, que tem interação própria de ajuste de sincronia)
    ui.expandedCoverWrapper?.addEventListener('click', (e) => {
      if (e.target.closest('#cover-mode-toggle')) return;
      if (e.target.closest('#cover-share-btn')) return;
      if (e.target.closest('#expanded-lyrics')) return;
      toggleExpandedCover(false);
    });

    // Inicializa o modo Vídeo (alternador Capa/Vídeo e hooks de visibilidade)
    videoMode.init();

    // Botão Compartilhar (não deve fechar a capa expandida ao clicar)
    ui.coverShareBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      shareCurrentTrack();
    });

    // Inicializa o ajuste manual de sincronia da letra (rolar a lista)
    initLyricsSyncScroll();

    // Mantém a capa expandida adaptada à altura da viewport (responsivo).
    updateExpandedCoverSpace();
    window.addEventListener('resize', updateExpandedCoverSpace);
    window.addEventListener('orientationchange', updateExpandedCoverSpace);
    window.visualViewport?.addEventListener('resize', updateExpandedCoverSpace);

    // Clique no blur de fundo fecha a capa
    document.getElementById('expanded-cover-blur')?.addEventListener('click', () => {
      toggleExpandedCover(false);
    });

    // Inicializa ícones de volume
    updateMuteIcons();
  }

  // Toggle da capa flutuante
  function toggleExpandedCover(forceState) {
    if (!ui.expandedCoverWrapper) return;
    const show = forceState !== undefined ? forceState : !ui.expandedCoverWrapper.classList.contains('visible');
    if (show) { syncExpandedCover(); updateExpandedCoverSpace(); }
    ui.expandedCoverWrapper.classList.toggle('visible', show);
    const coverBlur = document.getElementById('expanded-cover-blur');
    if (coverBlur) {
      coverBlur.classList.toggle('opacity-0', !show);
      coverBlur.classList.toggle('invisible', !show);
      coverBlur.style.pointerEvents = show ? 'auto' : 'none';
    }
    // Integração com o modo Vídeo (clipe oficial).
    if (show) {
      videoMode.onExpandedCoverOpen();
    } else {
      videoMode.onExpandedCoverClose();
    }
  }

  function syncExpandedCover() {
    const coverImg = ui.ctrlCover?.querySelector('img');
    if (coverImg && ui.ctrlExpandedCover) {
      ui.ctrlExpandedCover.src = coverImg.src;
    }
  }

  // Copia um texto para a área de transferência (com fallback legado).
  async function copyTextToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  // Compartilha a faixa atual via Web Share API; se indisponível, copia o texto
  // para a área de transferência e avisa o usuário.
  async function shareCurrentTrack() {
    const { track } = getCurrentPlayingTrack();
    let title = (radioPlaying && radioCurrentChannel)
      ? radioCurrentChannel.name
      : getTrackTitle(track);
    title = (title || 'esta música').trim();
    const shareText = `🎧 Estou ouvindo ${title} no HyperMusic! 🎵 Acesse e ouça também!`;

    if (navigator.share) {
      try {
        await navigator.share({ text: shareText });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // usuário cancelou
        // outros erros: cai no fallback de copiar
      }
    }

    const copied = await copyTextToClipboard(shareText);
    if (copied) {
      setFeedback('Texto copiado! Cole em qualquer rede social. 📋', 'success');
    } else {
      setFeedback('Não foi possível compartilhar agora.', 'error');
    }
  }

  // Calcula dinamicamente a altura disponível para a capa expandida: do topo
  // seguro da tela até logo acima do player inferior (que permanece fixo).
  // Publica em --ec-avail; o layout flex distribui esse espaço e a capa
  // encolhe proporcionalmente para caber sem cortes nem sobreposição.
  function updateExpandedCoverSpace() {
    const bar = document.getElementById('player-controls-bar');
    if (!bar) return;
    const barTop = bar.getBoundingClientRect().top;
    const topInset = 20;   // margem do topo (evita notch/status bar)
    const bottomGap = 24;  // casa com o "bottom: calc(100% + 24px)" do CSS
    const avail = barTop - topInset - bottomGap;
    const clamped = Math.max(160, Math.min(avail, 760));
    document.documentElement.style.setProperty('--ec-avail', clamped + 'px');

    // Reposiciona a linha atual da letra após a mudança de tamanho.
    if (typeof lyricsState !== 'undefined' && !lyricsState.adjusting && lyricsState.lineEls?.length) {
      const idx = Math.max(0, lyricsState.currentIndex);
      requestAnimationFrame(() => scrollLyricLineToCenter(idx, false));
    }
  }

  // ====== Letras sincronizadas ======
  // Busca letras com timestamps (formato LRC) no LRCLIB (grátis, CORS aberto)
  // e as exibe entre o alternador Áudio/Vídeo e a capa. A área só aparece
  // quando há letra sincronizada disponível para a faixa atual.
  const lyricsState = {
    key: null,        // identificador da faixa cuja letra está carregada
    lines: [],        // [{ time: <segundos>, text }]
    lineEls: [],      // elementos DOM de cada linha (na lista rolável)
    currentIndex: -1, // índice da linha destacada
    loadToken: 0,     // invalida requisições antigas em trocas rápidas de faixa
    requestedKey: null,
    offset: 0,        // ajuste manual de sincronia em segundos (+ atrasa a letra)
    adjusting: false  // usuário rolando a letra para escolher o ponto de sincronia
  };

  // Offsets de sincronia salvos por faixa (persistidos no localStorage).
  const LYRIC_OFFSETS_STORAGE_KEY = 'hypermusic_lyric_offsets';
  const LYRIC_OFFSET_MAX = 30; // limite de ±30s para o ajuste manual

  function loadLyricOffsets() {
    try {
      return JSON.parse(localStorage.getItem(LYRIC_OFFSETS_STORAGE_KEY)) || {};
    } catch (_) { return {}; }
  }

  function getStoredLyricOffset(key) {
    if (!key) return 0;
    const val = loadLyricOffsets()[key];
    return Number.isFinite(val) ? val : 0;
  }

  function storeLyricOffset(key, offset) {
    if (!key || !canPersist()) return;
    try {
      const all = loadLyricOffsets();
      if (!offset) delete all[key]; // não guarda 0 (mantém o storage limpo)
      else all[key] = Math.round(offset * 100) / 100;
      localStorage.setItem(LYRIC_OFFSETS_STORAGE_KEY, JSON.stringify(all));
    } catch (_) { }
  }

  // Normaliza título/artista para melhorar o casamento na busca de letra.
  function cleanLyricsQueryText(str) {
    if (!str) return '';
    return String(str)
      .replace(/\([^)]*\)/g, ' ')            // (Official Video), (feat. ...)
      .replace(/\[[^\]]*\]/g, ' ')           // [Clipe Oficial]
      .replace(/\b(official|oficial|video|vídeo|clipe|audio|áudio|lyrics?|letra|hd|4k|remaster(ed)?|ao vivo|live)\b/gi, ' ')
      .replace(/\bfeat\.?\b.*$/i, ' ')       // remove "feat. X"
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Converte o texto LRC ("(mm:ss.xx) linha") em linhas ordenadas por tempo.
  function parseLrc(lrc) {
    if (!lrc || typeof lrc !== 'string') return [];
    const lines = [];
    const tagRe = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    for (const raw of lrc.split(/\r?\n/)) {
      tagRe.lastIndex = 0;
      let match;
      const stamps = [];
      let lastEnd = 0;
      while ((match = tagRe.exec(raw)) !== null) {
        const min = parseInt(match[1], 10) || 0;
        const sec = parseInt(match[2], 10) || 0;
        const fracRaw = match[3] || '0';
        const frac = parseInt(fracRaw, 10) / Math.pow(10, fracRaw.length);
        stamps.push(min * 60 + sec + frac);
        lastEnd = tagRe.lastIndex;
      }
      if (!stamps.length) continue;
      const text = raw.slice(lastEnd).trim();
      for (const time of stamps) lines.push({ time, text });
    }
    lines.sort((a, b) => a.time - b.time);
    return lines;
  }

  // Posição de reprodução atual em segundos (áudio ou vídeo).
  function getPlaybackPositionSec() {
    try {
      if (videoMode && videoMode.isVideo && videoMode.isVideo()) {
        return videoMode.getCurrentTime() || 0;
      }
    } catch (_) { }
    return audio.currentTime || 0;
  }

  // Define o estado visual da área de letras:
  //  'hidden' → oculta (sem faixa, rádio ou durante a busca)
  //  'lyrics' → exibe a letra sincronizada
  //  'empty'  → exibe o aviso "Letras não disponíveis"
  function setLyricsMode(mode) {
    const w = ui.expandedCoverWrapper;
    if (w) {
      w.classList.toggle('has-lyrics', mode === 'lyrics');
      w.classList.toggle('no-lyrics', mode === 'empty');
      w.classList.toggle('loading-lyrics', mode === 'loading');
    }
    if (ui.expandedLyrics) {
      ui.expandedLyrics.setAttribute('aria-hidden', mode === 'lyrics' ? 'false' : 'true');
    }
  }

  // Limpa as linhas de letra (mantém o modo à escolha do chamador).
  function clearLyricLines() {
    lyricsState.lines = [];
    lyricsState.lineEls = [];
    lyricsState.currentIndex = -1;
    lyricsState.adjusting = false;
    ui.expandedCoverWrapper?.classList.remove('lyrics-adjusting');
    if (ui.lyricsScroll) ui.lyricsScroll.innerHTML = '';
  }

  // Limpa e oculta totalmente a área.
  function clearLyrics() {
    clearLyricLines();
    setLyricsMode('hidden');
  }

  // Limpa as linhas e mostra o indicador de carregamento ("...").
  function showLyricsLoading() {
    clearLyricLines();
    setLyricsMode('loading');
  }

  // Limpa as linhas e mostra o aviso de indisponível.
  function showLyricsUnavailable() {
    clearLyricLines();
    setLyricsMode('empty');
  }

  // Monta a lista rolável com todas as linhas da letra.
  function renderAllLyricLines() {
    if (!ui.lyricsScroll) return;
    ui.lyricsScroll.innerHTML = '';
    lyricsState.lineEls = lyricsState.lines.map((line, i) => {
      const p = document.createElement('p');
      p.className = 'lyrics-line';
      p.textContent = line.text || '♪';
      p.dataset.index = String(i);
      ui.lyricsScroll.appendChild(p);
      return p;
    });
  }

  // Rola a lista para centralizar a linha indicada.
  let lyricsAutoScrolling = false;
  let lyricsAutoScrollTimer = null;
  function scrollLyricLineToCenter(index, smooth = true) {
    const el = lyricsState.lineEls[index];
    const container = ui.lyricsScroll;
    if (!el || !container) return;
    const target = el.offsetTop - (container.clientHeight / 2) + (el.offsetHeight / 2);
    lyricsAutoScrolling = true;
    if (lyricsAutoScrollTimer) clearTimeout(lyricsAutoScrollTimer);
    container.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
    // Libera o flag depois que a rolagem programática deve ter terminado.
    lyricsAutoScrollTimer = setTimeout(() => { lyricsAutoScrolling = false; }, smooth ? 600 : 60);
  }

  // Aplica a classe de destaque a uma única linha.
  function setActiveLyricLine(index, cls) {
    lyricsState.lineEls.forEach((el, i) => el.classList.toggle(cls, i === index));
  }

  // Atualiza a linha destacada conforme o tempo de reprodução.
  // O offset manual desloca a sincronia: offset > 0 atrasa a letra.
  function updateLyricHighlight() {
    const { lines } = lyricsState;
    if (!lines.length) return;
    // Enquanto o usuário ajusta manualmente, não mexe no scroll/destaque.
    if (lyricsState.adjusting) return;
    const pos = getPlaybackPositionSec() - (lyricsState.offset || 0);
    // Encontra a última linha cujo tempo já passou.
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= pos + 0.15) idx = i;
      else break;
    }
    if (idx === lyricsState.currentIndex) return;
    lyricsState.currentIndex = idx;
    const shown = idx < 0 ? 0 : idx; // antes da 1ª linha, mostra a primeira
    setActiveLyricLine(idx < 0 ? -1 : idx, 'is-current');
    scrollLyricLineToCenter(shown, true);
  }

  // Carrega letras da faixa atual (se ainda não carregadas).
  async function loadLyricsForCurrentTrack() {
    // Rádio não tem letra sincronizada.
    if (radioPlaying && radioCurrentChannel) { clearLyrics(); lyricsState.key = null; return; }

    const { track } = getCurrentPlayingTrack();
    const title = cleanLyricsQueryText(getTrackTitle(track));
    const artist = cleanLyricsQueryText(getTrackArtists(track));
    if (!title) { clearLyrics(); lyricsState.key = null; return; }

    const key = `${artist}::${title}`.toLowerCase();
    if (key === lyricsState.key || key === lyricsState.requestedKey) return; // já carregada / em andamento
    lyricsState.requestedKey = key;
    const token = ++lyricsState.loadToken;
    // Faixa nova: mostra "..." enquanto busca a letra da nova faixa.
    showLyricsLoading();

    try {
      const synced = await fetchSyncedLyrics(title, artist);
      if (token !== lyricsState.loadToken) return; // faixa mudou nesse meio tempo
      const lines = parseLrc(synced);
      lyricsState.key = key;
      lyricsState.requestedKey = null;
      if (!lines.length) { showLyricsUnavailable(); return; }
      lyricsState.lines = lines;
      lyricsState.adjusting = false;
      // Restaura o ajuste manual de sincronia salvo para esta faixa.
      lyricsState.offset = getStoredLyricOffset(key);
      renderAllLyricLines();
      setLyricsMode('lyrics');
      // Sentinela (-2) garante que a primeira chamada de sincronização sempre
      // renderize (mesmo quando a posição atual ainda está antes da 1ª linha).
      lyricsState.currentIndex = -2;
      // Posiciona a lista na linha atual sem animação (evita rolagem inicial).
      requestAnimationFrame(() => {
        if (token !== lyricsState.loadToken) return;
        const pos = getPlaybackPositionSec() - (lyricsState.offset || 0);
        let idx = 0;
        for (let i = 0; i < lines.length; i++) { if (lines[i].time <= pos + 0.15) idx = i; else break; }
        scrollLyricLineToCenter(idx, false);
        updateLyricHighlight();
      });
    } catch (_) {
      if (token !== lyricsState.loadToken) return;
      lyricsState.key = key;
      lyricsState.requestedKey = null;
      showLyricsUnavailable();
    }
  }

  // Consulta o LRCLIB por letra sincronizada (LRC). Retorna string LRC ou ''.
  async function fetchSyncedLyrics(title, artist) {
    const withTimeout = (url) => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      return fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } })
        .finally(() => clearTimeout(t));
    };

    const pickSynced = (list) => {
      if (!Array.isArray(list)) return '';
      const hit = list.find(item => item && item.syncedLyrics);
      return hit ? hit.syncedLyrics : '';
    };

    // 1) Busca estruturada (track_name + artist_name) — mais precisa.
    if (artist) {
      try {
        const url = `${base}/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`;
        const res = await withTimeout(url);
        if (res.ok) {
          const synced = pickSynced(await res.json());
          if (synced) return synced;
        }
      } catch (_) { }
    }

    // 2) Fallback: busca ampla por termo livre (título + artista).
    if (artist) {
      try {
        const url = `${base}/search?q=${encodeURIComponent(`${title} ${artist}`)}`;
        const res = await withTimeout(url);
        if (res.ok) {
          const synced = pickSynced(await res.json());
          if (synced) return synced;
        }
      } catch (_) { }
    }

    // 3) Último recurso: só o título. Ajuda quando o "artista" é, na verdade,
    // um canal do YouTube (ex.: "Racionais TV"), que atrapalha o casamento.
    try {
      const url = `${base}/search?q=${encodeURIComponent(title)}`;
      const res = await withTimeout(url);
      if (res.ok) {
        const synced = pickSynced(await res.json());
        if (synced) return synced;
      }
    } catch (_) { }

    return '';
  }

  // ====== Ajuste manual de sincronia (rolar a letra) ======
  // Alguns áudios têm introdução instrumental, deixando a letra adiantada.
  // O usuário rola a lista livremente e escolhe a linha que corresponde ao
  // momento atual (a linha no centro, ou tocando diretamente numa linha).
  // A partir desse ponto a reprodução volta a seguir sincronizada.
  let lyricsSyncIndicatorTimer = null;
  let lyricsSettleTimer = null;

  function showSyncIndicator(text, persist) {
    const el = ui.lyricsSyncIndicator;
    if (!el) return;
    el.textContent = text;
    el.classList.add('visible');
    if (lyricsSyncIndicatorTimer) clearTimeout(lyricsSyncIndicatorTimer);
    if (!persist) {
      lyricsSyncIndicatorTimer = setTimeout(() => el.classList.remove('visible'), 1400);
    }
  }

  function hideSyncIndicator() {
    if (lyricsSyncIndicatorTimer) clearTimeout(lyricsSyncIndicatorTimer);
    ui.lyricsSyncIndicator?.classList.remove('visible');
  }

  // Índice da linha mais próxima do centro da lista rolável.
  function getCenteredLyricIndex() {
    const container = ui.lyricsScroll;
    if (!container || !lyricsState.lineEls.length) return -1;
    const center = container.scrollTop + container.clientHeight / 2;
    let best = 0;
    let bestDist = Infinity;
    lyricsState.lineEls.forEach((el, i) => {
      const elCenter = el.offsetTop + el.offsetHeight / 2;
      const dist = Math.abs(elCenter - center);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    return best;
  }

  // Confirma o ponto de sincronia escolhido: alinha a linha ao tempo atual.
  function commitLyricSync(index) {
    const line = lyricsState.lines[index];
    if (!line) return;
    let offset = getPlaybackPositionSec() - line.time;
    offset = Math.max(-LYRIC_OFFSET_MAX, Math.min(LYRIC_OFFSET_MAX, offset));
    if (lyricsSettleTimer) { clearTimeout(lyricsSettleTimer); lyricsSettleTimer = null; }
    lyricsState.offset = offset;
    storeLyricOffset(lyricsState.key, offset);
    lyricsState.adjusting = false;
    ui.expandedCoverWrapper?.classList.remove('lyrics-adjusting');
    lyricsState.lineEls.forEach(el => el.classList.remove('is-candidate'));
    lyricsState.currentIndex = -2; // força re-render com o novo offset
    updateLyricHighlight();
    showSyncIndicator('Sincronizado', false);
  }

  function initLyricsSyncScroll() {
    const container = ui.lyricsScroll;
    if (!container) return;
    ui.lyricsSyncIndicator = ui.expandedLyrics?.querySelector('.lyrics-sync-indicator');

    let pointerDown = false;

    const enterAdjusting = () => {
      if (lyricsState.adjusting) return;
      lyricsState.adjusting = true;
      ui.expandedCoverWrapper?.classList.add('lyrics-adjusting');
      // Durante o ajuste, só a linha candidata (no centro) fica destacada.
      lyricsState.lineEls.forEach(el => el.classList.remove('is-current'));
      showSyncIndicator('Escolha a linha atual', true);
    };

    const markCandidate = () => {
      const idx = getCenteredLyricIndex();
      if (idx < 0) return;
      lyricsState.lineEls.forEach((el, i) => el.classList.toggle('is-candidate', i === idx));
    };

    // Rolagem do usuário → modo de ajuste; ao assentar, confirma o ponto.
    container.addEventListener('scroll', () => {
      if (lyricsAutoScrolling) return; // ignora rolagem programática
      enterAdjusting();
      markCandidate();
      if (lyricsSettleTimer) clearTimeout(lyricsSettleTimer);
      lyricsSettleTimer = setTimeout(() => {
        if (pointerDown) return; // ainda com o dedo na tela
        commitLyricSync(getCenteredLyricIndex());
      }, 450);
    }, { passive: true });

    // Impede que tocar/rolar na letra feche a capa expandida.
    container.addEventListener('pointerdown', (e) => {
      pointerDown = true;
      e.stopPropagation();
    });
    const onPointerUp = () => {
      pointerDown = false;
      // Se já parou de rolar, confirma logo após soltar.
      if (lyricsState.adjusting) {
        if (lyricsSettleTimer) clearTimeout(lyricsSettleTimer);
        lyricsSettleTimer = setTimeout(() => {
          if (!pointerDown) commitLyricSync(getCenteredLyricIndex());
        }, 250);
      }
    };
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerUp);

    // Tocar diretamente numa linha define aquele ponto como o momento atual.
    container.addEventListener('click', (e) => {
      e.stopPropagation();
      const lineEl = e.target.closest('.lyrics-line');
      if (!lineEl) return;
      const idx = Number(lineEl.dataset.index);
      if (Number.isInteger(idx)) commitLyricSync(idx);
    });
  }

  // Estado de shuffle e repeat
  let shuffleEnabled = false;
  let repeatEnabled = false;

  // Funções para controle da barra de busca do YouTube
  function openYoutubeSearchBar() {
    if (ui.youtubeSearchOverlay) {
      ui.youtubeSearchOverlay.style.backdropFilter = 'blur(8px)';
      ui.youtubeSearchOverlay.style.webkitBackdropFilter = 'blur(8px)';
      showElementWithFade(ui.youtubeSearchOverlay);
      ui.youtubeSearchOverlay.classList.add('visible');
    }
    
    showElementWithFade(ui.youtubeSearchBarWrapper);
    ui.youtubeSearchBtnContainer?.classList.add('hidden-for-search');
    
    // Foca no input e abre o teclado
    setTimeout(() => {
      ui.manualSearchInput?.focus();
    }, 100);
  }
  
  function closeYoutubeSearchBar(clearInput = true) {
    if (ui.youtubeSearchOverlay) {
      ui.youtubeSearchOverlay.classList.remove('visible');
      hideElementWithFade(ui.youtubeSearchOverlay);
      ui.youtubeSearchOverlay.style.backdropFilter = 'none';
      ui.youtubeSearchOverlay.style.webkitBackdropFilter = 'none';
    }
    
    hideElementWithFade(ui.youtubeSearchBarWrapper);
    ui.youtubeSearchBtnContainer?.classList.remove('hidden-for-search');
    
    // Limpa o input e remove foco apenas se solicitado
    if (clearInput) {
      if (ui.manualSearchInput) {
        ui.manualSearchInput.value = '';
      }
      if (ui.manualSearchBtn) {
        ui.manualSearchBtn.disabled = true;
      }
    }
    
    ui.manualSearchInput?.blur();
  }

  // Mute/Unmute toggle
  let isMuted = false;
  let volumeBeforeMute = 1;
  let muteToggleDebounce = false;

  function toggleMute() {
    if (muteToggleDebounce) return;
    muteToggleDebounce = true;
    setTimeout(() => { muteToggleDebounce = false; }, 200);

    if (isMuted) {
      isMuted = false;
      setUserVolume(volumeBeforeMute);
    } else {
      volumeBeforeMute = userVolume || 1;
      isMuted = true;
      setUserVolume(0);
    }
    updateMuteIcons();
  }

  function updateMuteIcons() {
    const buttons = [ui.ctrlVolumeBtn];
    buttons.forEach(btn => {
      const icon = btn?.querySelector('i');
      if (icon) {
        icon.className = isMuted ? 'ph-bold ph-speaker-x' : 'ph-bold ph-speaker-high';
      }
    });
  }

  // Obtém a track atual de reprodução
  function getCurrentPlayingTrack() {
    if (isPlayingFromYouTube()) {
      const tracks = state.playingTracks;
      const currentIndex = state.playingTrackIndex;
      return { track: tracks[currentIndex] || null, index: currentIndex, tracks };
    }

    const tracks = hasLibraryPlaybackQueue() ? state.playingTracks : state.tracks;
    const currentIndex = hasLibraryPlaybackQueue() ? state.playingTrackIndex : state.currentTrackIndex;
    return { track: tracks[currentIndex] || null, index: currentIndex, tracks };
  }

  function playPreviousTrack(options) {
    const useCrossfade = options?.useCrossfade === true;

    // Se estiver reproduzindo no YouTube, usa a função específica
    if (isPlayingFromYouTube()) {
      playPreviousYouTubeSearchResult();
      return;
    }

    const { tracks, index } = getCurrentPlayingTrack();
    if (!tracks.length) return;
    let prevIndex = index - 1;
    if (prevIndex < 0) prevIndex = repeatEnabled ? tracks.length - 1 : 0;
    const shouldCrossfade = useCrossfade && prevIndex !== index;
    playTrackInternal(prevIndex, {
      fromPlayingTracks: hasLibraryPlaybackQueue(),
      useCrossfade: shouldCrossfade ? true : null
    });
  }

  function playNextTrack(options) {
    const useCrossfade = options?.useCrossfade === true;

    // Se estiver reproduzindo no YouTube, usa a função específica
    if (isPlayingFromYouTube()) {
      playNextYouTubeSearchResult();
      return;
    }

    const { tracks, index } = getCurrentPlayingTrack();
    if (!tracks.length) return;
    let nextIndex = index + 1;
    if (nextIndex >= tracks.length) nextIndex = -1;
    if (nextIndex === -1) return;
    const shouldCrossfade = useCrossfade && nextIndex !== index;
    playTrackInternal(nextIndex, {
      fromPlayingTracks: hasLibraryPlaybackQueue(),
      useCrossfade: shouldCrossfade ? true : null
    });
  }

  // Helper para atualizar cor de botão de controle (ativo/inativo)
  function setControlButtonColor(ctrlId, miniId, isActive) {
    const color = isActive ? '#ff7a1f' : 'rgba(255,255,255,0.4)';
    document.getElementById(ctrlId)?.style.setProperty('color', color);
    document.getElementById(miniId)?.style.setProperty('color', color);
  }

  // Helper para toggle de visibilidade de tela
  const TAB_ORDER = ['discover', 'playlist', 'youtube', 'radio'];
  let currentTabIndex = 0;

  function setupTabSwipeGesture() {
    const modal = ui.playerModal;
    if (!modal) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;
    let directionLocked = false;
    let isHorizontal = false;
    let currentScreen = null;

    const getActiveScreen = () => {
      const screens = [ui.screenDiscover, ui.screenPlaylist, ui.screenYoutube, ui.screenRadio];
      return screens[currentTabIndex];
    };

    // Resistência elástica — quanto mais arrasta, mais resiste
    const elastic = (dx) => {
      const maxDrag = window.innerWidth * 0.6;
      const sign = dx > 0 ? 1 : -1;
      const abs = Math.min(Math.abs(dx), maxDrag);
      return sign * maxDrag * (1 - Math.pow(1 - abs / maxDrag, 2.5));
    };

    modal.addEventListener('touchstart', (e) => {
      if (!e.touches.length) return;
      // Durante a reordenação de playlists, desativa o swipe de troca de abas
      // para não conflitar com o arrastar dos cards (drag and drop).
      if (playlistsReorderMode) {
        tracking = false;
        return;
      }
      if (e.target.closest('#playlists-container') || e.target.closest('.track-item') || e.target.closest('.manual-search-item') || e.target.closest('#discover-top-spacer') || e.target.closest('.discover-carousel')) {
        tracking = false;
        return;
      }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
      directionLocked = false;
      isHorizontal = false;
      currentScreen = getActiveScreen();
      if (currentScreen) {
        currentScreen.style.transition = 'none';
      }
    }, { passive: true });

    modal.addEventListener('touchmove', (e) => {
      if (!tracking || !e.touches.length || !currentScreen) return;

      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;

      if (!directionLocked) {
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
          directionLocked = true;
          isHorizontal = Math.abs(dx) > Math.abs(dy);
        }
        return;
      }

      if (!isHorizontal) return;

      // Bloqueia se não há aba nessa direção (resistência total nas bordas)
      const atStart = currentTabIndex === 0 && dx > 0;
      const atEnd = currentTabIndex === TAB_ORDER.length - 1 && dx < 0;
      const dampedDx = (atStart || atEnd) ? elastic(dx) * 0.3 : elastic(dx);

      currentScreen.style.transform = `translateX(${dampedDx}px)`;
      currentScreen.style.opacity = 1 - Math.abs(dampedDx) / window.innerWidth * 0.4;
    }, { passive: true });

    modal.addEventListener('touchend', (e) => {
      if (!tracking || !currentScreen) return;
      tracking = false;

      if (!directionLocked || !isHorizontal) {
        if (currentScreen) {
          currentScreen.style.transition = '';
          currentScreen.style.transform = '';
          currentScreen.style.opacity = '';
        }
        return;
      }

      const dx = e.changedTouches[0].clientX - startX;
      const threshold = window.innerWidth * 0.2;
      const atStart = currentTabIndex === 0 && dx > 0;
      const atEnd = currentTabIndex === TAB_ORDER.length - 1 && dx < 0;

      if (Math.abs(dx) > threshold && !atStart && !atEnd) {
        // Completa a transição
        const direction = dx < 0 ? 1 : -1;
        const newIndex = currentTabIndex + direction;
        
        // Anima saída da tela atual
        currentScreen.style.transition = 'transform 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.35s ease';
        currentScreen.style.transform = `translateX(${-direction * window.innerWidth * 0.4}px)`;
        currentScreen.style.opacity = '0';

        setTimeout(() => {
          currentScreen.style.transition = '';
          currentScreen.style.transform = '';
          currentScreen.style.opacity = '';
          switchPlayerTab(TAB_ORDER[newIndex]);
        }, 350);
      } else {
        // Volta com bounce elástico
        currentScreen.style.transition = 'transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease';
        currentScreen.style.transform = 'translateX(0)';
        currentScreen.style.opacity = '1';

        const cleanup = () => {
          currentScreen.style.transition = '';
          currentScreen.style.transform = '';
          currentScreen.style.opacity = '';
          currentScreen.removeEventListener('transitionend', cleanup);
        };
        currentScreen.addEventListener('transitionend', cleanup, { once: true });
        // Fallback cleanup
        setTimeout(cleanup, 500);
      }
    }, { passive: true });
  }

  function toggleScreen(screen, isVisible) {
    if (!screen) return;
    if (isVisible) {
      screen.classList.remove('hidden', 'slide-out-left', 'slide-out-right');
      screen.style.display = 'flex';
    } else {
      screen.classList.add('hidden');
      screen.style.display = 'none';
      screen.classList.remove('slide-in-left', 'slide-in-right', 'slide-out-left', 'slide-out-right');
    }
  }

  // Helper para toggle de visibilidade (invisible + opacity-0)
  // Nota: NÃO gerencia pointer-events aqui; overlay containers usam CSS
  function toggleElementVisibility(el, show) {
    if (!el) return;
    el.classList.toggle('invisible', !show);
    el.classList.toggle('opacity-0', !show);
  }

  // Helper para mostrar elemento com fade
  function showElementWithFade(el) {
    if (!el) return;
    el.style.opacity = '1';
    el.style.visibility = 'visible';
    el.style.pointerEvents = 'auto';
  }

  // Helper para esconder elemento com fade
  function hideElementWithFade(el) {
    if (!el) return;
    el.style.opacity = '0';
    el.style.visibility = 'hidden';
    el.style.pointerEvents = 'none';
  }

  // Helper para esconder elemento com classe visible
  function hideVisibleElement(el) {
    if (!el) return;
    el.classList.remove('visible');
    el.classList.add('opacity-0', 'invisible');
    el.style.pointerEvents = 'none';
  }

  function openScaledModal(modal, card) {
    if (!modal || !card) return;

    modal.classList.remove('opacity-0', 'invisible');
    modal.classList.add('opacity-100');
    modal.style.pointerEvents = 'auto';

    card.classList.remove('scale-95');
    card.classList.add('scale-100');

    requestAnimationFrame(() => {
      card.style.transform = 'scale(1)';
    });
  }

  function toggleShuffle() {
    shuffleEnabled = !shuffleEnabled;
    updateShuffleRepeatButtons();
  }

  function toggleRepeat() {
    repeatEnabled = !repeatEnabled;
    updateShuffleRepeatButtons();
  }

  function updateShuffleRepeatButtons() {
    setControlButtonColor('ctrl-shuffle', 'mini-shuffle', shuffleEnabled);
    setControlButtonColor('ctrl-repeat', 'mini-repeat', repeatEnabled);
  }

  // Função auxiliar para atualizar informações de uma player bar
  function updatePlayerBarInfo(elements, track) {
    const { playBtn, titleEl, artistEl, coverEl } = elements;

    const playIcon = playBtn?.querySelector('i');
    if (playIcon) {
      playIcon.className = state.isPlaying ? 'ph-fill ph-pause' : 'ph-fill ph-play';
    }

    coverEl?.classList.toggle('playing', state.isPlaying);

    if (track) {
      if (titleEl) titleEl.textContent = getTrackTitle(track) || 'Sem título';
      if (artistEl) {
        const artists = getTrackArtists(track);
        artistEl.textContent = artists || '—';
      }
      const coverImg = coverEl?.querySelector('img');
      if (coverImg) {
        const coverUrl = getTrackImage(track);
        if (coverUrl && coverUrl !== coverImg.src) coverImg.src = coverUrl;
      }
    } else {
      if (titleEl) titleEl.textContent = 'Nenhuma música';
      if (artistEl) artistEl.textContent = '—';
      const coverImg = coverEl?.querySelector('img');
      if (coverImg) coverImg.src = getFallbackCover();
    }
  }

  // Plano de fundo da aba Biblioteca (mesmo papel do ::before da Rádio):
  // arte dedicada da playlist (ex.: Bailão Otaku); durante a reprodução de
  // faixas DESSA playlist, troca pela capa da faixa atual.
  //
  // URLs em custom properties usadas no ::before de player.css são resolvidas
  // em relação a css/player.css — por isso caminhos document-relative
  // (assets/images/...) precisam virar ../assets/images/... Capas https:// não mudam.
  function toPlaylistBackgroundCssUrl(url) {
    if (!url) return null;
    const raw = String(url).trim();
    if (!raw) return null;
    if (/^(https?:|data:|blob:|\/\/)/i.test(raw)) return raw;
    if (raw.startsWith('../')) return raw;
    if (raw.startsWith('/')) return raw;
    if (raw.startsWith('src/')) return `../${raw.slice(4)}`;
    return raw;
  }

  function getPlaylistDefaultBackground(playlist) {
    if (!playlist) return null;
    const dedicated = playlist.background;
    if (isRealCover(dedicated)) return dedicated;
    const cover = getPlaylistCover(playlist);
    // getPlaylistCover pode cair em genericCover — nunca usar como fundo.
    if (isRealCover(cover)) return cover;
    return null;
  }

  function updatePlaylistHeaderBackground() {
    const playlistScreen = document.getElementById('player-screen-playlist');
    if (!playlistScreen) return;

    const videoBg = document.getElementById('playlist-video-bg');
    
    const backgroundUrl = state.currentPlaylist?.background || '';
    const isVideoBackground = backgroundUrl.endsWith('.mov') || backgroundUrl.endsWith('.mp4') || backgroundUrl.endsWith('.webm');

    if (isVideoBackground) {
      if (videoBg) {
        let videoUrl = backgroundUrl;
        if (videoBg.getAttribute('src') !== videoUrl) {
          videoBg.src = videoUrl;
        }
        videoBg.classList.remove('hidden');
        videoBg.play().catch(() => {});
      }
      playlistScreen.style.setProperty('--playlist-header-bg', 'none');
      return;
    } else {
      if (videoBg) {
        videoBg.classList.add('hidden');
        videoBg.pause();
      }
    }

    const { track, index } = getCurrentPlayingTrack();
    const currentId = state.currentPlaylist?.id || null;
    // Só troca para a capa da faixa enquanto a reprodução estiver ATIVA.
    // Pausado / parado / sem música → background padrão da playlist.
    const activelyPlayingThisPlaylist = Boolean(
      state.isPlaying &&
      currentId &&
      index >= 0 &&
      track &&
      (state.playingPlaylistId === currentId ||
        (!state.playingPlaylistId && state.tracks.includes(track)))
    );

    let coverUrl = null;

    if (activelyPlayingThisPlaylist) {
      const trackCover = getTrackImage(track);
      if (isRealCover(trackCover)) coverUrl = trackCover;
    }

    if (!coverUrl) {
      coverUrl = getPlaylistDefaultBackground(state.currentPlaylist);
    }

    // Nunca usa capa genérica: sem arte da playlist, remove o fundo.
    const cssUrl = toPlaylistBackgroundCssUrl(coverUrl);
    playlistScreen.style.setProperty(
      '--playlist-header-bg',
      cssUrl ? `url("${cssUrl.replace(/"/g, '\\"')}")` : 'none'
    );
  }

  function updateControlsBar() {
    // Não sobrescreve se a rádio está tocando
    if (radioPlaying && radioCurrentChannel) return;

    const { track } = getCurrentPlayingTrack();
    updatePlayerBarInfo({
      playBtn: ui.ctrlPlay,
      titleEl: ui.ctrlTitle,
      artistEl: ui.ctrlArtist,
      coverEl: ui.ctrlCover
    }, track);

    // Fundo da página da playlist: faixa tocando ou background dedicado.
    updatePlaylistHeaderBackground();

    syncExpandedCover();


    // Carrega/atualiza a letra sincronizada da faixa atual.
    if (track) {
      loadLyricsForCurrentTrack();
    } else {
      clearLyrics();
      lyricsState.key = null;
      lyricsState.requestedKey = null;
    }

    // Atualiza o estado ativado/desativado do botão de avançar e voltar
    let hasNext = false;
    let hasPrev = false;
    if (isPlayingFromYouTube()) {
      const allItems = getYouTubeSearchItems();
      const currentIndex = getCurrentYouTubeSearchIndex(allItems);
      hasNext = currentIndex >= 0 && currentIndex < allItems.length - 1;
      hasPrev = currentIndex > 0;
    } else {
      const { tracks, index } = getCurrentPlayingTrack();
      hasNext = tracks && tracks.length > 0 && index >= 0 && index < tracks.length - 1;
      hasPrev = tracks && tracks.length > 0 && index > 0;
    }
    if (ui.ctrlNext) {
      ui.ctrlNext.disabled = !hasNext;
    }
    if (ui.ctrlPrev) {
      ui.ctrlPrev.disabled = !hasPrev;
    }
  }



  function switchPlayerTab(tab) {
    const isDiscover = tab === 'discover';
    const isPlaylist = tab === 'playlist';
    const isYoutube = tab === 'youtube';
    const isRadio = tab === 'radio';

    const newIndex = TAB_ORDER.indexOf(tab);
    const direction = newIndex > currentTabIndex ? 'right' : 'left';
    const screens = [ui.screenDiscover, ui.screenPlaylist, ui.screenYoutube, ui.screenRadio];
    const targetScreen = screens[newIndex];
    const prevScreen = screens[currentTabIndex];

    // Atualiza tabs
    ui.tabDiscover?.classList.toggle('active', isDiscover);
    ui.tabPlaylist?.classList.toggle('active', isPlaylist);
    ui.tabYoutube?.classList.toggle('active', isYoutube);
    ui.tabRadio?.classList.toggle('active', isRadio);

    // Animação lateral
    if (newIndex !== currentTabIndex && prevScreen && targetScreen) {
      // Esconde todas as outras
      screens.forEach((s, i) => {
        if (i !== currentTabIndex && i !== newIndex) toggleScreen(s, false);
      });

      // Mostra a nova tela com slide
      targetScreen.classList.remove('hidden', 'slide-in-left', 'slide-in-right');
      targetScreen.style.display = 'flex';
      void targetScreen.offsetWidth;
      targetScreen.classList.add(direction === 'right' ? 'slide-in-right' : 'slide-in-left');

      // Esconde a tela anterior
      toggleScreen(prevScreen, false);
    } else {
      screens.forEach((s, i) => toggleScreen(s, i === newIndex));
    }

    currentTabIndex = newIndex;
    
    // Sempre esconde a barra de busca ao trocar de aba
    hideElementWithFade(ui.youtubeSearchBarWrapper);
    
    if (ui.youtubeSearchBtnContainer) {
      ui.youtubeSearchBtnContainer.classList.remove('hidden-for-search');
      if (isYoutube) {
        ui.youtubeSearchBtnContainer.classList.add('visible');
        showElementWithFade(ui.youtubeSearchBtnContainer);
      } else {
        ui.youtubeSearchBtnContainer.classList.remove('visible');
        hideElementWithFade(ui.youtubeSearchBtnContainer);
      }
    }
    
    // Não foca automaticamente no input ao trocar para YouTube
    // O foco acontece ao clicar no botão de busca

    if (isDiscover) {
      requestAnimationFrame(() => {
        updateDiscoverSpacerLayout?.();
        setTimeout(() => updateDiscoverSpacerLayout?.(), 120);
      });
    }
  }

  let updateDiscoverSpacerLayout = null;

  // ====== Discover Banner Carousel ======
  function renderDiscoverCarousel() {
    const track = document.getElementById('discover-carousel-track');
    const dotsContainer = document.getElementById('discover-carousel-dots');
    if (!track || !dotsContainer || typeof SPECIAL_PLAYLISTS === 'undefined') return;

    const playlists = SPECIAL_PLAYLISTS.slice(0, 8);
    if (!playlists.length) return;

    track.innerHTML = playlists.map((pl, i) => {
      const count = getPlaylistTrackCount(pl);
      return `
        <div class="discover-carousel-slide${i === 0 ? ' active' : ''}" data-carousel-id="${pl.id}" data-index="${i}">
          <img src="${pl.cover}" alt="${pl.name}" onerror="this.onerror=null;this.src='assets/images/genericCover.png'" loading="lazy">
          <div class="carousel-slide-overlay"></div>
          <div class="carousel-slide-content">
            <div class="carousel-slide-info">
              <p class="carousel-slide-title">${pl.name}</p>
              <p class="carousel-slide-subtitle">${count} músicas</p>
            </div>
            <button class="carousel-slide-btn" data-play-id="${pl.id}"><i class="ph-fill ph-play" style="font-size:10px; line-height:1;"></i> Ouvir agora</button>
          </div>
        </div>`;
    }).join('');

    dotsContainer.innerHTML = playlists.map((_, i) =>
      `<div class="dot${i === 0 ? ' active' : ''}" data-dot="${i}"></div>`
    ).join('');

    let current = 0;
    const slides = track.querySelectorAll('.discover-carousel-slide');
    const dots = dotsContainer.querySelectorAll('.dot');

    function goTo(index) {
      current = Math.max(0, Math.min(index, slides.length - 1));
      const slide = slides[current];
      const containerWidth = track.parentElement.offsetWidth;
      const slideWidth = slide.offsetWidth;
      const slideLeft = slide.offsetLeft;
      // Centraliza o slide, mas não permite offset negativo (primeiro slide) nem exceder o final
      const maxOffset = track.scrollWidth - containerWidth;
      const idealOffset = slideLeft - (containerWidth - slideWidth) / 2;
      const offset = Math.max(0, Math.min(idealOffset, maxOffset));
      track.style.transform = `translateX(${-offset}px)`;
      slides.forEach((s, i) => s.classList.toggle('active', i === current));
      // Reinicia a animação do dot sem forced reflow síncrono (void offsetWidth).
      dots.forEach((d) => d.classList.remove('active'));
      requestAnimationFrame(() => {
        dots[current]?.classList.add('active');
      });
    }

    // Dot clicks
    dots.forEach(dot => {
      dot.addEventListener('click', () => goTo(parseInt(dot.dataset.dot)));
    });

    // Slide clicks
    slides.forEach(slide => {
      const idx = parseInt(slide.dataset.index);
      const playBtn = slide.querySelector('.carousel-slide-btn');
      const playlistId = slide.dataset.carouselId;
      const playlist = playlists.find(p => p.id === playlistId);

      slide.addEventListener('click', (e) => {
        if (e.target.closest('.carousel-slide-btn')) return;
        if (idx !== current) { goTo(idx); return; }
        if (playlist) selectFeaturedPlaylist(playlist, false);
      });

      playBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (playlist) selectFeaturedPlaylist(playlist, true);
      });
    });

    // Touch swipe
    let startX = 0, isDragging = false, dragOffset = 0, baseOffset = 0;

    track.addEventListener('touchstart', (e) => {
      if (!e.touches.length) return;
      startX = e.touches[0].clientX;
      isDragging = true;
      track.classList.add('dragging');
      // Lê o offset atual do transform de forma segura
      const style = getComputedStyle(track);
      const matrix = style.transform && style.transform !== 'none' ? new DOMMatrix(style.transform) : { m41: 0 };
      baseOffset = matrix.m41 || 0;
    }, { passive: true });

    track.addEventListener('touchmove', (e) => {
      if (!isDragging || !e.touches.length) return;
      dragOffset = e.touches[0].clientX - startX;
      track.style.transform = `translateX(${baseOffset + dragOffset}px)`;
    }, { passive: true });

    track.addEventListener('touchend', () => {
      if (!isDragging) return;
      isDragging = false;
      track.classList.remove('dragging');
      if (Math.abs(dragOffset) > 40) {
        goTo(current + (dragOffset < 0 ? 1 : -1));
      } else {
        goTo(current);
      }
      dragOffset = 0;
    }, { passive: true });

    // Auto-play (vai e volta, sem loop abrupto).
    // Pausa enquanto o week sheet (ou outro modal) cobre o player: o interval
    // + dot-progress continuavam rodando atrás do sheet e competiam com a
    // rolagem do Liquid Glass (mutações de classe a cada 5s + animação CSS).
    let autoDirection = 1;
    let autoTimer = null;
    const isSheetCoveringPlayer = () =>
      document.body.classList.contains('week-sheet-open') ||
      document.body.classList.contains('week-sheet-active');

    function tickCarouselAutoplay() {
      if (isSheetCoveringPlayer()) return;
      if (current >= slides.length - 1) autoDirection = -1;
      if (current <= 0) autoDirection = 1;
      goTo(current + autoDirection);
    }

    function startCarouselAutoplay() {
      clearInterval(autoTimer);
      autoTimer = setInterval(tickCarouselAutoplay, 5000);
    }

    function stopCarouselAutoplay() {
      clearInterval(autoTimer);
      autoTimer = null;
    }

    startCarouselAutoplay();
    track.parentElement.addEventListener('touchstart', () => { stopCarouselAutoplay(); }, { passive: true });
    track.parentElement.addEventListener('touchend', () => {
      startCarouselAutoplay();
    }, { passive: true });

    const sheetCoverObserver = new MutationObserver(() => {
      if (isSheetCoveringPlayer()) stopCarouselAutoplay();
      else if (!autoTimer) startCarouselAutoplay();
    });
    sheetCoverObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    if (isSheetCoveringPlayer()) stopCarouselAutoplay();

    // Efeito progressivo ao scrollar (igual ao playlists-container)
    const discoverContainer = document.getElementById('discover-container');
    const carouselWrapper = document.getElementById('discover-carousel-wrapper');
    if (discoverContainer && carouselWrapper) {
      let discoverScrollRaf = null;
      let lastDiscoverScroll = -1;

      function handleDiscoverScroll() {
        const scrollTop = discoverContainer.scrollTop;
        if (scrollTop === lastDiscoverScroll) return;
        lastDiscoverScroll = scrollTop;
        if (discoverScrollRaf !== null) return;
        discoverScrollRaf = requestAnimationFrame(() => {
          discoverScrollRaf = null;
          const st = lastDiscoverScroll;
          const maxScroll = 150;
          const progress = Math.min(st / maxScroll, 1);

          const opacity = Math.max(1 - (progress * 0.85), 0.1);
          const scale = 1 - (progress * 0.08);
          const blur = progress * 4;
          const translateY = -(progress * 15);

          carouselWrapper.style.opacity = opacity;
          carouselWrapper.style.transform = `scale(${scale}) translateY(${translateY}px)`;
          if (blur > 0.1) {
            carouselWrapper.style.filter = `blur(${blur.toFixed(1)}px)`;
          } else {
            carouselWrapper.style.filter = '';
          }

          if (st > 50) {
            carouselWrapper.style.zIndex = '5';
            carouselWrapper.style.pointerEvents = 'none';
          } else {
            carouselWrapper.style.zIndex = '25';
            carouselWrapper.style.pointerEvents = 'auto';
          }
        });
      }

      discoverContainer.addEventListener('scroll', handleDiscoverScroll, { passive: true });
      handleDiscoverScroll();

      // Touch no carrossel: vertical redireciona scroll, horizontal é pro slide
      let dTouchStartY = 0;
      let dTouchStartX = 0;
      let dTouchStartScroll = 0;
      let dDirection = null;

      carouselWrapper.addEventListener('touchstart', function(e) {
        if (!e.touches.length) return;
        dTouchStartY = e.touches[0].clientY;
        dTouchStartX = e.touches[0].clientX;
        dTouchStartScroll = discoverContainer.scrollTop;
        dDirection = null;
      }, { passive: true });

      carouselWrapper.addEventListener('touchmove', function(e) {
        if (!e.touches.length) return;
        const dy = dTouchStartY - e.touches[0].clientY;
        const dx = e.touches[0].clientX - dTouchStartX;

        if (dDirection === null && (Math.abs(dy) > 8 || Math.abs(dx) > 8)) {
          dDirection = Math.abs(dy) > Math.abs(dx) ? 'vertical' : 'horizontal';
        }

        if (dDirection === 'vertical') {
          discoverContainer.scrollTop = dTouchStartScroll + dy;
        }
      }, { passive: true });
    }

    goTo(0);

    // Ajusta o spacer ao fundo real do carrossel dentro da área scrollável.
    // Usar apenas offsetHeight quebrava em viewports mobile, porque ignorava o
    // deslocamento vertical criado pelo header/tabs do player.
    function updateDiscoverSpacer() {
      const spacer = document.getElementById('discover-top-spacer');
      if (!spacer || !carouselWrapper || !discoverContainer) return;
      const reserveGap = 30;
      const layoutBottom = carouselWrapper.offsetTop + carouselWrapper.offsetHeight;
      const containerRect = discoverContainer.getBoundingClientRect();
      const wrapperRect = carouselWrapper.getBoundingClientRect();
      const visualBottom = wrapperRect.bottom - containerRect.top;
      const reservedHeight = Math.ceil(Math.max(layoutBottom, visualBottom) + reserveGap);
      spacer.style.height = `${reservedHeight}px`;
    }

    updateDiscoverSpacerLayout = updateDiscoverSpacer;
    updateDiscoverSpacer();
    requestAnimationFrame(updateDiscoverSpacer);
    setTimeout(updateDiscoverSpacer, 120);
    setTimeout(updateDiscoverSpacer, 420);
    track.querySelectorAll('img').forEach(img => {
      if (!img.complete) img.addEventListener('load', updateDiscoverSpacer, { once: true });
    });
    window.addEventListener('resize', updateDiscoverSpacer, { passive: true });
  }

  // Renderiza as playlists especiais na tela Descobrir
  function renderSpecialPlaylists() {
    if (!ui.specialPlaylistsGrid || typeof SPECIAL_PLAYLISTS === 'undefined') return;

    ui.specialPlaylistsGrid.innerHTML = SPECIAL_PLAYLISTS.map(playlist => {
      const trackCount = getPlaylistTrackCount(playlist);
      return `
        <div class="special-playlist-card group cursor-pointer rounded-xl overflow-hidden bg-yellow-500/10 hover:bg-yellow-500/20 transition-all duration-300 ring-1 ring-yellow-500/20" 
             data-special-id="${playlist.id}">
          <div class="relative aspect-square">
            <img src="${playlist.cover}" 
                 alt="${playlist.name}" 
                 class="w-full h-full object-cover"
                 onerror="this.onerror=null;this.src='assets/images/genericCover.png'">
            <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent"></div>
            <div class="absolute top-2 right-2">
              <i class="ph-fill ph-lightning text-orange-500 text-lg drop-shadow-lg"></i>
            </div>
            <div class="discover-play-wrapper">
              <button class="special-play-btn discover-play-circle liquid-glass" style="--btn-color: #eab308;">
                <span class="liquid-glass-edge"></span>
                <i class="ph-fill ph-play discover-play-icon"></i>
              </button>
            </div>
            <div class="absolute bottom-0 left-0 right-0 p-3">
              <p class="text-white font-semibold text-sm truncate">${playlist.name}</p>
              <p class="text-yellow-500/80 text-xs">${trackCount} músicas</p>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Event listeners para as playlists especiais
    ui.specialPlaylistsGrid.querySelectorAll('.special-playlist-card').forEach(card => {
      const specialId = card.dataset.specialId;
      const specialPlaylist = SPECIAL_PLAYLISTS.find(p => p.id === specialId);

      if (!specialPlaylist) return;

      // Clique no card - seleciona a playlist
      card.addEventListener('click', (e) => {
        if (e.target.closest('.special-play-btn')) return;
        selectFeaturedPlaylist(specialPlaylist, false);
      });

      // Clique no botão play - toca imediatamente
      card.querySelector('.special-play-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        selectFeaturedPlaylist(specialPlaylist, true);
      });
    });
  }

  // Renderiza as playlists em destaque na tela Descobrir
  function renderFeaturedPlaylists() {
    if (!ui.featuredPlaylistsGrid) return;

    ui.featuredPlaylistsGrid.innerHTML = FEATURED_PLAYLISTS.map(playlist => {
      const trackCount = getPlaylistTrackCount(playlist);
      return `
        <div class="featured-playlist-card group cursor-pointer rounded-xl overflow-hidden bg-white/5 hover:bg-white/10 transition-all duration-300" 
             data-featured-id="${playlist.id}">
          <div class="relative aspect-square">
            <img src="${playlist.cover}" 
                 alt="${playlist.name}" 
                 class="w-full h-full object-cover"
                 onerror="this.onerror=null;this.src='assets/images/genericCover.png'">
            <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent"></div>
            <div class="discover-play-wrapper">
              <button class="featured-play-btn discover-play-circle liquid-glass" style="--btn-color: #f97316;">
                <span class="liquid-glass-edge"></span>
                <i class="ph-fill ph-play discover-play-icon"></i>
              </button>
            </div>
            <div class="absolute bottom-0 left-0 right-0 p-3">
              <p class="text-white font-semibold text-sm truncate">${playlist.name}</p>
              <p class="text-white/60 text-xs">${trackCount} músicas</p>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Event listeners para as playlists em destaque
    ui.featuredPlaylistsGrid.querySelectorAll('.featured-playlist-card').forEach(card => {
      const featuredId = card.dataset.featuredId;
      const featuredPlaylist = FEATURED_PLAYLISTS.find(p => p.id === featuredId);

      if (!featuredPlaylist) return;

      // Clique no card - seleciona a playlist
      card.addEventListener('click', (e) => {
        if (e.target.closest('.featured-play-btn')) return;
        selectFeaturedPlaylist(featuredPlaylist, false);
      });

      // Clique no botão play - toca imediatamente
      card.querySelector('.featured-play-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        selectFeaturedPlaylist(featuredPlaylist, true);
      });
    });
  }

  // Seleciona uma playlist em destaque e carrega suas músicas
  async function selectFeaturedPlaylist(featuredPlaylist, autoPlay = false) {
    if (!featuredPlaylist) return;

    setFeedback('Carregando...', 'info', {
      name: featuredPlaylist.name,
      cover: featuredPlaylist.cover,
      trackCount: featuredPlaylist.tracks.length
    });

    // Cria uma cópia da playlist para não modificar a original
    const playlist = {
      id: featuredPlaylist.id,
      name: featuredPlaylist.name,
      cover: featuredPlaylist.cover,
      background: featuredPlaylist.background || null,
      images: [{ url: featuredPlaylist.cover }],
      tracks: featuredPlaylist.tracks.map(t => ({
        ...t,
        videoId: t.videoId, // Preserva videoId explicitamente
        duration_ms: t.duration_ms || 0,
        album: { name: 'Featured', images: [{ url: featuredPlaylist.cover }] }
      })),
      isFeatured: true
    };

    // Verifica se já existe nas playlists do usuário
    const existingIndex = state.playlists.findIndex(p => p.id === playlist.id);
    if (existingIndex === -1) {
      // Adiciona às playlists do usuário
      state.playlists.push(playlist);
      savePlaylistsToStorage();
      renderPlaylists();
    } else {
      // Mantém background/capa de página sincronizados com a definição estática
      const existing = state.playlists[existingIndex];
      if (playlist.background) existing.background = playlist.background;
      if (playlist.cover) {
        existing.cover = playlist.cover;
        existing.images = [{ url: playlist.cover }];
      }
      playlist.tracks = existing.tracks?.length ? existing.tracks : playlist.tracks;
    }

    // Seleciona a playlist
    state.currentPlaylist = playlist;
    state.tracks = [...playlist.tracks];
    state.currentTrackIndex = -1;

    // Muda para a aba Biblioteca
    switchPlayerTab('playlist');

    // Renderiza as faixas
    renderTracks(state.tracks);
    updatePlaylistHeaderBackground();

    setFeedback('Carregada com sucesso!', 'success', {
      name: playlist.name,
      cover: playlist.cover,
      trackCount: playlist.tracks.length
    });

    // Dispara preload em background com limitador
    preloadTracksInBackground(state.tracks, playlist.id);

    // Enriquece com capas
    enrichTracksWithCovers(state.tracks);

    // Auto-play se solicitado
    if (autoPlay && state.tracks.length > 0) {
      setTimeout(() => playTrack(0), 300);
    }
  }

  function init() {
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        // Injeta o HTML do player antes de inicializar
        const htmlInjected = await injectPlayerHtml();
        if (!htmlInjected) {
          console.error('❌ [PLAYER] Não foi possível inicializar - HTML não carregado');
          initPromise = null;
          return;
        }

        // Popula os elementos do UI após o HTML ser injetado
        populateUiElements();

        resetPlaybackState({ resetTrackIndex: true, clearTracks: true, clearCaches: false });

        // Carrega cache de áudio do storage
        loadAudioCacheFromStorage();

        // Hidrata caches persistentes (IndexedDB): resoluções e capas de sessões
        // anteriores. Teto de 1.5s para nunca atrasar o carregamento da UI;
        // se demorar, a hidratação continua em background.
        await Promise.race([hydratePersistentCaches(), delay(1500)]);

        // Carrega playlists salvas
        const savedPlaylists = loadPlaylistsFromStorage();
        if (savedPlaylists.length > 0) {
          state.playlists = savedPlaylists;
          state.playlistsLoaded = true;
        }

        // Carrega a playlist fixa "Músicas Favoritas"
        ensureWatchLaterPlaylist();
        renderPlaylists();

        // Renderiza playlists especiais e em destaque
        renderDiscoverCarousel();
        renderSpecialPlaylists();
        renderFeaturedPlaylists();

        // Restaura estado anterior (playlist e track selecionados)
        const savedState = loadCurrentStateFromStorage();
        if (savedState?.currentPlaylistId && state.playlists.length > 0) {
          const playlist = state.playlists.find(p => p.id === savedState.currentPlaylistId);
          if (playlist && playlist.tracks?.length > 0) {
            state.currentPlaylist = playlist;
            state.tracks = playlist.tracks || [];
            state.currentTrackIndex = savedState.currentTrackIndex ?? -1;

            // Renderiza as faixas da playlist restaurada
            refreshTracksView();
          }
        }

        // Restaura a fila e a posição de reprodução (retomada após reload/crash).
        restorePlaybackState(savedState);

        bindUi();
        
        // Configura Media Session API para controles do sistema
        setupMediaSessionHandlers();
        
        // Reforça periodicamente a remoção dos handlers de seek
        // Alguns navegadores podem tentar reativá-los automaticamente
        setInterval(() => {
          if (state.isPlaying) {
            forceRemoveSeekHandlers();
          }
        }, 5000); // A cada 5 segundos

        // Sentinel + observadores: se Clear Site Data apagar o storage com a
        // aba aberta, bloqueamos beforeunload/intervals de regravar o estado.
        plantStorageSentinel();
        setInterval(checkStorageIntegrity, 2000);
        window.addEventListener('focus', checkStorageIntegrity);
        window.addEventListener('pagehide', checkStorageIntegrity);

        // Salva ao fechar/recarregar a página
        window.addEventListener('beforeunload', saveAllData);

        // Persiste a posição de reprodução periodicamente. Crashes do WebContent
        // (ex.: iOS Safari ao girar a tela com o iframe do YouTube) NÃO disparam
        // beforeunload/pagehide de forma confiável, então salvamos com frequência
        // para que o reload restaure a faixa e a posição exatas. Grava apenas a
        // chave pequena de "estado atual" (barato).
        setInterval(() => {
          if (preventSaveOnUnload) return;
          if (state.isPlaying || (videoMode && videoMode.isVideo())) {
            saveCurrentStateToStorage();
          }
        }, 4000);

        // Também salva imediatamente quando a página fica oculta (bloqueio/troca de app).
        document.addEventListener('visibilitychange', () => {
          checkStorageIntegrity();
          if (document.visibilityState === 'hidden') saveCurrentStateToStorage();
        });

        // Inicializa a rádio
        initRadio();
        initMainProgressBar();

        // Como o player agora é standalone e permanentemente aberto:
        lockBodyScroll();
        updatePlaylistEmptyState();
        
        requestAnimationFrame(() => {
          updateDiscoverSpacerLayout?.();
          setTimeout(() => updateDiscoverSpacerLayout?.(), 120);
        });

        initCompleted = true;
      } catch (error) {
        initPromise = null;
        console.error('❌ [PLAYER] Erro ao inicializar:', error);
      }
    })();

    return initPromise;
  }

  let mainProgressRaf = null;

  function initMainProgressBar() {
    const container = document.getElementById('ctrl-progress-container');
    const bar = document.getElementById('ctrl-progress-bar');
    const currentEl = document.getElementById('ctrl-progress-current');
    const remainingEl = document.getElementById('ctrl-progress-remaining');
    if (!container || !bar) return;

    let isDragging = false;
    let isHovered = false;
    const playerBar = document.getElementById('player-controls-bar');

    container.addEventListener('pointerenter', () => {
      isHovered = true;
      if (playerBar) playerBar.classList.add('progress-hovered');
    });
    container.addEventListener('pointerleave', () => {
      isHovered = false;
      if (!isDragging && playerBar) playerBar.classList.remove('progress-hovered');
    });

    function formatTime(secs) {
      if (!secs || isNaN(secs) || !isFinite(secs)) return '0:00';
      const m = Math.floor(Math.abs(secs) / 60);
      const s = Math.floor(Math.abs(secs) % 60);
      return (secs < 0 ? '-' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    function getMediaDuration() {
      if (videoMode && videoMode.isVideo()) return videoMode.getDuration() || 0;
      let dur = audio.duration || 0;
      if (!dur || !Number.isFinite(dur)) {
        const { track } = getCurrentPlayingTrack();
        if (track && track.duration_ms) dur = track.duration_ms / 1000;
      }
      return dur;
    }

    function seekTo(e) {
      if (!hasValidTrack() || e.clientX == null) return;
      const rect = container.getBoundingClientRect();
      // Ensure width is valid to avoid division by zero
      const width = rect.width || 1;
      const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / width));
      const dur = getMediaDuration();
      
      if (videoMode && videoMode.isVideo()) {
        if (dur > 0) videoMode.seekTo(pos * dur);
      } else {
        if (dur > 0) audio.currentTime = pos * dur;
      }
    }

    container.addEventListener('pointerdown', (e) => {
      // Allow default actions for multi-touch (e.g. zooming), but not for primary drawing/dragging.
      // We rely on CSS touch-action: none; for primary suppression, but just in case:
      if (e.pointerType === 'touch' && e.cancelable) {
        e.preventDefault();
      }
      isDragging = true;
      if (playerBar) playerBar.classList.add('progress-hovered');
      seekTo(e);
      try { container.setPointerCapture(e.pointerId); } catch (err) {}
    });

    container.addEventListener('pointermove', (e) => {
      if (isDragging) {
        if (e.pointerType === 'touch' && e.cancelable) {
          e.preventDefault();
        }
        const rect = container.getBoundingClientRect();
        const width = rect.width || 1;
        const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / width));
        bar.style.width = `${pos * 100}%`;
        
        const dur = getMediaDuration();
        if (dur > 0 && currentEl && remainingEl) {
          const scrubTime = pos * dur;
          currentEl.textContent = formatTime(scrubTime);
          remainingEl.textContent = formatTime(scrubTime - dur);
        }
      }
    });

    const stopDrag = (e) => {
      if (isDragging) {
        isDragging = false;
        seekTo(e);
        try { container.releasePointerCapture(e.pointerId); } catch(err) {}
      }
      // Clean up visual states robustly on end of interaction
      if (e.type === 'pointerup' || e.type === 'pointercancel' || e.type === 'lostpointercapture') {
        if (e.pointerType === 'touch' || !isHovered) {
          isHovered = false;
          if (playerBar) playerBar.classList.remove('progress-hovered');
        }
      }
    };

    container.addEventListener('pointerup', stopDrag);
    container.addEventListener('pointercancel', stopDrag);
    container.addEventListener('lostpointercapture', stopDrag);

    function updateLoop() {
      if (!isDragging) {
        let cur = 0, dur = getMediaDuration();
        if (videoMode && videoMode.isVideo()) {
          cur = videoMode.getCurrentTime();
        } else {
          cur = audio.currentTime || 0;
        }

        if (dur > 0) {
          bar.style.width = `${(cur / dur) * 100}%`;
          if ((isHovered || isDragging) && currentEl && remainingEl) {
            currentEl.textContent = formatTime(cur);
            remainingEl.textContent = formatTime(cur - dur);
          }
        } else {
          bar.style.width = '0%';
          if ((isHovered || isDragging) && currentEl && remainingEl) {
            currentEl.textContent = '0:00';
            remainingEl.textContent = '-0:00';
          }
        }
      }
      mainProgressRaf = requestAnimationFrame(updateLoop);
    }
    
    updateLoop();
  }

  function updatePlaylistEmptyState() {
    // O empty state da Biblioteca deve aparecer quando não há tracks
    // renderizadas no tracks-container (excluindo o próprio empty state)
    const hasTracks = ui.tracksContainer && Array.from(ui.tracksContainer.children).some(
      child => child.id !== 'playlist-empty-state'
    );
    if (ui.playlistEmptyState) {
      ui.playlistEmptyState.classList.toggle('hidden', hasTracks);
    }
  }

  function openFilePicker() {
    if (!ui.fileInput) return;
    ui.fileInput.value = '';
    // Pequeno delay evita bloqueios de focus pelo modal
    setTimeout(() => ui.fileInput?.click(), 60);
  }

  function handleFileSelection(event) {
    const file = event.target?.files?.[0];
    if (!file) {
      return;
    }
    importPlaylistFromCsv(file);
  }

  function getFallbackCover() {
    return 'assets/images/genericCover.png';
  }

  function getPlaylistNameFromFile(name = '') {
    const cleaned = name.replace(/\.csv$/i, '').trim();
    return cleaned || 'Playlist importada';
  }

  function normalizeHeaderName(header = '') {
    return header.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function sanitizeImageUrl(url = '') {
    if (!url) return '';
    const trimmed = url.trim();
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:image/')) {
      return trimmed;
    }
    if (trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('/') || trimmed.startsWith('src/')) {
      return trimmed;
    }
    return '';
  }

  function normalizeString(str = '') {
    return str
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanTrackTitle(str = '') {
    const raw = String(str);

    // 1) Remove blocos entre parênteses/colchetes com metadados (official video, lyrics, remaster...)
    //    e normaliza (minúsculo, sem acentos, sem pontuação)
    let cleaned = normalizeString(
      raw.replace(/[(\[{][^)\]}]*(official|oficial|video|audio|lyric|letra|visualizer|remaster|remix|live|ao vivo|hd|4k|mv|m\/v|clip)[^)\]}]*[)\]}]/gi, ' ')
    )
      // 2) Remove termos soltos de metadados (texto já normalizado: minúsculo, sem pontuação)
      .replace(/\b(official music video|official video|official audio|music video|lyric video|lyrics|letra|legendado|videoclipe|clipe oficial|video oficial|audio oficial|visualizer|official|oficial|audio|video|hd|4k|hq|mv)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // 3) Corta sufixos de versão/feat, mas SÓ aceita o corte se sobrar conteúdo antes dele
    //    (protege títulos legítimos que começam com esses termos, ex: "Live Your Life")
    const cut = cleaned.replace(/\s*\b(remix|version|sped up|slow(?:ed)?|super slowed|ao vivo|live|remaster(?:ed)?|feat|ft|featuring)\b.*$/, '').trim();
    if (cut) cleaned = cut;

    // 4) Nunca retorna vazio se o título original tinha conteúdo
    return cleaned || normalizeString(raw);
  }


  function isFallbackCover(url = '') {
    const trimmed = (url || '').trim();
    return trimmed.endsWith('genericCover.png');
  }

  function isGeneratedCover(url = '') {
    return typeof url === 'string' && url.trim().startsWith('data:image/svg+xml');
  }

  // Helper para verificar se é uma capa real (não fallback nem gerada)
  function isRealCover(url) {
    return Boolean(url) && !isFallbackCover(url) && !isGeneratedCover(url);
  }

  function isPresetPlaylistName(name = '') {
    const normalized = (name || '').trim().toLowerCase();
    return ['favorite songs', 'favorite albums', 'favorite artists'].includes(normalized);
  }
  function isMosaicCover(url = '') {
    return typeof url === 'string' && /^data:image\/(png|jpeg)/.test(url.trim());
  }

  function getPresetCoverForPlaylist(name = '') {
    const normalized = (name || '').trim().toLowerCase();
    const presets = {
      'favorite songs': 'assets/images/favoriteSongs.png',
      'favorite albums': 'assets/images/favoriteAlbums.png',
      'favorite artists': 'assets/images/favoriteArtists.png'
    };
    return presets[normalized] || '';
  }

  function detectColumns(headers = []) {
    const normalized = headers.map(normalizeHeaderName);
    const findColumn = (aliases) => normalized.findIndex((value) =>
      aliases.some(alias => value === alias || value.includes(alias))
    );

    const imageAliases = [
      'image', 'imagesmall', 'imagemedium', 'imagelarge',
      'cover', 'coverurl', 'coverart', 'albumcover', 'albumimage',
      'thumbnail', 'thumbnailurl', 'thumb', 'artwork', 'artworkurl'
    ];

    const playlistImageAliases = [
      'playlistimage', 'playlistcover', 'coverplaylist', 'playlistthumb',
      'playlistart', 'playlistartwork', 'playlistphoto', 'playlistpicture', 'playlistpic'
    ];

    return {
      title: findColumn(['title', 'track', 'trackname', 'name']),
      artist: findColumn(['artist', 'artists', 'artistname']),
      album: findColumn(['album', 'albumname']),
      image: findColumn(imageAliases),
      isrc: findColumn(['isrc']),
      playlist: findColumn(['playlist', 'playlistname', 'listname']),
      playlistImage: findColumn(playlistImageAliases),
      durationMs: findColumn(['durationms', 'duration_ms', 'lengthms', 'ms']),
      duration: findColumn(['duration', 'length', 'time'])
    };
  }

  function normalizeQuery(text = '') {
    return text.replace(/\s+/g, ' ').trim();
  }

  // Helper para desembrulhar resposta do AllOrigins
  function unwrapAllOriginsResponse(parsed) {
    if (parsed?.contents && typeof parsed.contents === 'string') {
      try {
        return JSON.parse(parsed.contents);
      } catch {
        return parsed;
      }
    }
    return parsed;
  }

  async function fetchWithTimeout(url, timeout = 6000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(id);
      return response;
    } catch (error) {
      clearTimeout(id);
      throw error;
    }
  }


  // Busca via Netlify Function (scraping direto do YouTube)
  async function searchPlayDl(trackName, artistName, trackDurationMs = null) {
    // Só funciona em produção (Netlify) ou com netlify dev
    if (localDevFlag && !window.location.port.toString().startsWith('888')) {
      return null;
    }

    const query = `${trackName} ${artistName} official audio`.trim();
    if (!query) return null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(ApiClient.urls.youtubeSearch(query), {
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!response.ok) {
        console.warn(`[YouTube] HTTP ${response.status}`);
        return null;
      }

      const data = await response.json();
      
      // Suporta tanto o novo formato (objeto com videos) quanto o antigo (array direto)
      let results;
      if (data && data.videos && Array.isArray(data.videos)) {
        results = data.videos;
      } else if (Array.isArray(data)) {
        results = data;
      } else {
        return null;
      }
      
      if (!results.length) {
        return null;
      }

      const validResults = results.filter(v => {
        const duration = v.lengthSeconds || 0;
        return duration >= 30 && duration <= 900;
      });

      if (!validResults.length) return null;

      const scored = validResults.map(video => ({
        ...video,
        score: calculateTrackScore(video, {
          name: trackName,
          artists: [{ name: artistName }],
          duration_ms: trackDurationMs
        })
      }));

      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];

      if (!best || best.score < 1) return null;

      return {
        videoId: best.videoId,
        instance: 'youtube-search',
        lengthSeconds: best.lengthSeconds
      };

    } catch (error) {
      console.warn(`[YouTube] Error:`, error.message);
      return null;
    }
  }

  // =====================
  // Busca Manual de Faixas
  // =====================

  let manualSearchAbort = null;

  async function performManualSearch() {
    const query = ui.manualSearchInput?.value?.trim();
    if (!query) return;

    const searchType = youtubeSearchState.searchType || 'tracks';

    // Fecha o modal de busca sem limpar o input
    closeYoutubeSearchBar(false);

    // Cancela busca anterior se existir
    if (manualSearchAbort) {
      manualSearchAbort.abort();
    }
    manualSearchAbort = new AbortController();

    // Reset do estado de paginação para nova busca
    youtubeSearchState.query = query;
    youtubeSearchState.offset = 0;
    youtubeSearchState.hasMore = false;
    youtubeSearchState.isLoading = true;
    youtubeSearchState.results = [];

    const resultsContainer = ui.manualSearchResults;
    if (!resultsContainer) return;

    // Esconde empty state e mostra loading
    if (ui.youtubeEmptyState) ui.youtubeEmptyState.classList.add('hidden');
    
    const searchTypeLabel = searchType === 'playlists' ? 'playlists' : 'faixas';
    resultsContainer.innerHTML = `
      <div class="flex flex-col items-center justify-center py-12 text-white/60">
        <i class="ph-bold ph-spinner animate-spin text-3xl mb-3"></i>
        <p class="text-sm">Buscando ${searchTypeLabel} "${query}"...</p>
      </div>
    `;
    resultsContainer.classList.remove('is-empty');
    resultsContainer.classList.remove('hidden');

    if (ui.manualSearchBtn) {
      ui.manualSearchBtn.disabled = true;
    }

    try {
      const response = await searchYouTubeManual(query, 0, manualSearchAbort.signal, searchType);

      if (searchType === 'playlists') {
        // Busca de playlists
        if (!response || !response.playlists || !response.playlists.length) {
          youtubeSearchState.isLoading = false;
          resultsContainer.classList.add('is-empty');
          resultsContainer.innerHTML = `
            <div class="manual-search-empty-state flex flex-col items-center justify-center py-12 text-white/50">
              <i class="ph-bold ph-playlist text-4xl mb-3 opacity-50"></i>
              <p class="text-sm">Nenhuma playlist encontrada para "${query}"</p>
              <p class="text-xs mt-1 opacity-70">Tente outros termos de busca</p>
            </div>
          `;
          return;
        }
        
        youtubeSearchState.isLoading = false;
        renderPlaylistSearchResults(response.playlists);
      } else {
        // Busca de faixas
        if (!response || !response.videos || !response.videos.length) {
          youtubeSearchState.isLoading = false;
          resultsContainer.classList.add('is-empty');
          resultsContainer.innerHTML = `
            <div class="manual-search-empty-state flex flex-col items-center justify-center py-12 text-white/50">
              <i class="ph-bold ph-magnifying-glass text-4xl mb-3 opacity-50"></i>
              <p class="text-sm">Nenhum resultado para "${query}"</p>
              <p class="text-xs mt-1 opacity-70">Tente outros termos de busca</p>
            </div>
          `;
          return;
        }

        youtubeSearchState.results = response.videos || [];
        youtubeSearchState.hasMore = response.hasMore;
        youtubeSearchState.offset = (response.videos || []).length;
        youtubeSearchState.isLoading = false;

        renderManualSearchResults(response.videos || [], [], false);
      }

    } catch (error) {
      youtubeSearchState.isLoading = false;
      if (error.name === 'AbortError') return;
      console.error('[MANUAL SEARCH] Error:', error);
      resultsContainer.classList.remove('is-empty');
      resultsContainer.innerHTML = `
        <div class="text-center py-6 text-red-400/80 text-sm">
          Erro na busca: ${error.message}
        </div>
      `;
    } finally {
      if (ui.manualSearchBtn) {
        ui.manualSearchBtn.disabled = !ui.manualSearchInput?.value?.trim();
      }
    }
  }

  // Função auxiliar para limpar o author removendo contagem de vídeos
  function cleanPlaylistAuthor(author) {
    return (author || '').replace(/•?\s*\d+\s*(vídeos?|videos?|músicas?|musicas?|songs?)/gi, '').replace(/\s*•\s*$/, '').trim();
  }

  // Função auxiliar para gerar HTML de youtube-playlist-item
  function renderYoutubePlaylistItemHtml(playlist, extraClass = '') {
    return `
      <div class="youtube-playlist-item flex items-center gap-3 p-3 hover:bg-white/5 cursor-pointer transition-colors rounded-xl ${extraClass}" 
           data-playlist-id="${playlist.playlistId}" 
           data-title="${escapeHTML(playlist.title)}"
           data-author="${escapeHTML(cleanPlaylistAuthor(playlist.author))}"
           data-video-count="${playlist.videoCount}">
        <div class="relative flex-shrink-0">
          <img src="${playlist.thumbnail || 'assets/images/genericCover.png'}" alt="" class="w-20 h-14 object-cover rounded-lg bg-white/10" onerror="this.onerror=null;this.src='assets/images/genericCover.png'"/>
          <div class="absolute inset-0 bg-black/40 rounded-lg flex items-center justify-center">
            <i class="ph-bold ph-playlist text-white text-lg"></i>
          </div>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm text-white font-medium line-clamp-2">${escapeHTML(playlist.title)}</p>
          <p class="text-xs text-white/50 truncate mt-0.5">${escapeHTML(cleanPlaylistAuthor(playlist.author))}</p>
        </div>
        <button class="liquid-glass flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-white/90 hover:text-white transition-all duration-300 hover:scale-110 active:scale-95" 
          style="background: rgba(147, 51, 234, 0.65); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); border: 1px solid rgba(168, 85, 247, 0.3);"
          title="Importar playlist">
          <span class="liquid-glass-edge"></span>
          <i class="ph-bold ph-plus text-base"></i>
        </button>
      </div>
    `;
  }

  // Renderiza resultados de busca de playlists
  function renderPlaylistSearchResults(playlists) {
    const container = ui.manualSearchResults;
    if (!container) return;

    if (ui.youtubeEmptyState) ui.youtubeEmptyState.classList.add('hidden');
    container.classList.remove('is-empty');
    container.classList.remove('hidden');

    if (ui.youtubeSearchContent) {
      ui.youtubeSearchContent.scrollTop = 0;
    }

    const html = playlists.map((playlist, idx) => {
      let itemHtml = renderYoutubePlaylistItemHtml(playlist, idx > 0 ? 'mt-1' : '');
      // Injeta Native Banner após a 3ª playlist
      if (idx === 2 || (playlists.length < 3 && idx === playlists.length - 1)) {
        const frameId = 'ad-' + Math.random().toString(36).substr(2, 9);
        itemHtml += `
          <div class="adsterra-native-banner-wrapper" style="margin: 8px 0; width: 100%;">
            <iframe id="${frameId}" src="ad-native.html?id=${frameId}" style="width: 100%; height: 320px; border: none; overflow: hidden; transition: height 0.3s;" scrolling="no"></iframe>
          </div>
        `;
      }
      return itemHtml;
    }).join('');

    container.innerHTML = html;

    // Adiciona event listeners para playlists
    container.querySelectorAll('.youtube-playlist-item').forEach(item => {
      item.addEventListener('click', () => openYoutubePlaylistImport(item));
    });
  }

  async function loadMoreYouTubeResults() {
    if (youtubeSearchState.isLoading || !youtubeSearchState.hasMore || !youtubeSearchState.query) return;

    youtubeSearchState.isLoading = true;

    // Mostra loading no final da lista
    const resultsContainer = ui.manualSearchResults;
    if (!resultsContainer) return;

    const loadingEl = document.createElement('div');
    loadingEl.id = 'youtube-load-more-spinner';
    loadingEl.className = 'flex items-center justify-center py-6 text-white/50';
    loadingEl.innerHTML = `
      <i class="ph-bold ph-spinner animate-spin text-xl mr-2"></i>
      <span class="text-sm">Carregando mais...</span>
    `;
    resultsContainer.appendChild(loadingEl);

    try {
      const response = await searchYouTubeManual(
        youtubeSearchState.query, 
        youtubeSearchState.offset, 
        manualSearchAbort?.signal
      );

      // Remove loading spinner
      loadingEl.remove();

      if (response && response.videos && response.videos.length) {
        youtubeSearchState.results = [...youtubeSearchState.results, ...response.videos];
        youtubeSearchState.hasMore = response.hasMore;
        youtubeSearchState.offset += response.videos.length;

        renderManualSearchResults(response.videos, [], true);
      } else {
        youtubeSearchState.hasMore = false;
      }
    } catch (error) {
      loadingEl.remove();
      if (error.name !== 'AbortError') {
        console.error('[LOAD MORE] Error:', error);
      }
    } finally {
      youtubeSearchState.isLoading = false;
    }
  }

  async function searchYouTubeManual(query, offset = 0, signal, searchType = 'tracks') {
    // Usa YouTube scraping via Netlify function
    try {
      const typeParam = searchType === 'playlists' ? '&type=playlists' : '';
      const response = await fetch(ApiClient.urls.youtubeSearch(query, 10, offset, typeParam), { signal });
      if (response.ok) {
        const data = await response.json();
        // Suporta tanto o novo formato (com paginação) quanto o antigo (array direto)
        if (data && (data.videos || data.playlists)) {
          return data;
        }
        // Fallback para formato antigo (array direto)
        if (Array.isArray(data) && data.length) {
          return { videos: data.slice(0, 10), playlists: [], hasMore: false, total: data.length };
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.warn(`⚠️ [SEARCH] YouTube search failed: ${e.message}`);
    }

    return { videos: [], playlists: [], hasMore: false, total: 0 };
  }

  function renderManualSearchResults(videos, playlists = [], append = false) {
    const container = ui.manualSearchResults;
    if (!container) return;

    // Esconde empty state e mostra resultados
    if (ui.youtubeEmptyState) ui.youtubeEmptyState.classList.add('hidden');
    container.classList.remove('is-empty');
    container.classList.remove('hidden');
    
    // Reseta scroll na primeira renderização
    if (!append && ui.youtubeSearchContent) {
      ui.youtubeSearchContent.scrollTop = 0;
    }

    // Renderiza playlists primeiro (apenas na primeira renderização)
    let playlistsHtml = '';
    if (!append && playlists && playlists.length > 0) {
      playlistsHtml = `
        <div class="mb-4">
          <h3 class="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3 flex items-center gap-2">
            <i class="ph-bold ph-playlist"></i>
            Playlists
          </h3>
          <div class="space-y-2">
            ${playlists.map((playlist, idx) => {
              let itemHtml = renderYoutubePlaylistItemHtml(playlist);
              // Injeta Native Banner após a 3ª playlist
              if (idx === 2 || (playlists.length < 3 && idx === playlists.length - 1)) {
                const frameId = 'ad-' + Math.random().toString(36).substr(2, 9);
                itemHtml += `
                  <div class="adsterra-native-banner-wrapper" style="margin: 8px 0; width: 100%;">
                    <iframe id="${frameId}" src="ad-native.html?id=${frameId}" style="width: 100%; height: 320px; border: none; overflow: hidden; transition: height 0.3s;" scrolling="no"></iframe>
                  </div>
                `;
              }
              return itemHtml;
            }).join('')}
          </div>
        </div>
      `;
    }

    // Renderiza vídeos
    let videosHtml = '';
    if (videos && videos.length > 0) {
      const videosSectionHeader = !append && playlists && playlists.length > 0 ? `
        <h3 class="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3 flex items-center gap-2">
          <i class="ph-bold ph-music-notes"></i>
          Músicas
        </h3>
      ` : '';
      
      videosHtml = videos.map((video, idx) => {
        const duration = formatDuration(video.lengthSeconds * 1000);
        const thumb = video.thumbnail || `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`;
        const isFirst = !append && idx === 0 && (!playlists || playlists.length === 0);

      let videoHtml = `
          <div class="manual-search-item flex items-center gap-3 p-3 cursor-pointer transition-colors rounded-xl ${!isFirst ? 'mt-1' : ''}" 
               data-video-id="${video.videoId}" 
               data-title="${escapeHTML(video.title)}"
               data-author="${escapeHTML(video.author)}"
               data-duration="${video.lengthSeconds}"
               data-thumb="${thumb}">
            <div class="relative flex-shrink-0 w-20 h-[45px]">
              <img src="${thumb}" alt="" class="w-full h-full object-cover rounded-lg bg-white/10" onerror="this.onerror=null;this.src='assets/images/genericCover.png'"/>
              <div class="sound-wave-overlay">
                <div class="sound-wave-bar"></div>
                <div class="sound-wave-bar"></div>
                <div class="sound-wave-bar"></div>
                <div class="sound-wave-bar"></div>
              </div>
            </div>
            <div class="flex-1 min-w-0 flex flex-col justify-center">
              <p class="search-item-title text-sm text-white font-medium line-clamp-2 leading-tight m-0 p-0">${escapeHTML(video.title)}</p>
              <p class="text-xs text-white/50 truncate leading-tight m-0 p-0 mt-0.5">${escapeHTML(video.author)}</p>
            </div>
            <span class="search-item-duration text-xs text-white/40 flex-shrink-0">${duration}</span>
            <button class="add-to-playlist-btn liquid-glass flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-white/90 hover:text-white transition-all duration-300 hover:scale-110 active:scale-95" 
              style="background: rgba(255, 122, 31, 0.65); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 122, 31, 0.3);"
              title="Adicionar à playlist">
              <span class="liquid-glass-edge"></span>
              <i class="ph-bold ph-plus text-base"></i>
            </button>
          </div>
        `;

        // Injeta Native Banner após o 3º vídeo apenas na primeira busca (não na paginação)
        if (!append && (idx === 2 || (videos.length < 3 && idx === videos.length - 1))) {
          const frameId = 'ad-' + Math.random().toString(36).substr(2, 9);
          videoHtml += `
            <div class="adsterra-native-banner-wrapper" style="margin: 8px 0; width: 100%;">
              <iframe id="${frameId}" src="ad-native.html?id=${frameId}" style="width: 100%; height: 320px; border: none; overflow: hidden; transition: height 0.3s;" scrolling="no"></iframe>
            </div>
          `;
        }
        return videoHtml;
      }).join('');
      
      if (!append && playlists && playlists.length > 0) {
        videosHtml = `<div>${videosSectionHeader}${videosHtml}</div>`;
      }
    }

    if (append) {
      // Adiciona novos itens ao final
      container.insertAdjacentHTML('beforeend', videosHtml);
      // Adiciona event listeners apenas aos novos itens
      const allItems = container.querySelectorAll('.manual-search-item');
      const newItems = Array.from(allItems).slice(-videos.length);
      newItems.forEach(item => attachYouTubeSearchItemListeners(item));
    } else {
      // Substitui todo o conteúdo
      container.innerHTML = playlistsHtml + videosHtml;
      // Adiciona event listeners para vídeos
      container.querySelectorAll('.manual-search-item').forEach(item => {
        attachYouTubeSearchItemListeners(item);
      });
      // Adiciona event listeners para playlists
      container.querySelectorAll('.youtube-playlist-item').forEach(item => {
        item.addEventListener('click', () => openYoutubePlaylistImport(item));
      });
    }
  }

  function attachSeekHandlers(element, options = {}) {
    if (!element) return;

    const {
      isSeekable = () => true,
      getDurationMs = () => 0,
      onSeek = null,
      onClick = null,
      shouldIgnoreClick = null
    } = options;

    let isSeeking = false;
    let hasMoved = false;
    let startX = 0;

    const getClientX = (event, isTouch) => (isTouch ? event.touches[0].clientX : event.clientX);

    const handleSeek = (event, isTouch = false) => {
      if (!isSeekable()) return false;
      const durationMs = getDurationMs();
      if (!Number.isFinite(durationMs) || durationMs <= 0) return false;

      const rect = element.getBoundingClientRect();
      if (!rect.width) return false;

      const clientX = getClientX(event, isTouch);
      const clickX = clientX - rect.left;
      const percentage = Math.max(0, Math.min(1, clickX / rect.width));

      // No modo Vídeo, o seek é relativo à duração do clipe do YouTube.
      if (videoMode.isVideo()) {
        const ytDuration = videoMode.getDuration();
        if (ytDuration > 0) {
          const ytSeekTime = percentage * ytDuration;
          videoMode.seekTo(ytSeekTime);
          onSeek?.({ percentage, seekTime: ytSeekTime, durationMs: ytDuration * 1000, element });
          return true;
        }
      }

      const seekTime = (percentage * durationMs) / 1000;
      audio.currentTime = seekTime;
      onSeek?.({ percentage, seekTime, durationMs, element });
      return true;
    };

    const startSeek = (event, isTouch = false) => {
      if (!isSeekable()) return;
      isSeeking = true;
      hasMoved = false;
      startX = getClientX(event, isTouch);
      element.classList.add('seeking');
      if (!isTouch) {
        event.preventDefault();
      }
    };

    const moveSeek = (event, isTouch = false) => {
      if (!isSeeking) return;
      const clientX = getClientX(event, isTouch);
      const moveThreshold = 5;
      if (Math.abs(clientX - startX) > moveThreshold) {
        hasMoved = true;
        handleSeek(event, isTouch);
      }
    };

    const endSeek = () => {
      if (!isSeeking) return;
      isSeeking = false;
      element.classList.remove('seeking');
    };

    element.addEventListener('mousedown', (event) => startSeek(event));
    element.addEventListener('mousemove', (event) => moveSeek(event));
    element.addEventListener('mouseup', endSeek);
    element.addEventListener('mouseleave', endSeek);

    element.addEventListener('touchstart', (event) => startSeek(event, true), { passive: true });
    element.addEventListener('touchmove', (event) => moveSeek(event, true), { passive: true });
    element.addEventListener('touchend', endSeek);

    element.addEventListener('click', (event) => {
      if (hasMoved) {
        hasMoved = false;
        return;
      }
      if (shouldIgnoreClick?.(event)) return;
      onClick?.(event);
    });
  }

  // Adiciona event listeners para itens de busca do YouTube (incluindo seek)
  function attachYouTubeSearchItemListeners(item) {
    attachSeekHandlers(item, {
      isSeekable: () => item.dataset.videoId === youtubePlayingVideoId,
      getDurationMs: () => getSearchItemDurationMs(item),
      onSeek: ({ percentage, seekTime, durationMs, element }) => {
        // Atualiza a barra de progresso
        const progress = percentage * 100;
        element.style.setProperty('--progress', `${progress}%`);

        // Atualiza o timer
        const remainingMs = Math.max(0, durationMs - (seekTime * 1000));
        const durationEl = element.querySelector('.search-item-duration');
        if (durationEl) {
          durationEl.textContent = formatDuration(remainingMs);
        }
      },
      shouldIgnoreClick: (event) => !!event.target.closest('.add-to-playlist-btn'),
      onClick: () => playYouTubeSearchResult(item)
    });

    // Clique no botão "+" abre o modal de playlist
    const addBtn = item.querySelector('.add-to-playlist-btn');
    if (addBtn) {
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openAddToPlaylistModal(item);
      });
    }
  }

  // Função para importar playlist do YouTube
  async function openYoutubePlaylistImport(item) {
    const playlistId = item.dataset.playlistId;
    const title = item.dataset.title;
    const author = item.dataset.author;
    
    if (!playlistId) return;

    // Mostra loading no item
    const originalContent = item.innerHTML;
    item.innerHTML = `
      <div class="flex items-center justify-center w-full py-2">
        <i class="ph-bold ph-spinner animate-spin text-xl text-white/60 mr-2"></i>
        <span class="text-sm text-white/60">Carregando playlist...</span>
      </div>
    `;
    item.style.pointerEvents = 'none';

    try {
      const response = await fetch(ApiClient.urls.youtubePlaylist(playlistId));
      const data = await response.json();

      if (!data.videos || data.videos.length === 0) {
        setFeedback('Playlist vazia', 'error', {
          name: title || 'Playlist',
          cover: `https://i.ytimg.com/vi/${playlistId}/mqdefault.jpg`
        });
        item.innerHTML = originalContent;
        item.style.pointerEvents = '';
        return;
      }

      // Abre modal para confirmar importação
      openYoutubePlaylistConfirmModal(data, title, author, playlistId);
      
      // Restaura o item
      item.innerHTML = originalContent;
      item.style.pointerEvents = '';

    } catch (error) {
      console.error('[PLAYLIST IMPORT] Error:', error);
      setFeedback('Erro ao carregar', 'error', {
        name: title || 'Playlist',
        cover: `https://i.ytimg.com/vi/${playlistId}/mqdefault.jpg`
      });
      item.innerHTML = originalContent;
      item.style.pointerEvents = '';
    }
  }

  // Modal de confirmação de importação de playlist
  function openYoutubePlaylistConfirmModal(data, title, author, playlistId) {
    const videos = data.videos || [];
    const totalDuration = videos.reduce((acc, v) => acc + (v.lengthSeconds || 0), 0);
    const formattedDuration = formatDuration(totalDuration * 1000);

    // Cria modal dinamicamente
    const existingModal = document.getElementById('youtube-playlist-import-modal');
    if (existingModal) existingModal.remove();

    const modalHtml = `
      <div id="youtube-playlist-import-modal" class="fixed inset-0 overlay-blur z-[70] flex items-center justify-center p-4" style="pointer-events: auto;">
        <div class="liquid-glass relative w-full max-w-sm glass-effect rounded-3xl p-5 pt-7 overflow-hidden">
          <span class="liquid-glass-edge"></span>
          <button id="cancel-playlist-import" class="player-glass-btn absolute top-3 right-3 text-white/90 w-9 h-9 rounded-full hover:text-white flex items-center justify-center z-30 transition-all transform hover:scale-110 hover:rotate-90" aria-label="Fechar">
            <span class="liquid-glass-edge"></span>
            <i class="ph-bold ph-x text-sm"></i>
          </button>

          <div class="flex items-center gap-3 mb-4">
            <div class="w-12 h-12 rounded-xl bg-purple-500/20 flex items-center justify-center flex-shrink-0">
              <i class="ph-bold ph-playlist text-purple-400 text-lg"></i>
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="text-sm font-semibold text-white/90 line-clamp-2">${escapeHTML(title)}</h3>
              <p class="text-xs text-white/50 mt-0.5">${escapeHTML(author)}</p>
              <p class="text-[11px] text-white/40 mt-0.5">${videos.length} músicas • ${formattedDuration}</p>
            </div>
          </div>
          
          <div class="max-h-[240px] overflow-y-auto scrollbar-hide">
            <p class="text-[11px] text-white/40 mb-2 uppercase tracking-wider font-medium">Prévia</p>
            <div class="space-y-1.5">
              ${videos.slice(0, 10).map((v, i) => `
                <div class="flex items-center gap-2 text-xs">
                  <span class="text-white/25 w-4 text-right font-medium">${i + 1}</span>
                  <span class="text-white/70 truncate flex-1">${escapeHTML(v.title)}</span>
                  <span class="text-white/35 text-[11px]">${formatDuration(v.lengthSeconds * 1000)}</span>
                </div>
              `).join('')}
              ${videos.length > 10 ? `<p class="text-[11px] text-white/35 text-center mt-2">+ ${videos.length - 10} músicas</p>` : ''}
            </div>
          </div>
          
          <div class="mt-4 pt-3" style="border-top: 1px dashed rgba(255, 255, 255, 0.1);">
            <button id="confirm-playlist-import" class="w-full py-3 rounded-xl text-white font-bold text-sm transition-all hover:scale-[1.02] active:scale-95 flex items-center justify-center gap-2" style="background: rgba(147, 51, 234, 0.6); border: 1px solid rgba(147, 51, 234, 0.4); box-shadow: 0 0 20px rgba(147, 51, 234, 0.3), 0 4px 12px rgba(147, 51, 234, 0.2);">
              <i class="ph-bold ph-download-simple"></i>
              Importar playlist
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modal = document.getElementById('youtube-playlist-import-modal');
    const cancelBtn = document.getElementById('cancel-playlist-import');
    const confirmBtn = document.getElementById('confirm-playlist-import');

    cancelBtn?.addEventListener('click', () => modal.remove());
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    confirmBtn?.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = '<i class="ph-bold ph-spinner animate-spin"></i> Importando...';

      // Importa imediatamente; as capas são buscadas em segundo plano (preload)
      await importYoutubePlaylistToLibrary(videos, title);
      modal.remove();
    });
  }

  // Resolve a capa de uma faixa do YouTube no Deezer ANTES de exibi-la.
  // Nunca mantém a capa do YouTube: usa a capa do Deezer ou a genérica como fallback imediato.
  async function resolveTrackCoverFromDeezer(track) {
    if (!track) return;
    let cover = '';
    try {
      const artistLabel = getTrackArtists(track).replace(/, /g, ' ');
      cover = sanitizeImageUrl(await buscarCapaFaixa(getTrackTitle(track), artistLabel));
    } catch (_) {
      cover = '';
    }
    const finalCover = isRealCover(cover) ? cover : getFallbackCover(getTrackTitle(track));
    track.thumbnail = finalCover;
    track.album = track.album || {};
    track.album.name = track.album.name || 'YouTube';
    track.album.images = [{ url: finalCover }];
    track.generatedCover = !isRealCover(finalCover);
    track._deezerCoverResolved = true;
  }

  // Importa as músicas da playlist para a biblioteca
  async function importYoutubePlaylistToLibrary(videos, playlistTitle) {
    // Cria uma nova playlist com o nome da playlist do YouTube
    const playlistName = playlistTitle || 'YouTube Playlist';
    
    // Verifica se já existe uma playlist com esse nome
    let targetPlaylist = state.playlists.find(p => p.name === playlistName);
    const isNewPlaylist = !targetPlaylist;

    if (!targetPlaylist) {
      // Cria nova playlist (capa genérica até o Deezer resolver)
      targetPlaylist = {
        id: `yt-${Date.now()}`,
        name: playlistName,
        cover: 'assets/images/genericCover.png',
        images: [],
        tracks: []
      };
    }

    // Converte vídeos para faixas SEM a capa do YouTube (apenas dados para casar com o Deezer).
    // A capa começa genérica e é substituída pela do Deezer assim que a correspondência for resolvida.
    const newTracks = videos.map(video => ({
      name: video.title,
      artists: [{ name: video.author }],
      duration_ms: video.lengthSeconds * 1000,
      album: { name: 'YouTube', images: [] },
      thumbnail: getFallbackCover(video.title),
      generatedCover: true,
      _videoId: video.videoId,
      _fromYoutubePlaylist: true
    }));

    // Filtra duplicatas por videoId
    const existingVideoIds = new Set(targetPlaylist.tracks.filter(t => t._videoId).map(t => t._videoId));
    const tracksToAdd = newTracks.filter(t => !existingVideoIds.has(t._videoId));

    // Adiciona as faixas com capa genérica. A importação NÃO aguarda as capas:
    // a busca no Deezer acontece em segundo plano (durante o preload da playlist) e
    // substitui automaticamente as capas genéricas conforme as correspondências forem encontradas.
    targetPlaylist.tracks.push(...tracksToAdd);
    if (isNewPlaylist) {
      state.playlists.push(targetPlaylist);
    }

    // Salva no localStorage
    savePlaylistsToStorage();

    // Feedback
    const playlistCover = getPlaylistCover(targetPlaylist);
    setFeedback(`${tracksToAdd.length} músicas importadas`, 'success', {
      name: playlistName,
      cover: playlistCover,
      subtitle: `${targetPlaylist.tracks.length} faixas no total`
    });

    // Muda para a aba de biblioteca (garante que o container fique visível)
    switchPlayerTab('playlist');

    // Aguarda um frame para garantir que a aba está visível antes de renderizar
    await nextFrame();

    // Atualiza a grade de playlists
    renderPlaylists();

    // Seleciona a playlist recém-importada para exibir apenas as suas faixas
    await selectPlaylist(targetPlaylist);
  }

  // Estado temporário para o track sendo adicionado
  let pendingYouTubeTrack = null;

  // Cria um track object a partir de um item de busca
  function createTrackFromSearchItem(item) {
    const videoId = item.dataset.videoId;
    const title = item.dataset.title;
    const author = item.dataset.author;
    const duration = parseInt(item.dataset.duration, 10) || 0;
    const thumb = item.dataset.thumb || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

    return {
      name: title,
      artists: [{ name: author }],
      duration_ms: duration * 1000,
      thumbnail: thumb,
      album: { name: 'YouTube', images: [{ url: thumb }] },
      _manualSearch: true,
      _videoId: videoId
    };
  }

  // Estado da reprodução do YouTube
  let youtubePlayingVideoId = null;
  let youtubeCountdownRaf = null;

  // Helper para obter duração em ms de um elemento de busca
  function getSearchItemDurationMs(item) {
    return parseInt(item?.dataset?.duration, 10) * 1000 || 0;
  }

  // Verifica se está reproduzindo no contexto do YouTube
  function isPlayingFromYouTube() {
    return youtubePlayingVideoId && state.playingPlaylistId === 'youtube-search';
  }

  function isLibraryPlaybackActive() {
    return !!state.playingPlaylistId && state.playingPlaylistId !== 'youtube-search';
  }

  function isLibraryPlaybackVisible() {
    return isLibraryPlaybackActive() && isViewingPlayingPlaylist();
  }

  function getActiveLibraryIndex() {
    if (!isLibraryPlaybackActive()) return -1;
    return state.playingTrackIndex >= 0 ? state.playingTrackIndex : state.currentTrackIndex;
  }

  function hasLibraryPlaybackQueue() {
    return isLibraryPlaybackActive() && state.playingTracks.length > 0;
  }

  // Limpa completamente o estado de reprodução do YouTube
  function clearYouTubePlaybackState(options = {}) {
    const { updateUi = true } = options;
    const isYoutubeQueue = state.playingPlaylistId === 'youtube-search';
    const hadYoutube = !!youtubePlayingVideoId || isYoutubeQueue;

    youtubePlayingVideoId = null;
    stopYouTubeSearchCountdown();
    updateYouTubeSearchHighlight();

    if (isYoutubeQueue) {
      state.playingPlaylistId = null;
      state.playingTrackIndex = -1;
      state.playingTracks = [];
    }

    if (hadYoutube && updateUi) {
      updateUiState();
    }
  }

  // Helper para resetar progresso e duração de um item de busca
  function resetSearchItemProgress(item) {
    if (!item) return;
    item.style.setProperty('--progress', '0%');
    const durationEl = item.querySelector('.search-item-duration');
    if (durationEl) {
      durationEl.textContent = formatDuration(getSearchItemDurationMs(item));
    }
  }

  // Helper para obter todos os itens de busca do YouTube
  function getYouTubeSearchItems() {
    return Array.from(ui.manualSearchResults?.querySelectorAll('.manual-search-item') || []);
  }

  // Helper para encontrar o índice do item de busca atual
  function getCurrentYouTubeSearchIndex(allItems) {
    if (youtubePlayingVideoId) {
      return allItems.findIndex(item => item.dataset.videoId === youtubePlayingVideoId);
    }
    if (state.playingPlaylistId === 'youtube-search' && state.playingTrackIndex >= 0) {
      return state.playingTrackIndex;
    }
    return -1;
  }

  // Atualiza o visual do item de busca ativo
  function updateYouTubeSearchHighlight() {
    const isActuallyPlaying = isAudioPlaying();
    
    document.querySelectorAll('.manual-search-item').forEach(item => {
      const videoId = item.dataset.videoId;
      const isActive = videoId === youtubePlayingVideoId;
      
      item.classList.toggle('active', isActive);
      item.classList.toggle('playing', isActive && isActuallyPlaying);
    });
  }

  // Atualiza o progresso e timer do item de busca
  function updateYouTubeSearchProgress() {
    if (!youtubePlayingVideoId || !state.isPlaying || audio.paused) {
      youtubeCountdownRaf = null;
      return;
    }

    const item = document.querySelector(`.manual-search-item[data-video-id="${youtubePlayingVideoId}"]`);
    if (!item) {
      youtubeCountdownRaf = null;
      return;
    }

    const durationMs = getSearchItemDurationMs(item);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      youtubeCountdownRaf = null;
      return;
    }

    const currentMs = audio.currentTime * 1000;
    const remainingMs = Math.max(0, durationMs - currentMs);
    const progress = Math.min(100, (currentMs / durationMs) * 100);

    // Atualiza a barra de progresso
    item.style.setProperty('--progress', `${progress}%`);

    // Atualiza o timer
    const durationEl = item.querySelector('.search-item-duration');
    if (durationEl) {
      durationEl.textContent = formatDuration(remainingMs);
    }

    youtubeCountdownRaf = requestAnimationFrame(updateYouTubeSearchProgress);
  }

  function startYouTubeSearchCountdown() {
    stopYouTubeSearchCountdown();
    if (!youtubePlayingVideoId || !state.isPlaying) return;
    updateYouTubeSearchProgress();
  }

  function stopYouTubeSearchCountdown() {
    if (youtubeCountdownRaf) {
      cancelAnimationFrame(youtubeCountdownRaf);
      youtubeCountdownRaf = null;
    }
  }

  // Reproduz uma música da busca do YouTube
  async function playYouTubeSearchResult(item, isRetry = false) {
    const videoId = item.dataset.videoId;
    if (!videoId) return;

    // Cria o track a partir do item clicado
    const track = createTrackFromSearchItem(item);

    // Coleta todos os itens de busca
    const allItems = getYouTubeSearchItems();
    const allTracks = allItems.map(createTrackFromSearchItem);
    const clickedIndex = allTracks.findIndex(t => t._videoId === videoId);

    // Atualiza o estado de reprodução do YouTube
    youtubePlayingVideoId = videoId;
    
    // Atualiza APENAS o estado de reprodução (não o estado de visualização)
    state.playingTrackIndex = clickedIndex;
    state.playingTracks = allTracks;
    state.playingPlaylistId = 'youtube-search';
    
    // Não sobrescreve state.tracks, state.currentTrackIndex ou state.currentPlaylist
    // para não afetar a visualização da playlist atual
    stopPlaybackCountdown({ resetLabel: false });

    // Atualiza o visual
    updateYouTubeSearchHighlight();

    // Mostra loading
    item.classList.add('loading');

    try {
      // Limpa cache se for retry
      if (isRetry) {
        state.audioCache.delete(videoId);
      }

      // Busca o áudio
      const audioUrl = await getTrackAudioUrl(track, clickedIndex);
      
      if (!audioUrl) {
        item.classList.remove('loading');
        
        // Se não for retry, tenta mais uma vez
        if (!isRetry) {
          return playYouTubeSearchResult(item, true);
        }
        
        // Se já foi retry, avança para próxima
        youtubePlayingVideoId = null;
        updateYouTubeSearchHighlight();
        playNextYouTubeSearchResult();
        return;
      }

      // Reproduz
      setAudioSource(audioUrl);
      await audio.play();
      
      state.isPlaying = true;
      updateUiState();
      startYouTubeSearchCountdown();
      
    } catch (error) {
      console.error('Erro ao reproduzir:', error);
      item.classList.remove('loading');
      
      // Se não for retry, tenta mais uma vez
      if (!isRetry) {
        return playYouTubeSearchResult(item, true);
      }
      
      // Se já foi retry, avança para próxima
      youtubePlayingVideoId = null;
      updateYouTubeSearchHighlight();
      playNextYouTubeSearchResult();
    } finally {
      item.classList.remove('loading');
    }
  }

  // Toca a música anterior da busca do YouTube
  function playPreviousYouTubeSearchResult() {
    const allItems = getYouTubeSearchItems();
    
    // Encontra o índice atual baseado no estado ou no videoId
    const currentIndex = getCurrentYouTubeSearchIndex(allItems);

    // Reseta o timer do item atual
    const currentItem = allItems[currentIndex];
    resetSearchItemProgress(currentItem);

    // Encontra o item anterior
    const prevIndex = currentIndex - 1;
    if (prevIndex >= 0) {
      const prevItem = allItems[prevIndex];
      playYouTubeSearchResult(prevItem);
    } else if (repeatEnabled && allItems.length > 0) {
      // Se repeat está ativo, volta para o último
      const lastItem = allItems[allItems.length - 1];
      playYouTubeSearchResult(lastItem);
    }
  }

  // Toca a próxima música da busca do YouTube
  function playNextYouTubeSearchResult() {
    const allItems = getYouTubeSearchItems();
    
    // Encontra o índice atual baseado no estado ou no videoId
    const currentIndex = getCurrentYouTubeSearchIndex(allItems);

    // Reseta o timer do item atual
    const currentItem = allItems[currentIndex];
    resetSearchItemProgress(currentItem);

    // Encontra o próximo item
    const nextIndex = currentIndex + 1;
    if (nextIndex < allItems.length) {
      const nextItem = allItems[nextIndex];
      playYouTubeSearchResult(nextItem);
    } else {
      // Fim da lista
      clearYouTubePlaybackState();
    }
  }

  // Abre o modal para adicionar à playlist
  function openAddToPlaylistModal(item) {
    const videoId = item.dataset.videoId;
    const title = item.dataset.title;

    if (!videoId) return;

    // Guarda o track para adicionar depois
    pendingYouTubeTrack = createTrackFromSearchItem(item);

    // Abre o modal de seleção de playlist
    openPlaylistPicker(title);
  }

  function openPlaylistPicker(trackName) {
    if (!ui.playlistPickerModal || !ui.playlistPickerCard) return;

    // Atualiza o nome da faixa no header
    if (ui.playlistPickerTrack) {
      ui.playlistPickerTrack.textContent = trackName;
    }

    // Renderiza lista de playlists
    renderPlaylistPickerList();

    // Esconde form de nova playlist
    hideNewPlaylistForm();

    // Remove inert e mostra modal
    ui.playlistPickerModal.removeAttribute('inert');
    openScaledModal(ui.playlistPickerModal, ui.playlistPickerCard);
    ui.playlistPickerModal.classList.add('opacity-100');
  }

  function closePlaylistPicker() {
    if (!ui.playlistPickerModal || !ui.playlistPickerCard) return;

    ui.playlistPickerModal.classList.add('opacity-0');
    ui.playlistPickerCard.classList.add('scale-95');
    ui.playlistPickerCard.classList.remove('scale-100');

    setTimeout(() => {
      ui.playlistPickerModal.classList.add('invisible');
      ui.playlistPickerModal.classList.remove('opacity-100');
      ui.playlistPickerModal.setAttribute('inert', '');
    }, 200);

    pendingYouTubeTrack = null;
  }

  function renderPlaylistPickerList() {
    if (!ui.playlistPickerList) return;

    const playlists = state.playlists || [];

    if (!playlists.length) {
      ui.playlistPickerList.innerHTML = `
        <div class="text-center py-6 text-white/40 text-sm">
          <i class="ph-bold ph-playlist text-2xl mb-2 block opacity-50"></i>
          Nenhuma playlist ainda.<br/>Crie uma nova abaixo.
        </div>
      `;
      return;
    }

    ui.playlistPickerList.innerHTML = playlists.map((playlist, idx) => {
      const trackCount = getPlaylistTrackCount(playlist);
      const cover = playlist.cover || getFallbackCover();

      return `
        <div class="playlist-picker-item flex items-center gap-3 p-2 hover:bg-white/5 rounded-xl cursor-pointer transition-colors" data-playlist-index="${idx}">
          <img src="${cover}" alt="" class="w-12 h-12 rounded-lg object-cover bg-white/10" onerror="this.src='${getFallbackCover()}'"/>
          <div class="flex-1 min-w-0">
            <p class="text-sm text-white font-medium truncate">${escapeHTML(playlist.name)}</p>
            <p class="text-xs text-white/40">${trackCount} ${trackCount === 1 ? 'música' : 'músicas'}</p>
          </div>
          <div class="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-white/90 hover:text-white transition-all duration-300 hover:scale-110 active:scale-95" style="background: rgba(255, 122, 31, 0.6); box-shadow: 0 4px 12px rgba(255, 122, 31, 0.3), 0 0 2px rgba(255, 255, 255, 0.25) inset; border: 1px solid rgba(255, 122, 31, 0.4);">
            <i class="ph-bold ph-plus text-base"></i>
          </div>
        </div>
      `;
    }).join('');

    // Event listeners
    ui.playlistPickerList.querySelectorAll('.playlist-picker-item').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.playlistIndex, 10);
        addTrackToPlaylist(idx);
      });
    });
  }

  async function addTrackToPlaylist(playlistIndex) {
    if (!pendingYouTubeTrack) return;

    const playlist = state.playlists[playlistIndex];
    if (!playlist) return;

    // Inicializa tracks se necessário
    if (!playlist.tracks) playlist.tracks = [];

    // Verifica se já existe uma faixa com o mesmo videoId
    const isDuplicate = playlist.tracks.some(t =>
      t._videoId && t._videoId === pendingYouTubeTrack._videoId
    );

    if (isDuplicate) {
      setFeedback('Já está na playlist', 'warning', {
        ...getTrackFeedbackInfo(pendingYouTubeTrack),
        subtitle: playlist.name
      });
      closePlaylistPicker();
      return;
    }

    // Resolve a capa no Deezer ANTES de adicionar/exibir (nunca usa a capa do YouTube)
    await resolveTrackCoverFromDeezer(pendingYouTubeTrack);

    // Adiciona a faixa à playlist
    playlist.tracks.unshift(pendingYouTubeTrack);

    // Atualiza a capa do mosaico (artes do Deezer) se for playlist importada do YouTube
    if (isYoutubeImportedPlaylist(playlist)) {
      await refreshPlaylistMosaicCover(playlist);
    }

    // Salva no localStorage
    savePlaylistsToStorage();

    // Feedback
    setFeedback('Adicionada à playlist', 'success', {
      ...getTrackFeedbackInfo(pendingYouTubeTrack),
      subtitle: playlist.name
    });

    // Fecha o modal picker
    closePlaylistPicker();

    // Troca para a aba Playlist
    switchPlayerTab('playlist');

    // Aguarda um frame para garantir que a aba está visível
    await nextFrame();

    // Atualiza o carrossel
    renderPlaylists();

    // Seleciona a playlist (passa o objeto, não o índice) e toca a música
    await selectPlaylist(playlist);
    await playTrack(0);
  }

  function showNewPlaylistForm() {
    if (ui.newPlaylistForm) ui.newPlaylistForm.classList.remove('hidden');
    if (ui.showNewPlaylistBtn) ui.showNewPlaylistBtn.classList.add('hidden');
    if (ui.newPlaylistName) {
      ui.newPlaylistName.value = '';
      setTimeout(() => ui.newPlaylistName.focus(), 100);
    }
  }

  function hideNewPlaylistForm() {
    if (ui.newPlaylistForm) ui.newPlaylistForm.classList.add('hidden');
    if (ui.showNewPlaylistBtn) ui.showNewPlaylistBtn.classList.remove('hidden');
  }

  async function createNewPlaylistAndAdd() {
    const name = ui.newPlaylistName?.value?.trim();
    if (!name || !pendingYouTubeTrack) return;

    // Resolve a capa no Deezer ANTES de criar/exibir (nunca usa a capa do YouTube)
    await resolveTrackCoverFromDeezer(pendingYouTubeTrack);

    // Cria nova playlist com ID único
    const newPlaylist = {
      id: `yt-playlist-${Date.now()}`,
      name: name,
      // A capa é resolvida via Deezer no enriquecimento; usa a genérica até lá
      cover: 'assets/images/genericCover.png',
      images: [],
      tracks: [pendingYouTubeTrack]
    };

    // Adiciona ao início da lista
    state.playlists.unshift(newPlaylist);

    // Monta a capa do mosaico (artes do Deezer); com 1 faixa, usa a capa genérica
    await refreshPlaylistMosaicCover(newPlaylist);

    // Fecha modal picker
    closePlaylistPicker();

    // Troca para a aba Playlist (para que o container esteja visível)
    switchPlayerTab('playlist');

    // Atualiza UI das playlists e scrolla para a nova playlist
    // Aguarda um frame para garantir que a aba está visível
    await nextFrame();
    renderPlaylists(state.playlists, true);

    // Seleciona a nova playlist (passa o objeto) e toca
    await selectPlaylist(newPlaylist);
    await playTrack(0);
  }

  /**
   * Consulta o Deezer via function dedicada no backend (/deezer).
   * Sem dependência de proxies públicos; a function tem cache próprio.
   */
  async function fetchDeezerViaBackend(query, type = 'track') {
    const startedAt = Date.now();
    try {
      const response = await fetchWithTimeout(ApiClient.urls.deezer(type, query), 12000);
      const elapsed = Date.now() - startedAt;

      if (!response.ok) {
        const errBody = await response.json().catch(() => null);
        console.warn(`⚠️ [COVER] Backend Deezer falhou: HTTP ${response.status}, motivo=${errBody?.reason || 'desconhecido'}, q="${query}" (${elapsed}ms)`);
        return null;
      }

      const data = await response.json();
      return data;
    } catch (error) {
      const motivo = error.name === 'AbortError' ? 'timeout' : error.message;
      console.warn(`⚠️ [COVER] Backend Deezer erro: ${motivo}, q="${query}" (${Date.now() - startedAt}ms)`);
      return null;
    }
  }

  async function fetchDeezerSearch(query, allowReset = true) {
    if (state.coverSuspendedUntil && Date.now() < state.coverSuspendedUntil) {
      return null;
    }

    // Produção / netlify dev: usa exclusivamente a function dedicada (sem proxies públicos)
    if (backendAvailable) {
      const backendData = await fetchDeezerViaBackend(query, 'track');
      if (backendData) {
        state.coverFailureStreak = 0;
        return backendData;
      }
      state.coverFailureStreak += 1;
      if (state.coverFailureStreak >= COVER_FAILURE_THRESHOLD) {
        state.coverSuspendedUntil = Date.now() + COVER_SUSPEND_MS;
        console.warn(`⏳ [COVER] Suspenso por ${Math.round(COVER_SUSPEND_MS / 1000)}s após falhas consecutivas`);
      }
      return null;
    }

    // Dev local puro (sem functions): proxies públicos apenas como recurso de desenvolvimento
    const errors = [];
    const baseUrl = `https://api.deezer.com/search?q=${encodeURIComponent(query)}`;
    const orderedProxies = (() => {
      const list = [...DEEZER_PROXIES];
      if (state.coverLastSuccessProxy) {
        const idx = list.findIndex(builder => builder(baseUrl).id === state.coverLastSuccessProxy);
        if (idx > 0) {
          const [p] = list.splice(idx, 1);
          list.unshift(p);
        }
      }
      return list;
    })();

    let tried = 0;
    for (const build of orderedProxies) {
      const { id, url } = build(baseUrl);
      if (isCoverProxyBlocked(id) || isCoverProxyCooling(id)) continue;

      tried += 1;
      try {
        // Timeouts por proxy: netlify-proxy é mais confiável, allorigins é sensível
        const timeout = id === 'netlify-proxy' ? 12000 : id === 'allorigins' ? 6000 : 10000;
        const response = await fetchWithTimeout(url, timeout);
        if (!response.ok) {
          const count = (state.coverProxyFailCount.get(id) || 0) + 1;
          state.coverProxyFailCount.set(id, count);
          const shouldBlock = response.status === 429 || response.status === 408 || (response.status === 403 && count >= 2) || count >= 3;
          if (!((id === 'allorigins') && response.status === 499)) {
            errors.push(`${id}: HTTP ${response.status}`);
          }
          if (response.status === 429) {
            setCoverProxyCooldown(id, 8000);
          }
          if (shouldBlock) {
            blockCoverProxy(id, `HTTP ${response.status}`);
          }
          continue;
        }

        const text = await response.text();
        let parsedData = null;
        let parseOk = false;

        const tryParseJson = (payload) => {
          const candidate = payload?.trim();
          if (!candidate || (!candidate.startsWith('{') && !candidate.startsWith('['))) return null;
          const parsed = JSON.parse(candidate);
          return parsed?.contents ? JSON.parse(parsed.contents) : parsed;
        };

        parsedData = tryParseJson(text);

        // Para o proxy jina (retorna markdown/texto), tenta extrair o primeiro bloco JSON
        if (!parsedData && id === 'jina') {
          const first = text.indexOf('{');
          const last = text.lastIndexOf('}');
          if (first !== -1 && last !== -1 && last > first) {
            const snippet = text.slice(first, last + 1);
            parsedData = tryParseJson(snippet);
          }
        }

        if (!parsedData) {
          errors.push(`${id}: non-json response`);
          const count = (state.coverProxyFailCount.get(id) || 0) + 1;
          state.coverProxyFailCount.set(id, count);
          if (count >= 2 && id !== 'jina') {
            blockCoverProxy(id, 'invalid-json', 3 * 60 * 1000);
          }
          continue;
        }

        parseOk = true;
        if (parseOk) {
          state.coverLastSuccessProxy = id;
          resetCoverProxyFail(id);
          return parsedData;
        }
      } catch (error) {
        const msg = (error.message || '').toLowerCase();
        const isAbortNoise = (id === 'allorigins' && msg.includes('abort')) || (id === 'jina' && msg.includes('unexpected token'));
        if (!isAbortNoise) {
          errors.push(`${id}: ${error.message || 'erro desconhecido'}`);
          const count = (state.coverProxyFailCount.get(id) || 0) + 1;
          state.coverProxyFailCount.set(id, count);
          if (msg.includes('failed to fetch') || msg.includes('name_not_resolved') || msg.includes('timeout')) {
            if (count >= 2) blockCoverProxy(id, msg);
          } else if (msg.includes('abort')) {
            if (count >= 3) blockCoverProxy(id, msg);
          } else if (msg.includes('403') && id === 'corsproxy' && count >= 2) {
            blockCoverProxy(id, msg);
          }
        } else {
          errors.push(`${id}: aborted (ignored)`);
        }
        continue;
      }
    }

    if (tried === 0 && state.coverProxyBlock.size && allowReset) {
      resetCoverProxies('no-available-proxy');
      return await fetchDeezerSearch(query, false);
    }
    const allBlocked = orderedProxies.every(build => isCoverProxyBlocked(build(baseUrl).id));
    if (allBlocked && allowReset) {
      resetCoverProxies('all-blocked-retry');
      return await fetchDeezerSearch(query, false);
    }

    if (errors.length) {
      state.coverFailureStreak += 1;
    }
    if (state.coverFailureStreak >= COVER_FAILURE_THRESHOLD) {
      state.coverSuspendedUntil = Date.now() + COVER_SUSPEND_MS;
      console.warn(`⏳ [COVER] Suspenso por ${Math.round(COVER_SUSPEND_MS / 1000)}s após falhas consecutivas`);
    }

    const errorMsg = errors.length ? errors.join(' | ') : 'no proxies available';
    console.warn(`⚠️ [COVER] Deezer search failed after retries: ${errorMsg}`);
    return null;
  }

  // Scores mínimos para aceitar uma capa (0..1) — melhor capa genérica do que capa errada
  const COVER_MIN_SCORE = 0.5;
  const PLAYLIST_COVER_MIN_SCORE = 0.6;

  async function buscarCapaPlaylist(playlistName) {
    const normalizedName = normalizeQuery(playlistName);
    if (!normalizedName) return null;

    const cacheKey = `playlist:${normalizedName}`.toLowerCase();
    const cached = getCoverCache(cacheKey);
    if (cached) return cached;

    // Respeita a suspensão global de buscas de capas (mesma política de fetchDeezerSearch)
    if (state.coverSuspendedUntil && Date.now() < state.coverSuspendedUntil) {
      return null;
    }

    const startedAt = Date.now();
    const normTarget = normalizeForAudioMatch(normalizedName);

    // Helper: escolhe a melhor playlist do resultado usando similaridade de tokens
    // (mesmo pipeline de normalização/score usado nas capas de faixas e no 4shared)
    const pickBestPlaylistCover = (parsed) => {
      if (!parsed?.data?.length || !normTarget) return null;
      const best = parsed.data
        .map(pl => {
          const normTitle = normalizeForAudioMatch(pl.title || '');
          let score = tokenDiceSimilarity(normTarget, normTitle);
          // Bônus quando um nome contém o outro por inteiro (ex: "workout" vs "workout mix")
          if (normTitle && (normTitle.includes(normTarget) || normTarget.includes(normTitle))) {
            score = Math.max(score, 0.7);
          }
          return {
            cover: pl.picture_xl || pl.picture_big || pl.picture_medium || null,
            score,
            title: pl.title
          };
        })
        .filter(entry => entry.cover)
        .sort((a, b) => b.score - a.score)[0];
      return (best?.cover && best.score >= PLAYLIST_COVER_MIN_SCORE) ? best : null;
    };

    // Produção / netlify dev: usa exclusivamente a function dedicada
    if (backendAvailable) {
      const parsed = await fetchDeezerViaBackend(normalizedName, 'playlist');
      if (!parsed) {
        // Falha de backend/rede: alimenta o streak para a suspensão global funcionar
        state.coverFailureStreak += 1;
        if (state.coverFailureStreak >= COVER_FAILURE_THRESHOLD) {
          state.coverSuspendedUntil = Date.now() + COVER_SUSPEND_MS;
          console.warn(`⏳ [COVER] Suspenso por ${Math.round(COVER_SUSPEND_MS / 1000)}s após falhas consecutivas`);
        }
        return null;
      }

      state.coverFailureStreak = 0;
      const best = pickBestPlaylistCover(parsed);
      if (best) {
        console.log(`🖼️ [COVER] Capa de playlist: "${best.title}" (score ${(best.score * 100).toFixed(0)}%) para "${normalizedName}" (${Date.now() - startedAt}ms)`);
        setCoverCache(cacheKey, best.cover);
        return best.cover;
      }

      // Resposta obtida mas sem correspondência confiável: cacheia o fallback
      // para não repetir a mesma busca a cada renderização (miss definitivo)
      console.warn(`⚠️ [COVER] Nenhuma capa de playlist confiável para "${normalizedName}" (${Date.now() - startedAt}ms)`);
      setCoverCache(cacheKey, getFallbackCover());
      return null;
    }

    // Dev local puro: proxies públicos apenas como recurso de desenvolvimento
    try {
      const baseUrl = `https://api.deezer.com/search/playlist?q=${encodeURIComponent(normalizedName)}`;
      const orderedProxies = [...DEEZER_PROXIES];

      for (const build of orderedProxies) {
        const { id, url } = build(baseUrl);
        if (isCoverProxyBlocked(id) || isCoverProxyCooling(id)) continue;

        try {
          // Timeouts por proxy: netlify-proxy é mais confiável
          const timeout = id === 'netlify-proxy' ? 12000 : id === 'allorigins' ? 6000 : 8000;
          const response = await fetchWithTimeout(url, timeout);

          if (!response.ok) {
            const count = (state.coverProxyFailCount.get(id) || 0) + 1;
            state.coverProxyFailCount.set(id, count);
            if (count >= 2) blockCoverProxy(id, `HTTP ${response.status}`);
            continue;
          }

          const raw = await response.text();
          const cleanRaw = raw.trim().replace(/^\)\]\}'/, '').trim();
          let parsed = JSON.parse(cleanRaw);

          // Desembrulha AllOrigins se necessário
          parsed = unwrapAllOriginsResponse(parsed);

          const best = pickBestPlaylistCover(parsed);
          if (best) {
            setCoverCache(cacheKey, best.cover);
            state.coverProxyFailCount.set(id, 0);
            return best.cover;
          }
        } catch (error) {
          const msg = (error?.message || '').toLowerCase();
          const count = (state.coverProxyFailCount.get(id) || 0) + 1;
          state.coverProxyFailCount.set(id, count);
          const isCors = msg.includes('cors') || msg.includes('access-control');
          const isTimeout = msg.includes('timeout') || msg.includes('abort');
          if (!isCors && count >= 2) {
            blockCoverProxy(id, msg || 'playlist-cover-error');
          } else if (isTimeout && count >= 3) {
            blockCoverProxy(id, 'timeout');
          }
        }
      }
    } catch (error) {
      // Silencioso
    }

    return null;
  }

  async function buscarCapaFaixa(nome, artista = '') {
    const trackName = normalizeQuery(nome);
    const artistName = normalizeQuery(artista);
    if (!trackName) return null;

    const cacheKey = `${trackName}|${artistName}`.toLowerCase();
    const cached = getCoverCache(cacheKey);
    if (cached) {
      return cached;
    }

    // Durante suspensão global (muitas falhas), devolve o fallback SEM cachear,
    // para que a capa real seja tentada de novo quando a suspensão terminar
    if (state.coverSuspendedUntil && Date.now() < state.coverSuspendedUntil) {
      return getFallbackCover();
    }

    const startedAt = Date.now();
    const cleanTitle = cleanTrackTitle(trackName);
    const cleanArtist = normalizeString(artistName);

    // Extrai as partes quando o nome vem como "Parte1 - Parte2" (comum em faixas do YouTube).
    // Padrões: "Parte1 - Parte2", "Parte1 | Parte2", "Parte1 – Parte2", "Parte1 — Parte2"
    let part1 = '';
    let part2 = '';
    const separatorMatch = trackName.match(/^(.+?)\s*[-|–—]\s*(.+)$/);
    if (separatorMatch) {
      part1 = cleanTrackTitle(separatorMatch[1]);
      part2 = cleanTrackTitle(separatorMatch[2]);
    }

    // Estratégias de busca, da mais específica à mais genérica (sem duplicatas)
    const queries = [...new Set([
      // Assume "Artista - Música"
      part1 && part2 ? `track:"${part2}" artist:"${part1}"` : null,
      // Artista informado (pode ser o nome do canal)
      cleanArtist ? `track:"${part2 || cleanTitle}" artist:"${cleanArtist}"` : null,
      // Assume "Música - Artista"
      part1 && part2 ? `track:"${part1}" artist:"${part2}"` : null,
      // Assume "Música - Info" (só a primeira parte como título)
      part1 ? `track:"${part1}"` : null,
      part2 && part2 !== cleanTitle ? `track:"${part2}"` : null,
      // Título limpo completo
      `track:"${cleanTitle}"`,
      // Buscas genéricas (sem operadores) como último recurso
      part1 && part2 ? `${part1} ${part2}` : null,
      cleanArtist ? `${cleanTitle} ${cleanArtist}` : cleanTitle
    ].filter(Boolean))];

    // Interpretações possíveis de (título, artista) para pontuar os resultados,
    // normalizadas com o MESMO pipeline do matching de áudio (consistência com o 4shared)
    const interpretationSeeds = [
      { title: cleanTitle, artist: cleanArtist },
      part1 && part2 ? { title: part2, artist: part1 } : null, // "Artista - Título"
      part1 && part2 ? { title: part1, artist: part2 } : null, // "Título - Artista"
      part1 ? { title: part1, artist: cleanArtist } : null,
      part2 ? { title: part2, artist: cleanArtist } : null
    ].filter(Boolean);

    const seenInterps = new Set();
    const interpretations = [];
    for (const seed of interpretationSeeds) {
      const title = normalizeForAudioMatch(seed.title);
      const artist = seed.artist ? normalizeForAudioMatch(seed.artist) : '';
      if (!title) continue;
      const k = `${title}|${artist}`;
      if (seenInterps.has(k)) continue;
      seenInterps.add(k);
      interpretations.push({ title, artist });
    }

    // Pontua um item do Deezer contra todas as interpretações e fica com a melhor
    // (título pesa 60%, artista 40% — mesmos pesos do score do 4shared)
    const scoreCoverItem = (item) => {
      const itemTitle = normalizeForAudioMatch(item.title_short || item.title || '');
      const itemArtist = normalizeForAudioMatch(item.artist?.name || '');
      let best = { score: 0, titleSim: 0, artistSim: 0 };
      if (!itemTitle) return best;
      for (const interp of interpretations) {
        const titleSim = tokenDiceSimilarity(interp.title, itemTitle);
        const artistSim = (interp.artist && itemArtist) ? tokenDiceSimilarity(interp.artist, itemArtist) : 0;
        const score = interp.artist
          ? (titleSim * 0.6) + (artistSim * 0.4)
          : titleSim;
        if (score > best.score) best = { score, titleSim, artistSim };
      }
      return best;
    };

    let deezerData = null;
    let gotResponse = false;
    let queryUsed = '';
    for (const q of queries) {
      try {
        const result = await fetchDeezerSearch(q);
        if (result) gotResponse = true;
        if (result?.data?.length) {
          deezerData = result;
          queryUsed = q;
          break;
        }
      } catch (_) { }
    }

    if (deezerData?.data?.length) {
      const best = deezerData.data
        .map(item => ({
          ...scoreCoverItem(item),
          cover: item.album?.cover_xl || item.album?.cover_big || item.album?.cover_medium || null,
          title: item.title_short || item.title || '',
          artist: item.artist?.name || ''
        }))
        .filter(entry => entry.cover && entry.score > 0)
        .sort((a, b) => b.score - a.score)[0];

      if (best?.cover && best.score >= COVER_MIN_SCORE) {
        console.log(`🖼️ [COVER] Capa aceita: "${best.title}" - "${best.artist}" (score ${(best.score * 100).toFixed(0)}%, título ${(best.titleSim * 100).toFixed(0)}%, artista ${(best.artistSim * 100).toFixed(0)}%) para "${trackName}" via ${queryUsed} (${Date.now() - startedAt}ms)`);
        setCoverCache(cacheKey, best.cover);
        state.coverFailureStreak = 0;
        return best.cover;
      }

      if (best) {
        console.warn(`⚠️ [COVER] Melhor candidato rejeitado por score baixo: "${best.title}" - "${best.artist}" (score ${(best.score * 100).toFixed(0)}% < ${COVER_MIN_SCORE * 100}%) para "${trackName}" - "${artistName}" (${Date.now() - startedAt}ms)`);
      }
    }

    const fallback = getFallbackCover();
    if (gotResponse) {
      // Miss definitivo (Deezer respondeu, mas sem correspondência confiável):
      // cacheia o fallback para não repetir as mesmas buscas
      console.warn(`❌ [COVER] Nenhuma capa confiável para "${trackName}" - "${artistName}", usando capa padrão (${Date.now() - startedAt}ms)`);
      setCoverCache(cacheKey, fallback);
    } else {
      // Falha transitória (rede/suspensão): NÃO cacheia, para tentar de novo depois
      console.warn(`⚠️ [COVER] Busca de capa indisponível para "${trackName}" (falha transitória), usando capa padrão sem cache (${Date.now() - startedAt}ms)`);
    }
    return fallback;
  }

  // Controle de concorrência para geração de mosaicos
  let mosaicGenerationInProgress = 0;
  const MAX_CONCURRENT_MOSAICS = 2;

  async function gerarCapaPlaylist(listaDeCapas = []) {
    const sources = (listaDeCapas || []).map(sanitizeImageUrl).filter(Boolean).slice(0, 4);
    if (!sources.length) return null;

    // Limita concorrência para evitar crash de memória
    if (mosaicGenerationInProgress >= MAX_CONCURRENT_MOSAICS) {
      await delay(500);
      if (mosaicGenerationInProgress >= MAX_CONCURRENT_MOSAICS) {
        return null; // Desiste se ainda estiver ocupado
      }
    }

    mosaicGenerationInProgress++;

    // Tamanho reduzido para economizar memória
    const size = 300;
    const cell = size / 2;
    let canvas = null;
    let ctx = null;

    const loadImage = (src) => new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.referrerPolicy = 'no-referrer';
      const timeout = setTimeout(() => {
        img.src = '';
        reject(new Error('Timeout'));
      }, 5000);
      img.onload = () => { clearTimeout(timeout); resolve(img); };
      img.onerror = () => { clearTimeout(timeout); reject(new Error('Erro ao carregar')); };
      img.src = src;
    });

    try {
      canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      ctx = canvas.getContext('2d');

      const images = [];
      for (const src of sources) {
        try {
          const img = await loadImage(src);
          images.push(img);
        } catch (error) {
          // Ignora imagens que falharam
        }
      }

      if (!images.length) {
        return null;
      }

      images.slice(0, 4).forEach((img, index) => {
        const x = (index % 2) * cell;
        const y = Math.floor(index / 2) * cell;
        ctx.drawImage(img, x, y, cell, cell);
      });

      const dataUrl = canvas.toDataURL('image/jpeg', 0.8); // JPEG com qualidade 80% é menor
      return dataUrl;
    } catch (error) {
      console.warn(`⚠️ [COVER] Falha ao gerar mosaico: ${error.message}`);
      return null;
    } finally {
      // Limpa recursos
      mosaicGenerationInProgress--;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        canvas = null;
      }
      ctx = null;
    }
  }

  // Helper para obter elemento de track pelo índice
  function getTrackElement(index) {
    if (!ui.tracksContainer || index < 0) return null;
    return ui.tracksContainer.querySelector(`[data-track-index="${index}"]`);
  }

  function updateTrackCardCover(index, coverUrl) {
    if (!Number.isInteger(index) || index < 0) return;
    const img = getTrackElement(index)?.querySelector('img');
    if (!img) return;

    const currentSrc = img.getAttribute('src');
    if (currentSrc === coverUrl) return;

    img.setAttribute('src', coverUrl);
    img.style.opacity = '0';
    requestAnimationFrame(() => {
      img.style.transition = 'opacity 180ms ease';
      img.style.opacity = '1';
    });
  }

  function updatePlaylistCardCover(playlistId, coverUrl) {
    if (!ui.myPlaylistsGrid || !playlistId) return;
    const img = ui.myPlaylistsGrid.querySelector(`.my-playlist-card[data-playlist-id="${playlistId}"] img`);
    if (!img) return;

    const currentSrc = img.getAttribute('src');
    if (currentSrc === coverUrl) return;
    img.setAttribute('src', coverUrl);
  }

  // Helper para atualizar capa da playlist no state e na UI
  function setPlaylistCover(playlist, coverUrl) {
    if (!playlist || !coverUrl) return;
    playlist.images = [{ url: coverUrl }];
    updatePlaylistCardCover(playlist.id, coverUrl);
  }

  // Quantidade mínima de capas válidas para gerar o mosaico (geradas progressivamente durante o preload).
  // O mosaico é criado assim que houver 4 ou mais capas válidas.
  const PLAYLIST_MOSAIC_MIN = 4;
  const WATCH_LATER_MOSAIC_MIN = 4;

  // Identifica playlists importadas do YouTube (id começa com "yt-")
  function isYoutubeImportedPlaylist(playlist) {
    return typeof playlist?.id === 'string' && playlist.id.startsWith('yt-');
  }

  // Playlists cuja capa é um mosaico montado a partir das capas das faixas
  function isMosaicCoverPlaylist(playlist) {
    return !!playlist && (playlist.id === WATCH_LATER_PLAYLIST_ID || isYoutubeImportedPlaylist(playlist));
  }

  // Mínimo de capas válidas para gerar o mosaico desta playlist
  function getMosaicMinCovers(playlist) {
    return playlist?.id === WATCH_LATER_PLAYLIST_ID ? WATCH_LATER_MOSAIC_MIN : PLAYLIST_MOSAIC_MIN;
  }

  // (Re)gera a capa de uma playlist como mosaico 2x2 a partir das capas (artes de álbum) das faixas.
  // O mosaico é gerado assim que houver o mínimo de capas válidas; caso contrário usa a capa genérica.
  // Pode ser chamada repetidamente durante o preload: a assinatura evita regerações desnecessárias.
  async function refreshPlaylistMosaicCover(playlist) {
    if (!playlist) return;

    const minCovers = getMosaicMinCovers(playlist);
    const realCovers = (playlist.tracks || [])
      .map(track => getTrackCoverUrl(track))
      .filter(isRealCover);
    const unique = [...new Set(realCovers)];
    const canGenerate = unique.length >= minCovers;

    // As 4 capas efetivamente usadas no mosaico 2x2
    const mosaicSources = unique.slice(0, 4);

    // Assinatura: quando pode gerar, depende só das 4 capas do mosaico (estável depois de definidas,
    // mesmo que novas capas surjam); enquanto não atinge o mínimo, depende da contagem.
    const signature = canGenerate ? `m:${mosaicSources.join('|')}` : `g:${unique.length}`;
    if (signature === playlist._coverSignature) return;

    // Ainda sem capas suficientes: usa a capa genérica
    if (!canGenerate) {
      playlist._coverSignature = signature;
      playlist.images = [];
      playlist.coverSources = [];
      updatePlaylistCardCover(playlist.id, getFallbackCover(playlist.name));
      return;
    }

    // Marca a assinatura de forma otimista para evitar regenerações concorrentes idênticas
    playlist._coverSignature = signature;
    try {
      const mosaic = await gerarCapaPlaylist(mosaicSources);
      if (mosaic) {
        playlist.coverSources = mosaicSources;
        setPlaylistCover(playlist, mosaic);
        return;
      }
    } catch (error) {
      console.warn(`⚠️ [COVER] Falha ao gerar mosaico da playlist "${playlist.name}": ${error.message}`);
    }

    // Falha (transitória): libera a assinatura para nova tentativa e preserva um mosaico já existente;
    // só usa a genérica se ainda não houver mosaico.
    playlist._coverSignature = null;
    if (!isMosaicCover(playlist.images?.[0]?.url)) {
      playlist.images = [];
      playlist.coverSources = [];
      updatePlaylistCardCover(playlist.id, getFallbackCover(playlist.name));
    }
  }

  // Mantém o mural de capas da "Músicas Favoritas" consistente com suas faixas
  async function refreshWatchLaterCover() {
    const watchLater = getWatchLaterPlaylist();
    if (!watchLater) return;
    await refreshPlaylistMosaicCover(watchLater);
  }

  // Helper para verificar se a sessão de importação ainda é válida
  function isImportSessionStale(importSessionId) {
    return importSessionId && importSessionId !== state.currentImportSessionId;
  }

  function applyCoverToStateAndUi(track, coverUrl, importSessionId = state.currentImportSessionId) {
    if (!track || !coverUrl) return;
    if (isImportSessionStale(importSessionId)) return;

    const playlist = state.playlists.find(p => Array.isArray(p?.tracks) && p.tracks.includes(track));
    const hasValidCover = isRealCover(coverUrl);

    if (playlist) {
      if (!Array.isArray(playlist.coverSources)) playlist.coverSources = [];
      if (hasValidCover && !playlist.coverSources.includes(coverUrl)) {
        playlist.coverSources.unshift(coverUrl);
        playlist.coverSources = playlist.coverSources.slice(0, 4);
      }

      // Geração progressiva do mosaico: assim que houver capas válidas suficientes durante o
      // preload, o mosaico é criado/atualizado automaticamente (sem aguardar todas as faixas).
      if (hasValidCover && isMosaicCoverPlaylist(playlist)) {
        refreshPlaylistMosaicCover(playlist);
      }
    }

    const trackIndex = state.tracks.indexOf(track);
    if (trackIndex >= 0) {
      updateTrackCardCover(trackIndex, coverUrl);
    }

    // Se a capa recém-resolvida é da faixa em reprodução, atualiza fundo/barras.
    const { track: playingTrack } = getCurrentPlayingTrack();
    if (playingTrack && playingTrack === track && hasValidCover) {
      updateControlsBar();
    }
  }

  async function fetchPlaylistCoverFromTracks(playlist, importSessionId = state.currentImportSessionId) {
    if (!playlist || !Array.isArray(playlist.tracks)) return null;
    if (isImportSessionStale(importSessionId)) return null;

    const candidates = playlist.tracks.slice(0, 6);
    for (const track of candidates) {
      if (!track) continue;
      const title = getTrackTitle(track);
      const artistLabel = getTrackArtists(track).replace(/, /g, ' ');
      if (!title) continue;

      try {
        const cover = await buscarCapaFaixa(title, artistLabel);
        const safeCover = sanitizeImageUrl(cover);
        if (isRealCover(safeCover)) {
          return safeCover;
        }
      } catch (error) {
        console.warn(`⚠️ [COVER] Falha ao buscar capa para playlist "${playlist.name}" via faixa "${title}": ${error.message}`);
      }
    }

    return null;
  }

  async function enrichPlaylistsWithCovers(playlists = [], importSessionId = state.currentImportSessionId) {
    if (!Array.isArray(playlists) || !playlists.length) return playlists;

    for (const playlist of playlists) {
      if (!playlist) continue;
      if (isImportSessionStale(importSessionId)) break;

      // A capa da "Músicas Favoritas" é gerenciada por refreshWatchLaterCover (mural das faixas)
      if (playlist.id === WATCH_LATER_PLAYLIST_ID) continue;

      // Playlists do YouTube: capa sempre montada com as artes de álbum do Deezer (mosaico)
      if (isYoutubeImportedPlaylist(playlist)) {
        await refreshPlaylistMosaicCover(playlist);
        continue;
      }

      const isPreset = isPresetPlaylistName(playlist.name);
      const currentCover = playlist.images?.[0]?.url || '';
      const playlistDefinedCover = isRealCover(playlist.cover);
      const hasValidCover = isRealCover(currentCover);

      // Se já tem capa definida na playlist ou capa real, pula
      if (playlistDefinedCover || hasValidCover) continue;

      // Prioridade 1: playlistCover real (capa específica da playlist)
      const playlistCover = sanitizeImageUrl(playlist.playlistCover);
      if (isRealCover(playlistCover)) {
        setPlaylistCover(playlist, playlistCover);
        continue;
      }

      // Prioridade 2: preset cover (apenas se não houver playlistCover)
      const presetCover = sanitizeImageUrl(getPresetCoverForPlaylist(playlist.name));
      if (presetCover) {
        setPlaylistCover(playlist, presetCover);
        continue;
      }

      // Se for preset mas não tem capa preset, usa fallback e não gera mosaico
      if (isPreset) {
        setPlaylistCover(playlist, getFallbackCover(playlist.name));
        continue;
      }

      const coverSources = (playlist.tracks || [])
        .map(track => getTrackCoverUrl(track))
        .filter(isRealCover)
        .slice(0, 4);

      if (!playlist.images?.length && !coverSources.length) {
        const fetchedCover = await fetchPlaylistCoverFromTracks(playlist, importSessionId);
        if (fetchedCover) {
          setPlaylistCover(playlist, fetchedCover);
          if (!playlist.coverSources) playlist.coverSources = [];
          playlist.coverSources.unshift(fetchedCover);
          playlist.coverSources = playlist.coverSources.slice(0, 4);
          continue;
        }
      }

      // Gera mosaico se houver múltiplas capas
      if (coverSources.length > 1) {
        try {
          const mosaic = await gerarCapaPlaylist(coverSources);
          if (mosaic) {
            playlist.coverSources = coverSources;
            setPlaylistCover(playlist, mosaic);
            continue;
          }
        } catch (error) {
          console.warn(`⚠️ [COVER] Falha ao gerar mosaico: ${error.message}`);
        }
      }

      // Usa capa única se houver apenas uma (mesmo que já tenha fallback)
      if (coverSources.length === 1) {
        setPlaylistCover(playlist, coverSources[0]);
        continue;
      }

      setPlaylistCover(playlist, getFallbackCover(playlist.name));
    }

    if (importSessionId === state.currentImportSessionId && state.playlists.length) {
      renderPlaylists();
    }

    return playlists;
  }

  // Coleta as URLs que representam a CAPA DA PLAYLIST das playlists que contêm as
  // faixas informadas. Usado para detectar faixas que herdaram a capa da playlist
  // (importações antigas) e não possuem capa individual.
  function getCurrentPlaylistCoverUrls(tracks = []) {
    const urls = new Set();
    const add = (u) => { const s = sanitizeImageUrl(u); if (s) urls.add(s); };
    const consider = (p) => { if (p) add(p.playlistCover); };
    consider(state.currentPlaylist);
    for (const p of state.playlists) {
      if (p?.tracks?.length && p.tracks.some(t => tracks.includes(t))) consider(p);
    }
    return urls;
  }

  async function enrichTracksWithCovers(tracks = [], importSessionId = state.currentImportSessionId) {
    if (!tracks.length) return tracks;

    if (!state.playlistCoversReady && state.playlistCoverPromise) {
      try {
        await state.playlistCoverPromise;
      } catch (_) { /* ignore */ }
    }

    if (!state.playlistUiApplied && state.playlistUiAppliedPromise) {
      try {
        await state.playlistUiAppliedPromise;
      } catch (_) { /* ignore */ }
    }

    const concurrency = 1;
    let index = 0;
    let coversResolved = false; // houve capa real recuperada que precisa ser persistida?
    let resolvedSinceSave = 0;  // controle de flush incremental para o localStorage

    // URLs que representam a CAPA DA PLAYLIST. Uma faixa cujo thumbnail seja igual
    // a uma dessas URLs NÃO tem capa própria (herdou a da playlist em importações
    // antigas) e deve ser re-enriquecida para recuperar sua arte individual.
    const playlistCoverUrls = getCurrentPlaylistCoverUrls(tracks);

    async function worker() {
      while (index < tracks.length) {
        const currentIndex = index++;
        const track = tracks[currentIndex];
        if (!track) continue;

        const youtubeTrack = isYoutubeTrack(track);

        // Se o thumbnail é, na verdade, a capa da playlist, limpa para não ser
        // considerado capa individual (nem exibido no lugar da arte real).
        const thumbSan = sanitizeImageUrl(track.thumbnail);
        if (thumbSan && playlistCoverUrls.has(thumbSan)) {
          track.thumbnail = '';
          if (track.album?.images?.length) {
            track.album.images = track.album.images.filter(img => sanitizeImageUrl(img?.url) !== thumbSan);
          }
          const trackIndex = state.tracks.indexOf(track);
          if (trackIndex >= 0) updateTrackCardCover(trackIndex, getFallbackCover(getTrackTitle(track)));
        }

        const hasRealCover = track.thumbnail
          && !track.generatedCover
          && !isFallbackCover(track.thumbnail)
          && !isGeneratedCover(track.thumbnail);

        // Faixas do YouTube sempre buscam a capa no Deezer (mesmo com thumbnail do YouTube),
        // exceto quando a correspondência já foi resolvida nesta sessão.
        if (youtubeTrack) {
          if (track._deezerCoverResolved) continue;
        } else if (hasRealCover) {
          continue;
        }

        const artistLabel = getTrackArtists(track).replace(/, /g, ' ');
        try {
          const cover = await buscarCapaFaixa(getTrackTitle(track), artistLabel);
          const safeCover = sanitizeImageUrl(cover);
          if (safeCover) {
            track.thumbnail = safeCover;
            track.album = track.album || {};
            track.album.images = [{ url: safeCover }];
            track.generatedCover = isFallbackCover(safeCover);
            applyCoverToStateAndUi(track, safeCover, importSessionId);
            // Marca para persistir apenas quando uma capa REAL foi obtida, para
            // que o reload recupere a arte original (e não a capa genérica).
            if (!track.generatedCover) {
              coversResolved = true;
              resolvedSinceSave++;
              // Flush incremental: como o enriquecimento é contínuo (delay curto
              // entre faixas), o debounce nunca dispararia. Salvamos a cada N
              // capas resolvidas para que o progresso sobreviva a um reload.
              if (resolvedSinceSave >= 4 && !isImportSessionStale(importSessionId)) {
                resolvedSinceSave = 0;
                savePlaylistsToStorage();
              }
            }
          }
          if (youtubeTrack) track._deezerCoverResolved = true;
        } catch (error) {
          console.warn(`⚠️ [COVER] Erro ao enriquecer faixa "${track.name}": ${error.message}`);
        }
        const coverDelay = state.coverLastSuccessProxy === 'jina' ? 400 : 250;
        await delay(coverDelay); // evitar saturar proxies
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    // Persiste as capas reais recuperadas para que sobrevivam ao reload da página.
    // (As capas resolvidas no enriquecimento só existiam em memória/DOM antes.)
    // Salva imediatamente (não via debounce) para garantir a gravação do lote final.
    if (coversResolved && !isImportSessionStale(importSessionId)) {
      savePlaylistsToStorage();
    }

    return tracks;
  }

  async function refreshCoversAfterEnrichment(importSessionId) {
    if (!state.playlistsLoaded || isImportSessionStale(importSessionId)) return;

    let playlistsUpdated = false;

    for (const playlist of state.playlists) {
      if (!playlist?.tracks?.length) continue;

      // "Músicas Favoritas": mural composto exclusivamente pelas capas das faixas da playlist
      // (nunca por busca de nome no Deezer, que traz capas que não correspondem às faixas)
      if (playlist.id === WATCH_LATER_PLAYLIST_ID) {
        await refreshPlaylistMosaicCover(playlist);
        continue;
      }

      // Playlists do YouTube: capa sempre montada com as artes de álbum do Deezer (mosaico)
      if (isYoutubeImportedPlaylist(playlist)) {
        await refreshPlaylistMosaicCover(playlist);
        continue;
      }

      const isPreset = isPresetPlaylistName(playlist.name);
      
      // Se a playlist já tem uma capa definida (não genérica), pula
      const playlistDefinedCover = isRealCover(playlist.cover) && !playlist.cover.includes('genericCover');
      if (playlistDefinedCover) continue;

      // Tentar buscar capa real da playlist do Deezer se ainda não tiver
      if (!playlist.playlistCover && !isPreset) {
        try {
          const deezerCover = await buscarCapaPlaylist(playlist.name);
          if (isRealCover(deezerCover)) {
            playlist.playlistCover = deezerCover;
          }
        } catch (error) {
          // Silencioso
        }
      }

      const playlistCover = sanitizeImageUrl(playlist.playlistCover);
      const hasPlaylistCover = isRealCover(playlistCover);

      const trackSources = playlist.tracks
        .map(track => getTrackCoverUrl(track))
        .filter(isRealCover)
        .slice(0, 4);

      const realSources = trackSources;
      playlist.coverSources = realSources.length ? realSources : [];

      const currentCover = playlist.images?.[0]?.url || '';
      const hasMosaicCover = currentCover && isMosaicCover(currentCover);
      const hasSavedSources = Array.isArray(playlist.coverSources) && playlist.coverSources.length > 1;
      const hasRealCover = currentCover
        && !isFallbackCover(currentCover)
        && !isGeneratedCover(currentCover)
        && !isMosaicCover(currentCover);

      if (hasPlaylistCover && currentCover !== playlistCover) {
        setPlaylistCover(playlist, playlistCover);
        playlistsUpdated = true;
        continue;
      }

      // Se já tem playlistCover, não precisa gerar mosaico
      if (hasPlaylistCover) continue;

      // Mantém mosaico existente (preservar capa gerada)
      if (hasMosaicCover) {
        // Se não havia coverSources, salve as detectadas agora para futuros refresh
        if (!hasSavedSources && realSources.length > 1) {
          playlist.coverSources = realSources;
        }
        continue;
      }

      if (hasRealCover) continue;

      if (isPreset) {
        const fallbackSrc = getFallbackCover(playlist.name);
        if (!currentCover || isMosaicCover(currentCover)) {
          playlist.images = [{ url: fallbackSrc }];
          playlistsUpdated = true;
        }
        continue;
      }

      // Substitui capa atual se houver múltiplas capas (mesmo que já tenha mosaico/fallback)
      if (realSources.length > 1) {
        const needsUpdate = isFallbackCover(currentCover) || isGeneratedCover(currentCover) || isMosaicCover(currentCover) || !currentCover;
        if (needsUpdate) {
          try {
            const mosaic = await gerarCapaPlaylist(realSources);
            if (mosaic) {
              setPlaylistCover(playlist, mosaic);
              playlistsUpdated = true;
              continue;
            }
          } catch (error) {
            console.warn(`⚠️ [COVER] Falha ao atualizar mosaico: ${error.message}`);
          }
        }
      }

      // Substitui capa atual se houver apenas uma capa (mesmo que já tenha fallback)
      if (realSources.length === 1) {
        const single = realSources[0];
        if (single && (isFallbackCover(currentCover) || isGeneratedCover(currentCover) || !currentCover)) {
          setPlaylistCover(playlist, single);
          playlistsUpdated = true;
          continue;
        }
      }

      if (!hasMosaicCover) { // não sobrescrever mosaico existente mesmo sem fontes novas
        setPlaylistCover(playlist, getFallbackCover(playlist.name));
        playlistsUpdated = true;
      }
    }

    if (isImportSessionStale(importSessionId)) return;

    if (playlistsUpdated) {
      renderPlaylists();
    }

    if (state.currentPlaylist) {
      refreshTracksView();
    }
  }

  function parseDurationToMs(value) {
    if (!value) return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    const text = String(value).trim();
    if (!text) return null;

    // Try integer ms
    const numeric = Number(text);
    if (Number.isFinite(numeric)) {
      // Heuristic: values larger than 1000 are likely ms, otherwise seconds
      return numeric > 1000 ? numeric : numeric * 1000;
    }

    // Try mm:ss or hh:mm:ss
    const parts = text.split(':').map(Number);
    if (parts.every(p => Number.isFinite(p))) {
      let seconds = 0;
      if (parts.length === 3) {
        const [hh, mm, ss] = parts;
        seconds = (hh * 3600) + (mm * 60) + ss;
      } else if (parts.length === 2) {
        const [mm, ss] = parts;
        seconds = (mm * 60) + ss;
      } else if (parts.length === 1) {
        seconds = parts[0];
      }
      return seconds * 1000;
    }

    return null;
  }

  function parseCsvText(text) {
    const content = (text || '').replace(/^\uFEFF/, '').trim();
    if (!content) return { headers: [], rows: [] };

    const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
    if (!lines.length) return { headers: [], rows: [] };

    const delimiterGuess = (() => {
      const comma = (lines[0].match(/,/g) || []).length;
      const semicolon = (lines[0].match(/;/g) || []).length;
      return semicolon > comma ? ';' : ',';
    })();

    const parseLine = (line) => {
      const result = [];
      let current = '';
      let inQuotes = false;

      for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
          if (inQuotes && line[i + 1] === '"') {
            current += '"';
            i++;
            continue;
          }
          inQuotes = !inQuotes;
          continue;
        }

        if (char === delimiterGuess && !inQuotes) {
          result.push(current);
          current = '';
          continue;
        }

        current += char;
      }

      result.push(current);
      return result.map(cell => cell.trim());
    };

    const rows = lines.map(parseLine);
    const headers = rows.shift() || [];
    const dataRows = rows.filter(row => row.some(cell => cell && cell.trim() !== ''));
    return { headers, rows: dataRows };
  }

  async function buildPlaylistsFromTracks(tracks = []) {
    const map = new Map();
    tracks.forEach((track) => {
      const playlistName = track.playlistName || 'Playlist importada';
      if (!map.has(playlistName)) {
        map.set(playlistName, {
          id: `csv-${playlistName}-${map.size + 1}-${Date.now()}`,
          name: playlistName,
          images: [],
          tracks: [],
          coverSources: [],
          playlistCover: null
        });
      }
      const playlist = map.get(playlistName);
      playlist.tracks.push(track);

      if (!track.thumbnail) {
        track.thumbnail = getFallbackCover(getTrackTitle(track));
        track.generatedCover = true;
      }

      const playlistImage = sanitizeImageUrl(track.playlistImage);
      if (playlistImage && !playlist.playlistCover && isRealCover(playlistImage)) {
        playlist.playlistCover = playlistImage;
      }

      const cover = getTrackCoverUrl(track);
      if (cover && !track.generatedCover && isRealCover(cover)) {
        playlist.coverSources.push(cover);
      }
    });

    const playlists = Array.from(map.values());

    // Buscar capas de playlist do Deezer para playlists sem preset
    const playlistCoverPromises = playlists
      .filter(pl => !isPresetPlaylistName(pl.name) && !pl.playlistCover)
      .map(async (pl) => {
        try {
          const cover = await buscarCapaPlaylist(pl.name);
          if (isRealCover(cover)) {
            pl.playlistCover = cover;
          }
        } catch (error) {
          // Silencioso
        }
      });

    await Promise.all(playlistCoverPromises);

    // Preload de 4 capas de faixas para playlists sem preset
    const trackCoverPromises = playlists
      .filter(pl => !isPresetPlaylistName(pl.name) && !pl.playlistCover)
      .map(async (pl) => {
        const tracksToPreload = pl.tracks.slice(0, 4);
        const coverPromises = tracksToPreload.map(async (track) => {
          try {
            const artistNames = getTrackArtists(track);
            const cover = await buscarCapaFaixa(getTrackTitle(track), artistNames);
            if (isRealCover(cover)) {
              return cover;
            }
          } catch (error) {
            // Silencioso
          }
          return null;
        });

        const covers = (await Promise.all(coverPromises)).filter(Boolean);
        if (covers.length > 0) {
          pl.coverSources = [...covers, ...pl.coverSources];
        }
      });

    await Promise.all(trackCoverPromises);

    for (const playlist of playlists) {
      const isPreset = isPresetPlaylistName(playlist.name);
      
      // Se a playlist já tem uma capa definida (não genérica), pula
      const playlistDefinedCover = isRealCover(playlist.cover) && !playlist.cover.includes('genericCover');
      if (playlistDefinedCover) {
        playlist.images = [{ url: playlist.cover }];
        continue;
      }

      // Prioridade 1: playlistCover real (capa específica da playlist)
      if (playlist.playlistCover) {
        const cleanCover = sanitizeImageUrl(playlist.playlistCover);
        if (isRealCover(cleanCover)) {
          playlist.images = [{ url: cleanCover }];
          continue;
        }
      }

      // Prioridade 2: preset cover (apenas se não houver playlistCover)
      const presetCover = sanitizeImageUrl(getPresetCoverForPlaylist(playlist.name));
      if (presetCover) {
        playlist.images = [{ url: presetCover }];
        continue;
      }

      // Se for preset mas não tem capa preset, usa fallback e pula geração de mosaico
      if (isPreset) {
        playlist.images = [{ url: getFallbackCover(playlist.name) }];
        continue;
      }

      const coverSources = (playlist.coverSources || [])
        .map(sanitizeImageUrl)
        .filter(isRealCover)
        .slice(0, 4);

      // Gera mosaico se houver múltiplas capas
      if (coverSources.length > 1) {
        try {
          const mosaic = await gerarCapaPlaylist(coverSources);
          if (mosaic) {
            playlist.images = [{ url: mosaic }];
            continue;
          }
        } catch (error) {
          console.warn(`⚠️ [COVER] Falha ao gerar mosaico: ${error.message}`);
        }
      }

      // Usa capa única se houver apenas uma
      if (coverSources.length === 1) {
        playlist.images = [{ url: coverSources[0] }];
        continue;
      }

      if (!playlist.images?.length) {
        const fallbackSrc = getFallbackCover(playlist.name);
        playlist.images = [{ url: fallbackSrc }];
      }
    }

    return playlists;
  }

  function normalizeCsvRows(rows, headers, fallbackPlaylistName) {
    const columns = detectColumns(headers);

    const getCell = (row, index) => {
      if (index === -1 || index === undefined || index === null) return '';
      return (row[index] || '').trim();
    };

    return rows.map((row, index) => {
      const title = getCell(row, columns.title) || getCell(row, 0);
      const artistRaw = getCell(row, columns.artist);
      const album = getCell(row, columns.album);
      const thumbnail = sanitizeImageUrl(getCell(row, columns.image));
      const isrc = getCell(row, columns.isrc);
      const playlistName = getCell(row, columns.playlist) || fallbackPlaylistName || 'Playlist importada';
      const playlistImageRaw = getCell(row, columns.playlistImage);
      const playlistImage = sanitizeImageUrl(playlistImageRaw);
      const durationMs = parseDurationToMs(getCell(row, columns.durationMs) || getCell(row, columns.duration));

      if (!title && !artistRaw) return null;

      const artists = (artistRaw || '').split(/[;,&|]/).map(a => a.trim()).filter(Boolean);

      return {
        id: isrc || `${title || artistRaw || 'track'}-${index}`,
        name: title || artistRaw || 'Faixa sem título',
        title: title || '',
        artists: artists.length ? artists.map(name => ({ name })) : [{ name: artistRaw || '' }].filter(a => a.name),
        // IMPORTANTE: nunca usar a capa da playlist como capa da faixa. Faixas sem
        // capa própria ficam sem thumbnail para que o enriquecimento resolva a
        // arte individual (a capa da playlist é derivada em separado via playlistImage).
        album: {
          name: album || '',
          images: thumbnail ? [{ url: thumbnail }] : []
        },
        thumbnail: thumbnail || '',
        isrc: isrc || '',
        playlistName,
        playlistImage,
        duration_ms: durationMs
      };
    }).filter(Boolean);
  }

  async function importPlaylistFromCsv(file) {
    if (!file) return;

    state.importInProgress = true;
    const importSessionId = Date.now();
    state.currentImportSessionId = importSessionId;
    state.playlistCoverPromise = null;
    state.playlistCoversReady = false;
    state.playlistUiAppliedPromise = null;
    state.playlistUiApplied = false;
    
    const fileName = file.name.replace(/\.csv$/i, '');
    
    setFeedback('Carregando...', 'info', {
      name: fileName,
      cover: getFallbackCover(file.name)
    });

    // Verifica tamanho do arquivo (máximo 50MB)
    const MAX_FILE_SIZE = 50 * 1024 * 1024;
    if (file.size > MAX_FILE_SIZE) {
      setFeedback('Arquivo muito grande', 'error', {
        name: fileName,
        subtitle: 'Máximo 50MB'
      });
      console.error(`❌ [IMPORT] Arquivo muito grande: ${(file.size / 1024 / 1024).toFixed(2)}MB`);
      state.importInProgress = false;
      return;
    }

    try {
      const text = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = (e) => {
          const errorMsg = reader.error?.message || 'Erro desconhecido';
          console.error(`❌ [IMPORT] FileReader error:`, reader.error);
          reject(new Error(`Erro ao ler arquivo: ${errorMsg}`));
        };
        reader.onabort = () => reject(new Error('Leitura do arquivo foi cancelada'));
        try {
          reader.readAsText(file, 'UTF-8');
        } catch (readError) {
          reject(new Error(`Erro ao iniciar leitura: ${readError.message}`));
        }
      });

      const { headers, rows } = parseCsvText(text);
      if (!rows.length) {
        setFeedback('Playlist vazia', 'error', {
          name: fileName,
          subtitle: 'Nenhuma faixa encontrada'
        });
        if (state.playlistsLoaded && state.tracks.length) {
          renderTracks(state.tracks);
        }
        console.error(`❌ [IMPORT] CSV inválido: vazio`);
        return;
      }

      const normalizedTracks = normalizeCsvRows(rows, headers, getPlaylistNameFromFile(file.name));

      if (!normalizedTracks.length) {
        setFeedback('Formato inválido', 'error', {
          name: fileName,
          subtitle: 'Verifique o arquivo CSV'
        });
        if (state.playlistsLoaded && state.tracks.length) {
          renderTracks(state.tracks);
        }
        console.error(`❌ [IMPORT] CSV inválido: sem faixas reconhecíveis`);
        return;
      }

      const playlists = await buildPlaylistsFromTracks(normalizedTracks);

      if (!playlists.length) {
        setFeedback('Playlist vazia', 'error', {
          name: fileName,
          subtitle: 'Nenhuma faixa encontrada'
        });
        console.error(`❌ [IMPORT] Nenhuma playlist reconhecida`);
        return;
      }

      // Resetar caches e estado
      resetPlaybackState({ resetTrackIndex: true, clearTracks: false, clearCaches: true });

      // Preserva a playlist "Músicas Favoritas" e adiciona as novas
      const watchLater = loadWatchLaterPlaylist();
      state.playlists = [watchLater, ...playlists];
      state.playlistsLoaded = true;
      state.currentPlaylist = null;
      state.tracks = [];

      state.playlistCoverPromise = enrichPlaylistsWithCovers(state.playlists, importSessionId);
      try {
        await state.playlistCoverPromise;
      } finally {
        state.playlistCoversReady = true;
      }

      renderPlaylists();
      updatePlaylistEmptyState();

      // Salva playlists no storage
      debouncedSave();

      selectPlaylist(state.playlists[0], false, { preloadAudio: false });

      state.playlistUiAppliedPromise = waitForNextFrame().then(() => {
        state.playlistUiApplied = true;
      });
      try {
        await state.playlistUiAppliedPromise;
      } catch (_) { /* ignore */ }

      const coverEnrichmentPromise = enrichTracksWithCovers(state.tracks.length ? state.tracks : normalizedTracks, importSessionId)
        .catch(error => console.warn(`⚠️ [COVER] Enriquecimento parcial falhou: ${error.message}`));
      coverEnrichmentPromise.then(() => {
        refreshCoversAfterEnrichment(importSessionId);
      });

      if (normalizedTracks.length) {
        const tracksToPreload = state.tracks.length ? state.tracks : normalizedTracks;
        preloadTracksInBackground(tracksToPreload, state.currentPlaylist?.id);
      }

      const importedPlaylist = state.playlists[1] || state.playlists[0];
      const playlistCover = getPlaylistCover(importedPlaylist);
      setFeedback('Importada com sucesso', 'success', {
        name: importedPlaylist?.name || 'Playlist',
        cover: playlistCover,
        subtitle: `${normalizedTracks.length} faixas`
      });
    } catch (error) {
      console.error(`❌ [IMPORT] CSV inválido: ${error.message}`);
      setFeedback('Erro na importação', 'error', {
        name: fileName,
        subtitle: 'Verifique o arquivo CSV'
      });
      if (state.playlistsLoaded && state.tracks.length) {
        renderTracks(state.tracks);
      }
    } finally {
      state.importInProgress = false;
    }
  }

  function renderPlaylists() {
    if (!ui.myPlaylistsGrid || !ui.myPlaylistsSection) return;

    if (!state.playlists || state.playlists.length === 0) {
      ui.myPlaylistsSection.style.display = 'none';
      ui.myPlaylistsGrid.innerHTML = '';
      updatePlaylistEmptyState();
      return;
    }

    ui.myPlaylistsSection.style.display = 'block';

    ui.myPlaylistsGrid.innerHTML = state.playlists.map(playlist => {
      const trackCount = getPlaylistTrackCount(playlist);
      const isWatchLater = playlist.id === WATCH_LATER_PLAYLIST_ID;

      // Usa o mural gerado (armazenado em images). Enquanto o mural não estiver pronto,
      // mostra a capa da primeira faixa como placeholder apenas se a playlist tiver 4+ faixas.
      let imageUrl = getPlaylistCover(playlist);
      if (isWatchLater && !playlist.images?.length && trackCount >= 4 && playlist.tracks?.[0]) {
        imageUrl = getTrackCoverUrl(playlist.tracks[0]) || imageUrl;
      }

      return `
        <div class="my-playlist-card special-playlist-card group cursor-pointer rounded-xl overflow-hidden bg-white/5 hover:bg-white/10 transition-all duration-300 ring-1 ring-white/10 relative${isWatchLater ? ' playlist-card-fixed' : ''}" 
             data-playlist-id="${playlist.id}">
          <div class="relative aspect-square">
            <img src="${imageUrl}" 
                 alt="${playlist.name}" 
                 class="w-full h-full object-cover"
                 onerror="this.onerror=null;this.src='assets/images/genericCover.png'">
            <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent"></div>
            ${!isWatchLater ? `
            <button class="delete-playlist-btn liquid-glass absolute top-2 right-2 w-8 h-8 bg-black/70 rounded-full flex items-center justify-center z-10 hover:bg-red-500/90 shadow-lg" title="Excluir Playlist">
              <span class="liquid-glass-edge"></span>
              <i class="ph-bold ph-trash text-white text-[14px]"></i>
            </button>
            ` : `
            <div class="absolute top-2 right-2">
              <i class="ph-fill ph-heart text-red-500 text-lg drop-shadow-lg"></i>
            </div>
            `}
            <div class="discover-play-wrapper">
              <button class="my-playlist-play-btn discover-play-circle liquid-glass" style="--btn-color: #f97316;">
                <span class="liquid-glass-edge"></span>
                <i class="ph-fill ph-play discover-play-icon"></i>
              </button>
            </div>
            <div class="absolute bottom-0 left-0 right-0 p-3">
              <p class="text-white font-semibold text-sm truncate">${playlist.name}</p>
              <p class="text-white/60 text-xs">${trackCount} músicas</p>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Event listeners para as playlists
    ui.myPlaylistsGrid.querySelectorAll('.my-playlist-card').forEach(card => {
      const playlistId = card.dataset.playlistId;
      const playlist = state.playlists.find(p => p.id === playlistId);

      if (!playlist) return;

      const deleteBtn = card.querySelector('.delete-playlist-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          deletePlaylist(playlistId);
        });
      }

      // Clique no card ou no play - seleciona e vai para a tela de biblioteca
      const clickHandler = (e) => {
        // No modo de reordenação, o clique não navega (evita conflito com arrastar)
        if (playlistsReorderMode) return;

        e.stopPropagation();
        
        // Se clicou no botão play
        const isPlayBtn = e.target.closest('.my-playlist-play-btn');
        
        // Vai para a aba biblioteca (que mostrará as tracks da playlist selecionada)
        if (ui.tabPlaylist) {
          ui.tabPlaylist.click();
        }
        
        if (isPlayBtn || (!state.currentPlaylist || state.currentPlaylist.id !== playlist.id)) {
          selectPlaylist(playlist, isPlayBtn);
        }
      };

      card.addEventListener('click', clickHandler);
    });

    updatePlaylistEmptyState();

    // Mantém o mural de capas da "Músicas Favoritas" consistente com suas faixas
    refreshWatchLaterCover();

    // Reaplica o modo de reordenação após re-render (ex.: após excluir uma playlist)
    if (playlistsReorderMode) {
      applyPlaylistsReorderUi();
    }
  }

  // ===== Reordenação das playlists (my-playlists-section) =====
  let playlistsReorderMode = false;
  let myPlaylistsSortable = null;

  function togglePlaylistsReorderMode() {
    if (playlistsReorderMode) {
      exitPlaylistsReorderMode();
    } else {
      enterPlaylistsReorderMode();
    }
  }

  function enterPlaylistsReorderMode() {
    if (playlistsReorderMode) return;
    // Sem playlists de usuário (apenas favoritos) não há o que reordenar
    if (!state.playlists || state.playlists.length <= 1) {
      setFeedback('Nenhuma playlist para reordenar', 'info');
      return;
    }
    playlistsReorderMode = true;
    applyPlaylistsReorderUi();
    setFeedback('Arraste para reordenar • toque na lixeira para excluir', 'info');
  }

  function exitPlaylistsReorderMode() {
    if (!playlistsReorderMode) return;
    playlistsReorderMode = false;
    destroyMyPlaylistsSortable();
    ui.myPlaylistsSection?.classList.remove('is-editing');
    if (ui.reorderPlaylistsBtn) {
      ui.reorderPlaylistsBtn.classList.remove('is-active');
      ui.reorderPlaylistsBtn.setAttribute('aria-pressed', 'false');
      const label = ui.reorderPlaylistsBtn.querySelector('.reorder-label');
      if (label) label.textContent = 'Reordenar';
    }
  }

  function applyPlaylistsReorderUi() {
    ui.myPlaylistsSection?.classList.add('is-editing');
    if (ui.reorderPlaylistsBtn) {
      ui.reorderPlaylistsBtn.classList.add('is-active');
      ui.reorderPlaylistsBtn.setAttribute('aria-pressed', 'true');
      const label = ui.reorderPlaylistsBtn.querySelector('.reorder-label');
      if (label) label.textContent = 'Concluir';
    }
    setupMyPlaylistsSortable();
  }

  function setupMyPlaylistsSortable() {
    if (typeof Sortable === 'undefined' || !ui.myPlaylistsGrid) return;
    if (myPlaylistsSortable) myPlaylistsSortable.destroy();
    myPlaylistsSortable = Sortable.create(ui.myPlaylistsGrid, {
      animation: 320,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 4,
      draggable: '.my-playlist-card',
      filter: '.playlist-card-fixed, .delete-playlist-btn, .my-playlist-play-btn',
      preventOnFilter: false,
      ghostClass: 'playlist-sortable-ghost',
      chosenClass: 'playlist-sortable-chosen',
      dragClass: 'playlist-sortable-drag',
      onMove: (evt) => {
        // Não arrasta o card fixo ("Músicas Favoritas") nem permite soltar antes dele
        if (evt.dragged?.classList.contains('playlist-card-fixed')) return false;
        if (evt.related?.classList.contains('playlist-card-fixed') && !evt.willInsertAfter) {
          return false;
        }
        return true;
      },
      onStart: () => { document.body.classList.add('is-playlists-dragging'); },
      onEnd: () => {
        document.body.classList.remove('is-playlists-dragging');
        persistPlaylistsOrderFromDom();
      }
    });
  }

  function destroyMyPlaylistsSortable() {
    if (myPlaylistsSortable) {
      myPlaylistsSortable.destroy();
      myPlaylistsSortable = null;
    }
  }

  // Reconstrói a ordem de state.playlists a partir da ordem dos cards no DOM e persiste
  function persistPlaylistsOrderFromDom() {
    if (!ui.myPlaylistsGrid) return;
    const orderedIds = Array.from(ui.myPlaylistsGrid.querySelectorAll('.my-playlist-card'))
      .map(card => card.dataset.playlistId)
      .filter(Boolean);
    if (!orderedIds.length) return;

    const byId = new Map(state.playlists.map(p => [p.id, p]));
    const reordered = [];
    orderedIds.forEach(id => {
      const pl = byId.get(id);
      if (pl) { reordered.push(pl); byId.delete(id); }
    });
    // Mantém eventuais playlists ausentes do DOM (segurança)
    byId.forEach(pl => reordered.push(pl));

    // Garante a "Músicas Favoritas" sempre no início
    const watchIdx = reordered.findIndex(p => p.id === WATCH_LATER_PLAYLIST_ID);
    if (watchIdx > 0) {
      const [watch] = reordered.splice(watchIdx, 1);
      reordered.unshift(watch);
    }

    state.playlists = reordered;
    savePlaylistsToStorage();
  }

  async function selectPlaylist(playlist, autoPlay = false, options = {}) {
    if (!playlist) return;
    const { preloadAudio = true } = options;

    // Limpa estado de reprodução do YouTube se estiver ativo
    clearYouTubePlaybackState({ updateUi: false });

    // Atualiza a visualização (não afeta a reprodução em andamento)
    state.currentPlaylist = playlist;
    state.tracks = playlist.tracks || [];

    // Se a playlist selecionada é a mesma que está tocando, sincroniza o índice
    if (state.playingPlaylistId === playlist.id) {
      state.currentTrackIndex = state.playingTrackIndex;
    } else {
      state.currentTrackIndex = -1;
    }

    state.audioRecoveryInProgress = false;
    state.searchCache.clear();
    state.searchPromises.clear();
    // Não limpa audioCache para manter músicas em cache
    state.audioErrorCounts.clear();

    // Salva estado atual
    debouncedSave();

    updateUiState();
    updatePlaylistHeaderBackground();

    if (!ui.tracksContainer) return;

    if (!state.tracks.length) {
      renderTracks([]);
      if (playlist.id !== WATCH_LATER_PLAYLIST_ID) {
        setFeedback('Playlist vazia', 'error', getPlaylistFeedbackInfo(playlist));
      }
      return;
    }

    const playlistCoverUrls = getCurrentPlaylistCoverUrls(state.tracks);
    state.tracks = state.tracks.map((track) => {
      if (!track) return track;
      // Faixa que herdou a capa da playlist (importações antigas): descarta para
      // NUNCA exibir a capa da playlist no lugar da capa individual. O enriquecimento
      // recupera a arte própria; até lá, usa-se a capa genérica.
      const thumbSan = sanitizeImageUrl(track.thumbnail);
      if (thumbSan && playlistCoverUrls.has(thumbSan)) {
        track.thumbnail = '';
        if (track.album?.images?.length) {
          track.album.images = track.album.images.filter(img => sanitizeImageUrl(img?.url) !== thumbSan);
        }
      }
      const hasThumb = isRealCover(track.thumbnail);
      if (!hasThumb) {
        track.thumbnail = getFallbackCover(getTrackTitle(track));
        track.generatedCover = true;
      }
      return track;
    });

    renderTracks(state.tracks);

    // Se a playlist selecionada é a mesma que está tocando, reinicia o countdown
    // para atualizar os novos elementos DOM
    if (state.playingPlaylistId === playlist.id && state.isPlaying) {
      startPlaybackCountdown();
    }

    const playlistId = playlist.id;
    const importSessionId = state.currentImportSessionId;
    enrichTracksWithCovers(state.tracks, importSessionId)
      .then(() => {
        if (isImportSessionStale(importSessionId)) return;
        if (!state.currentPlaylist || state.currentPlaylist.id !== playlistId) return;
        refreshTracksView();
        // Reinicia countdown após re-render se a playlist está tocando
        if (state.playingPlaylistId === playlistId && state.isPlaying) {
          startPlaybackCountdown();
        }
        refreshCoversAfterEnrichment(importSessionId);
      })
      .catch(() => { });

    if (preloadAudio && !state.preloadedPlaylists.has(playlist.id)) {
      preloadTracksInBackground(state.tracks, playlist.id).then(() => {
        state.preloadedPlaylists.add(playlist.id);
      });
    }

    if (autoPlay && state.tracks.length > 0) {
      setTimeout(() => playNextFrom(0), 400);
    }
  }

  // ============================================================
  // Preload concorrente com fila de prioridade dinâmica.
  // P0 = faixa atual, P1 = próximas 3, P2 = próximas 10, P3 = restante.
  // Nunca bloqueia a UI: jobs rodam em background com limite de
  // concorrência e são cancelados quando a playlist muda (generation).
  // ============================================================
  const PRELOAD_CONCURRENCY = 3;        // resoluções simultâneas (faixa recomendada: 3–5)
  const PRELOAD_START_STAGGER_MS = 250; // espaçamento entre inícios para evitar rajadas na API

  const preloadScheduler = {
    buckets: [[], [], [], []],
    running: 0,
    generation: 0,
    lastStartAt: 0,
    paused: false,
    batch: null, // { playlistId, generation, remaining, startedAt, resolve }

    priorityFor(index, anchor) {
      if (index === anchor) return 0;
      if (index > anchor && index <= anchor + 3) return 1;
      if (index > anchor && index <= anchor + 13) return 2;
      return 3;
    },

    // Enfileira um lote para a playlist. Cancela (via generation) o lote anterior.
    schedule(tracks, playlistId) {
      this.generation += 1;
      const generation = this.generation;
      this.buckets = [[], [], [], []];

      // Resolve o lote anterior que tenha ficado pendente (semântica antiga: interrompido = concluído)
      if (this.batch?.resolve) this.batch.resolve([]);

      const anchor = (state.currentPlaylist?.id === playlistId && state.currentTrackIndex >= 0)
        ? state.currentTrackIndex
        : 0;

      let enqueued = 0;
      tracks.forEach((track, index) => {
        if (!track || track.unavailable) return;
        this.buckets[this.priorityFor(index, anchor)].push({ track, index, playlistId, generation });
        enqueued += 1;
      });

      const batchPromise = new Promise((resolve) => {
        this.batch = { playlistId, generation, remaining: enqueued, startedAt: Date.now(), resolve };
      });

      if (!enqueued) {
        this.batch.resolve([]);
        return batchPromise;
      }

      console.log(`🚀 [PRELOAD] Lote iniciado: ${enqueued} faixas (âncora=${anchor}, concorrência=${PRELOAD_CONCURRENCY})`);
      this.pump();
      return batchPromise;
    },

    // Reprioriza os jobs pendentes ao redor da faixa que começou a tocar
    reprioritizeAround(index) {
      if (!this.batch || this.batch.generation !== this.generation) return;
      if (state.currentPlaylist?.id !== this.batch.playlistId) return;
      const pending = this.buckets.flat();
      if (!pending.length) return;
      this.buckets = [[], [], [], []];
      for (const job of pending) {
        this.buckets[this.priorityFor(job.index, index)].push(job);
      }
      this.pump();
    },

    dequeue() {
      for (const bucket of this.buckets) {
        if (bucket.length) return bucket.shift();
      }
      return null;
    },

    // Pausa novos inícios de preload (jobs em andamento seguem até concluir).
    // Usada enquanto a faixa escolhida pelo usuário está sendo preparada,
    // garantindo prioridade total de rede/CPU para a reprodução.
    pause() {
      this.paused = true;
    },

    resume() {
      if (!this.paused) return;
      this.paused = false;
      this.pump();
    },

    pump() {
      if (this.paused) return;
      while (this.running < PRELOAD_CONCURRENCY) {
        const job = this.dequeue();
        if (!job) return;
        this.runJob(job);
      }
    },

    runJob(job) {
      this.running += 1;

      // Stagger entre inícios: espaça as chamadas concorrentes para não estourar rate limit
      const now = Date.now();
      const wait = Math.max(0, this.lastStartAt + PRELOAD_START_STAGGER_MS - now);
      this.lastStartAt = now + wait;

      (async () => {
        try {
          if (wait) await delay(wait);
          // Cancelado: playlist mudou ou um novo lote foi agendado
          if (job.generation !== this.generation) return;
          if (state.currentPlaylist?.id !== job.playlistId) return;

          const result = await preloadSingleTrack(job.track, job.index);
          if (result?.audioUrl) metrics.preload.tracksResolved += 1;
          else metrics.preload.tracksFailed += 1;
        } catch (_) {
          metrics.preload.tracksFailed += 1;
        } finally {
          this.running -= 1;
          this.settleJob(job);
          this.pump();
        }
      })();
    },

    settleJob(job) {
      const batch = this.batch;
      if (!batch || batch.generation !== job.generation) return;
      batch.remaining -= 1;
      if (batch.remaining <= 0) {
        const elapsed = Date.now() - batch.startedAt;
        metrics.preload.batches += 1;
        metrics.preload.totalTimeMs += elapsed;
        console.log(`🏁 [PRELOAD] Lote concluído em ${Math.round(elapsed / 1000)}s (playlist ${batch.playlistId})`);
        batch.resolve([]);
      }
    }
  };

  // API compatível com os chamadores existentes: preload em background,
  // resolve quando o lote termina (ou é substituído por outro).
  function preloadTracksInBackground(tracks, playlistId) {
    return preloadScheduler.schedule(tracks, playlistId);
  }

  // --- Resolução antecipada (hover/toque) ---
  // Aquece o cache quando o usuário demonstra intenção de tocar uma faixa
  // (hover no desktop, toque no mobile), para o play sair direto do cache.
  // Reusa resolveTrackWithCache: deduplicado com preload via searchPromises.
  const warmedTrackKeys = new Set();
  let trackWarmupTimer = null;

  function warmupTrackResolution(index) {
    const track = state.tracks[index];
    if (!track || track.unavailable) return;
    const key = getTrackKey(track);
    if (!key) return;
    if (getCacheEntry(state.searchCache, key) || state.searchPromises.has(key)) return;
    metrics.anticipate.warmups += 1;
    warmedTrackKeys.add(key);
    resolveTrackWithCache(track, index).catch(() => {});
  }

  function scheduleTrackWarmup(index) {
    cancelTrackWarmup();
    trackWarmupTimer = setTimeout(() => warmupTrackResolution(index), 150);
  }

  function cancelTrackWarmup() {
    if (trackWarmupTimer) {
      clearTimeout(trackWarmupTimer);
      trackWarmupTimer = null;
    }
  }

  async function preloadSingleTrack(track, index, retryCount = 0) {
    if (!track || track.unavailable) return null;
    const maxRetries = 1;

    try {
      const result = await resolveTrackWithCache(track, index);

      if (result && result.audioUrl) {
        return result;
      } else {
        if (retryCount < maxRetries) {
          // Limpa o videoId para forçar nova busca
          const originalVideoId = clearTrackVideoId(track);
          // Limpa cache da faixa
          const trackKey = getTrackKey(track);
          if (trackKey) {
            clearTrackCaches(trackKey);
          }
          await delay(800);
          const retryResult = await preloadSingleTrack(track, index, retryCount + 1);
          // Restaura o videoId original se a busca também falhar
          if (!retryResult && originalVideoId) {
            track._videoId = originalVideoId;
          }
          return retryResult;
        }
        markTrackUnavailable(index);
        return null;
      }
    } catch (error) {
      if (retryCount < maxRetries) {
        // Limpa o videoId para forçar nova busca
        const originalVideoId = clearTrackVideoId(track);
        // Limpa cache da faixa
        const trackKey = getTrackKey(track);
        if (trackKey) {
          clearTrackCaches(trackKey);
        }
        await delay(800);
        const retryResult = await preloadSingleTrack(track, index, retryCount + 1);
        // Restaura o videoId original se a busca também falhar
        if (!retryResult && originalVideoId) {
          track._videoId = originalVideoId;
        }
        return retryResult;
      }
      markTrackUnavailable(index);
      return null;
    }
  }

  // Helper para obter nome dos artistas de uma track
  function getTrackArtists(track) {
    return (track?.artists || []).map(a => a.name).filter(Boolean).join(', ') || '';
  }

  // Helper para obter título da track
  function getTrackTitle(track) {
    return track?.name || track?.title || '';
  }

  // Helper para comparar se duas tracks são iguais
  function isSameTrack(track1, track2) {
    if (!track1 || !track2) return false;
    return track1.name === track2.name && 
           JSON.stringify(track1.artists) === JSON.stringify(track2.artists);
  }

  // Helper para obter capa sanitizada da track (sem fallback)
  function getTrackCoverUrl(track) {
    return sanitizeImageUrl(track?.thumbnail) || sanitizeImageUrl(track?.album?.images?.[0]?.url) || '';
  }

  // Identifica faixas importadas do YouTube (busca manual ou import de playlist)
  function isYoutubeTrack(track) {
    return !!(track && (track._videoId || track._fromYoutubePlaylist || track._manualSearch));
  }

  function getTrackImage(track) {
    const candidates = [
      track.thumbnail,
      track.album?.images?.[2]?.url,
      track.album?.images?.[0]?.url
    ].map(sanitizeImageUrl).filter(Boolean);

    if (candidates.length) return candidates[0];
    return getFallbackCover(track?.name);
  }

  // Helper para obter capa da playlist
  function getPlaylistCover(playlist) {
    return playlist?.images?.[0]?.url || playlist?.cover || getFallbackCover(playlist?.name);
  }

  function isAudioContentType(contentType = '') {
    const lower = contentType.toLowerCase();
    return /audio|video|octet-stream/.test(lower);
  }

  // Valida URLs que passam pelo proxy (evita cachear HTML/erros como áudio)
  async function isPlayableAudioUrl(url) {
    if (!url) return { playable: false, reason: 'empty' };

    if (url.includes('/fourshared')) {
      return { playable: true, reason: 'fourshared-proxy' };
    }

    const isProxied = url.includes('/audio') || url.startsWith('/proxy');

    // URLs sem proxy não conseguem ser validadas por CORS; confiar nelas
    if (!isProxied) return { playable: true, reason: 'non-proxied' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000); // 10 segundos timeout
    try {
      const resp = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { Range: 'bytes=0-8192' }
      });
      clearTimeout(timer);

      const contentType = resp.headers.get('content-type') || '';
      const len = resp.headers.get('content-length');

      if (!(resp.ok || resp.status === 206)) {
        console.warn(`⚠️ [AUDIO] Validação HTTP falhou para ${url} (status ${resp.status})`);
        return { playable: false, status: resp.status, contentType };
      }

      const playable = isAudioContentType(contentType) && (len === null || Number(len) >= 0);
      if (!playable) {
        console.warn(`⚠️ [AUDIO] Validação inválida para ${url} (${resp.status} ${contentType || 'sem content-type'})`);
      }
      return { playable, status: resp.status, contentType };
    } catch (error) {
      clearTimeout(timer);
      const isAbort = error?.name === 'AbortError' || /abort/i.test(error?.message || '');
      console.warn(`⚠️ [AUDIO] Validação falhou para ${url}: ${error.message}`);
      return { playable: false, error: error.message, aborted: isAbort };
    }
  }

  let playbackCountdownRaf = null;

  function extractDurationMs(source) {
    if (!source) return null;

    const toNumber = (value) => {
      const num = Number(value);
      return Number.isFinite(num) && num > 0 ? num : null;
    };

    const durationMs = toNumber(source.duration_ms) ?? toNumber(source.durationMs);
    if (durationMs) return durationMs;

    const seconds =
      toNumber(source.lengthSeconds) ??
      toNumber(source.length) ??
      toNumber(source.duration);

    if (seconds) return seconds * 1000;
    return null;
  }

  function updateTrackDurationFromResult(track, index, result) {
    const durationMs = extractDurationMs(result);
    if (!track || !Number.isFinite(durationMs)) return;

    const current = extractDurationMs(track);
    const hasCurrent = Number.isFinite(current);
    const shouldUpdate = !hasCurrent || Math.abs(current - durationMs) > 500;
    if (shouldUpdate) {
      track.duration_ms = durationMs;
      track.durationMs = durationMs;
    }

    const targetIndex = Number.isInteger(index) ? index : state.tracks.indexOf(track);
    setTrackDurationLabel(targetIndex, durationMs);
  }

  function getTrackDurationMs(track) {
    return extractDurationMs(track) ?? (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : null);
  }

  function setTrackDurationLabel(index, ms) {
    const durationEl = getTrackElement(index)?.querySelector('.track-duration');
    if (durationEl) {
      durationEl.textContent = Number.isFinite(ms) ? formatDuration(ms) : '--:--';
    }
  }

  function resetTrackDurationLabel(index, overrideMs = null) {
    if (index < 0 || index >= state.tracks.length) return;
    const track = state.tracks[index];
    const durationMs = Number.isFinite(overrideMs) ? overrideMs : getTrackDurationMs(track);
    setTrackDurationLabel(index, durationMs);
  }

  function stopPlaybackCountdown({ resetLabel = false, finalValueMs = null, index = null } = {}) {
    if (playbackCountdownRaf) {
      cancelAnimationFrame(playbackCountdownRaf);
      playbackCountdownRaf = null;
    }
    if (resetLabel) {
      const targetIndex = Number.isInteger(index) ? index : state.currentTrackIndex;
      if (targetIndex >= 0) {
        resetTrackDurationLabel(targetIndex, finalValueMs);
        resetTrackProgress(targetIndex);
      }
    }
  }

  function updatePlaybackCountdown() {
    if (!state.isPlaying || audio.paused || !isLibraryPlaybackVisible()) {
      playbackCountdownRaf = null;
      return;
    }

    const activeIndex = getActiveLibraryIndex();
    if (activeIndex < 0) {
      playbackCountdownRaf = null;
      return;
    }

    const track = state.tracks[activeIndex];
    const durationMs = getTrackDurationMs(track);
    const currentMs = audio.currentTime * 1000;

    if (!Number.isFinite(durationMs)) {
      // Se não temos duração total, exibe o tempo decorrido e zera o progresso visual
      setTrackDurationLabel(activeIndex, currentMs);
      updateTrackProgress(activeIndex, 0);
    } else {
      const remainingMs = Math.max(0, durationMs - currentMs);
      setTrackDurationLabel(activeIndex, remainingMs);
      const progress = Math.min(100, (currentMs / durationMs) * 100);
      updateTrackProgress(activeIndex, progress);
    }

    playbackCountdownRaf = requestAnimationFrame(updatePlaybackCountdown);
  }

  function updateTrackProgress(index, progress) {
    const trackEl = getTrackElement(index);
    if (trackEl) {
      trackEl.style.setProperty('--progress', `${progress}%`);
    }
  }

  function resetTrackProgress(index) {
    updateTrackProgress(index, 0);
  }

  function startPlaybackCountdown() {
    stopPlaybackCountdown();
    if (!state.isPlaying || !hasValidTrack()) return;
    if (!isLibraryPlaybackVisible()) return;
    updatePlaybackCountdown();
  }

  function clearTracksContent() {
    if (!ui.tracksContainer) return;
    // Remove tudo exceto o empty state
    Array.from(ui.tracksContainer.children).forEach(child => {
      if (child.id !== 'playlist-empty-state') {
        child.remove();
      }
    });
  }

  function refreshTracksView() {
    renderTracks(state.tracks);
    updateTrackHighlight();
    updatePlaylistHeaderBackground();
  }

  function renderTracks(tracks) {
    if (!ui.tracksContainer) return;

    clearTracksContent();

    if (!tracks.length) {
      updatePlaylistEmptyState();
      return;
    }

    // O espaçamento superior agora é resolvido 100% pelo padding-top do #tracks-container
    // garantindo que as faixas sempre iniciem exatamente abaixo da faixa de playlists.

    const isWatchLaterPlaylist = state.currentPlaylist?.id === WATCH_LATER_PLAYLIST_ID;
    const watchLaterPlaylist = getWatchLaterPlaylist();

    const tracksHtml = tracks.map((track, index) => {
      const artists = getTrackArtists(track);
      const duration = formatDuration(extractDurationMs(track));
      const imageUrl = getTrackImage(track);
      const unavailableClass = track.unavailable ? ' track-unavailable' : '';

      // Verifica se a faixa já está nos favoritos
      const isInFavorites = !isWatchLaterPlaylist && watchLaterPlaylist?.tracks.some(t => isSameTrack(t, track));

      // Botão de ação: remover se estiver nos favoritos, senão adicionar
      const actionButton = isWatchLaterPlaylist
        ? `<button class="track-remove-watch-later-btn player-glass-btn liquid-glass" 
            data-remove-index="${index}" 
            aria-label="Remover dos favoritos" 
            title="Remover dos favoritos">
            <span class="liquid-glass-edge"></span>
            <i class="ph-bold ph-trash text-base"></i>
          </button>`
        : `<button class="track-add-watch-later-btn player-glass-btn liquid-glass ${isInFavorites ? 'is-favorite' : ''}" 
            data-add-index="${index}" 
            aria-label="${isInFavorites ? 'Já nos favoritos' : 'Adicionar aos favoritos'}" 
            title="${isInFavorites ? 'Já nos favoritos' : 'Adicionar aos favoritos'}">
            <span class="liquid-glass-edge"></span>
            <i class="${isInFavorites ? 'ph-fill' : 'ph-bold'} ph-heart text-base"></i>
          </button>`;

      let trackHtml = `
      <div class="track-item cursor-pointer group${unavailableClass}" 
        data-track-index="${index}">
        <div class="flex-shrink-0 w-12 h-12 relative">
          <img src="${imageUrl}" 
            alt="${track.name}" 
            class="w-full h-full rounded-md object-cover track-cover-img">
          <div class="sound-wave-overlay">
            <div class="sound-wave-bar"></div>
            <div class="sound-wave-bar"></div>
            <div class="sound-wave-bar"></div>
            <div class="sound-wave-bar"></div>
          </div>
          <div class="track-loading-overlay hidden">
            <i class="ph ph-spinner spinner-icon text-white"></i>
          </div>
          ${track.unavailable ? `<div class="track-reload-overlay">
            <i class="ph-bold ph-arrow-clockwise text-white text-lg"></i>
          </div>` : ''}
        </div>
        <div class="flex-1 min-w-0 flex flex-col justify-center">
          <p class="text-white font-medium truncate track-title leading-tight m-0 p-0">${track.name}</p>
          <p class="text-white/70 text-xs truncate leading-tight m-0 p-0 mt-0.5">${artists}</p>
        </div>
        ${actionButton}
        <div class="text-white/70 text-sm track-duration whitespace-nowrap">${duration}</div>
      </div>
    `;

      // Injeta Native Banner da Adsterra após a 3ª música (index 2) ou no fim se a playlist for muito curta
      if (index === 2 || (tracks.length < 3 && index === tracks.length - 1)) {
        const frameId = 'ad-' + Math.random().toString(36).substr(2, 9);
        trackHtml += `
          <div class="adsterra-native-banner-wrapper" style="margin: 8px 0; width: 100%;">
            <iframe id="${frameId}" src="ad-native.html?id=${frameId}" style="width: 100%; height: 320px; border: none; overflow: hidden; transition: height 0.3s;" scrolling="no"></iframe>
          </div>
        `;
      }

      return trackHtml;
    }).join('');

    ui.tracksContainer.insertAdjacentHTML('beforeend', tracksHtml);

    updatePlaylistEmptyState();

    ui.tracksContainer.querySelectorAll('.track-item').forEach(item => {
      const index = Number(item.dataset.trackIndex);

      const getSeekableIndex = () => {
        if (!isLibraryPlaybackActive() || !isViewingPlayingPlaylist()) return -1;
        return getActiveLibraryIndex();
      };

      attachSeekHandlers(item, {
        isSeekable: () => index === getSeekableIndex(),
        getDurationMs: () => getTrackDurationMs(state.tracks[index]),
        onSeek: ({ percentage, seekTime, durationMs }) => {
          updateTrackProgress(index, percentage * 100);
          const remainingMs = Math.max(0, durationMs - (seekTime * 1000));
          setTrackDurationLabel(index, remainingMs);
        },
        onClick: () => {
          const track = state.tracks[index];

          // Se a faixa está indisponível, tenta buscar novamente
          if (track?.unavailable) {
            retryUnavailableTrack(index);
            return;
          }

          // Clique simples - play/pause ou selecionar faixa
          const activeIndex = getSeekableIndex();
          const shouldToggle = !isPlayingFromYouTube() && activeIndex >= 0 && index === activeIndex;
          if (shouldToggle) {
            togglePlayback();
          } else {
            playTrack(index);
          }
        }
      });

      // Resolução antecipada: intenção de play (hover no desktop, toque no mobile)
      item.addEventListener('pointerenter', (event) => {
        if (event.pointerType && event.pointerType !== 'mouse') return;
        scheduleTrackWarmup(index);
      });
      item.addEventListener('pointerleave', cancelTrackWarmup);
      item.addEventListener('touchstart', () => scheduleTrackWarmup(index), { passive: true });
    });

    // Botões de adicionar/remover dos favoritos
    ui.tracksContainer.querySelectorAll('.track-add-watch-later-btn').forEach(button => {
      button.addEventListener('click', (event) => {
        stopEvent(event);
        const index = Number(button.dataset.addIndex);
        const track = state.tracks[index];
        if (!track) return;
        
        // Verifica se já está nos favoritos
        const watchLater = getWatchLaterPlaylist();
        const isInFavorites = watchLater?.tracks.some(t => isSameTrack(t, track));
        
        if (isInFavorites) {
          // Remove dos favoritos
          const trackIndexInFavorites = watchLater.tracks.findIndex(t => isSameTrack(t, track));
          if (trackIndexInFavorites !== -1) {
            removeFromWatchLaterByTrack(track);
            // Atualiza o ícone para vazio
            updateFavoriteButtonState(button, false);
          }
        } else {
          // Adiciona aos favoritos
          addToWatchLater(track);
        }
      });
    });

    // Botões de remover dos favoritos
    ui.tracksContainer.querySelectorAll('.track-remove-watch-later-btn').forEach(button => {
      button.addEventListener('click', (event) => {
        stopEvent(event);
        const index = Number(button.dataset.removeIndex);
        removeFromWatchLater(index);
      });
    });

    updateTrackHighlight();
  }


  // Handler de scroll do YouTube - infinite scroll
  let youtubeScrollRaf = null;
  function handleYoutubeScroll() {
    if (youtubeScrollRaf !== null) return;
    youtubeScrollRaf = requestAnimationFrame(() => {
      youtubeScrollRaf = null;
      if (!ui.youtubeSearchContent) return;
      const { scrollTop, scrollHeight, clientHeight } = ui.youtubeSearchContent;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      if (distanceFromBottom <= 200) {
        loadMoreYouTubeResults();
      }
    });
  }
  

  function markTrackUnavailable(index) {
    const track = state.tracks[index];
    if (!track || track.unavailable) return;

    const trackKey = getTrackKey(track);
    const cachedResult = trackKey ? getCacheEntry(state.searchCache, trackKey) : null;
    track.unavailable = true;
    resetAudioError(index);

    // Remove entradas do cache (memória + persistente)
    clearTrackCaches(trackKey, cachedResult);
    if (trackKey) {
      persistentResolveHints.delete(trackKey);
      idbDelete(IDB_AUDIO_STORE, trackKey);
    }

    // Atualizar UI
    const element = getTrackElement(index);
    if (element) {
      element.classList.add('track-unavailable');
      element.querySelector('.track-title')?.classList.add('line-through');
      
      // Adiciona overlay de reload se não existir
      const coverContainer = element.querySelector('.flex-shrink-0');
      if (coverContainer && !coverContainer.querySelector('.track-reload-overlay')) {
        const reloadOverlay = document.createElement('div');
        reloadOverlay.className = 'track-reload-overlay';
        reloadOverlay.innerHTML = '<i class="ph-bold ph-arrow-clockwise text-white text-lg"></i>';
        coverContainer.appendChild(reloadOverlay);
      }
    }
  }

  // Helper para marcar track como indisponível e pular para próxima
  function skipUnavailableTrack(index, fromPlayingTracks = false) {
    markTrackUnavailable(index);
    if (fromPlayingTracks) {
      playNextFromPlaying(index + 1);
    } else {
      playNextFrom(index + 1);
    }
  }

  async function retryUnavailableTrack(index) {
    const track = state.tracks[index];
    if (!track) return;

    // Remove o status de indisponível
    track.unavailable = false;
    
    // Limpa caches relacionados
    const trackKey = getTrackKey(track);
    if (trackKey) {
      clearTrackCaches(trackKey);
      state.audioCache.delete(trackKey);
      state.audioErrorCounts.delete(index);
    }

    // Atualiza UI - remove classe e overlay
    const element = getTrackElement(index);
    if (element) {
      element.classList.remove('track-unavailable');
      element.querySelector('.track-title')?.classList.remove('line-through');
      // Remove o overlay de reload
      element.querySelector('.track-reload-overlay')?.remove();
    }

    // Mostra loading e tenta tocar
    setTrackLoading(index, true);
    
    try {
      await playTrack(index);
    } catch (error) {
      console.error(`❌ [RETRY] Falha ao buscar: "${track.name}"`, error);
      setFeedback('Faixa indisponível', 'error', getTrackFeedbackInfo(track));
      markTrackUnavailable(index);
      // Re-adiciona o overlay de reload
      renderTracks(state.tracks);
    } finally {
      setTrackLoading(index, false);
    }
  }

  async function playTrack(index) {
    return playTrackInternal(index, { fromPlayingTracks: false });
  }

  async function getTrackAudioUrl(track, index) {
    const key = getTrackKey(track);

    const cached = getCacheEntry(state.searchCache, key);
    if (cached?.audioUrl) {
      if (warmedTrackKeys.has(key)) {
        metrics.anticipate.hits += 1;
        warmedTrackKeys.delete(key);
      }
      updateTrackDurationFromResult(track, index, cached);
      metrics.playback.optimisticPlays += 1;
      // Reprodução otimista: retorna a URL em cache imediatamente e valida em
      // background. Se a URL estiver morta, o próprio play falha rápido (evento
      // error do <audio>) e a recuperação existente força resolução fresca; a
      // invalidação aqui garante que o cache não sirva a URL morta de novo.
      isPlayableAudioUrl(cached.audioUrl).then((validation) => {
        if (!validation.playable && !validation.aborted) {
          console.warn(`⚠️ [AUDIO] URL em cache invalidada em background (${validation.status || validation.error || 'motivo desconhecido'})`);
          clearTrackCaches(key, cached, { preserveFailures: true });
        }
      }).catch(() => {});
      return cached.audioUrl;
    }

    const pending = key ? state.searchPromises.get(key) : null;
    if (pending) {
      const pendingResult = await pending.catch(() => null);
      if (pendingResult?.audioUrl) {
        updateTrackDurationFromResult(track, index, pendingResult);
        return pendingResult.audioUrl;
      }
    }

    const resolved = await resolveTrackWithCache(track, index);
    if (resolved?.audioUrl) {
      updateTrackDurationFromResult(track, index, resolved);
      return resolved.audioUrl;
    }

    return null;
  }

  // === 4shared Fallback Functions ===

  // Termos de ruído comuns em nomes de arquivos de música (removidos antes da comparação)
  const AUDIO_MATCH_JUNK_TERMS = [
    'official music video', 'official video', 'official audio', 'music video',
    'lyric video', 'lyrics', 'letra', 'legendado', 'visualizer', 'videoclipe',
    'clipe oficial', 'video oficial', 'audio oficial', 'official', 'oficial',
    'audio', 'video', 'hd', '4k', 'hq', 'full hd', 'high quality',
    '320kbps', '256kbps', '192kbps', '128kbps', 'kbps', 'mp3', 'download',
    'remastered', 'remaster', 'live', 'ao vivo', 'remix', 'radio edit',
    'extended', 'original mix', 'bonus track', 'album version', 'single version'
  ];

  /**
   * Normaliza um texto para comparação de correspondência musical:
   * remove extensão, acentos, conteúdo entre parênteses/colchetes,
   * sufixos de feat./ft. e termos de ruído (official video, lyrics, etc).
   */
  function normalizeForAudioMatch(text = '') {
    let t = String(text)
      .replace(/\.(mp3|m4a|aac|ogg|wav|flac|wma)$/i, '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      // remove blocos entre parênteses/colchetes/chaves (metadados na maioria dos casos)
      .replace(/[(\[{][^)\]}]*[)\]}]/g, ' ')
      // corta sufixo de feat/ft/featuring
      .replace(/\b(feat|ft|featuring)\b\.?.*$/i, ' ')
      // remove urls/sites embutidos no nome do arquivo
      .replace(/\b(www\.)?[a-z0-9-]+\.(com|net|org|info|biz)\b/g, ' ');

    for (const term of AUDIO_MATCH_JUNK_TERMS) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp(`\\b${escaped}\\b`, 'g'), ' ');
    }

    return t.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Similaridade entre dois textos normalizados via coeficiente de Dice
   * sobre tokens: penaliza tokens extras/faltantes em ambos os lados
   * (evita que "state of mind" case com "empire state of mind" só por inclusão).
   */
  function tokenDiceSimilarity(a = '', b = '') {
    const ta = a.split(' ').filter(Boolean);
    const tb = b.split(' ').filter(Boolean);
    if (!ta.length || !tb.length) return 0;

    const remaining = [...tb];
    let common = 0;
    for (const token of ta) {
      const idx = remaining.indexOf(token);
      if (idx !== -1) {
        common += 1;
        remaining.splice(idx, 1);
      }
    }
    return (2 * common) / (ta.length + tb.length);
  }

  /**
   * Similaridade de Levenshtein normalizada (0..1): 1 - dist/maxLen.
   * Captura erros de digitação/grafia que o Dice por tokens não vê.
   */
  function levenshteinSimilarity(a = '', b = '') {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    let prev = new Array(b.length + 1);
    let curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      [prev, curr] = [curr, prev];
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
  }

  /**
   * Similaridade Jaro-Winkler (0..1): dá peso extra a prefixos iguais,
   * útil para nomes de música/artista com pequenas variações no final.
   */
  function jaroWinklerSimilarity(a = '', b = '') {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;

    const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
    const aMatches = new Array(a.length).fill(false);
    const bMatches = new Array(b.length).fill(false);

    let matches = 0;
    for (let i = 0; i < a.length; i++) {
      const start = Math.max(0, i - matchWindow);
      const end = Math.min(i + matchWindow + 1, b.length);
      for (let j = start; j < end; j++) {
        if (bMatches[j] || a[i] !== b[j]) continue;
        aMatches[i] = true;
        bMatches[j] = true;
        matches += 1;
        break;
      }
    }
    if (!matches) return 0;

    let transpositions = 0;
    let k = 0;
    for (let i = 0; i < a.length; i++) {
      if (!aMatches[i]) continue;
      while (!bMatches[k]) k += 1;
      if (a[i] !== b[k]) transpositions += 1;
      k += 1;
    }

    const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;

    // Bônus Winkler: até 4 chars de prefixo comum, fator 0.1
    let prefix = 0;
    for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
      if (a[i] === b[i]) prefix += 1;
      else break;
    }
    return jaro + prefix * 0.1 * (1 - jaro);
  }

  /**
   * Score combinado de similaridade textual (0..1):
   * - Dice por tokens: robusto à ordem das palavras ("artista título" vs "título artista");
   * - Levenshtein + Jaro-Winkler (média): robustos a erros de grafia/variações.
   * Usa o MELHOR dos dois mundos — ambos os componentes char-level precisam
   * concordar para vencer o componente por tokens.
   */
  function textSimilarity(a = '', b = '') {
    if (!a || !b) return 0;
    const dice = tokenDiceSimilarity(a, b);
    const charLevel = (levenshteinSimilarity(a, b) + jaroWinklerSimilarity(a, b)) / 2;
    return Math.max(dice, charLevel);
  }

  // Palavras proibidas: versões alternativas NUNCA aceitas no fallback,
  // exceto quando o próprio título pedido contém o termo (ex: pediu um remix)
  const FOURSHARED_FORBIDDEN_TERMS = [
    'cover', 'karaoke', 'instrumental', 'slowed', 'reverb', 'nightcore',
    'bass boosted', 'bassboosted', 'remix', 'extended', 'radio edit',
    'live', 'ao vivo', 'demo', 'sped up', '8d audio', '8d', 'acapella',
    'tribute', 'ringtone', 'parody', 'paródia'
  ];

  // Verifica termos proibidos com word-boundary (evita falsos positivos como "deliver"/"live")
  function findForbiddenTerm(fileName, trackName) {
    const fileLower = ` ${String(fileName).toLowerCase()} `;
    const trackLower = ` ${String(trackName).toLowerCase()} `;
    for (const term of FOURSHARED_FORBIDDEN_TERMS) {
      const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(fileLower) && !re.test(trackLower)) return term;
    }
    return null;
  }

  /**
   * Pontua um candidato do 4shared contra a faixa desejada.
   * Compara título e artista SEPARADAMENTE (Dice + Levenshtein + Jaro-Winkler),
   * testando as divisões "Artista - Título" e "Título - Artista" do arquivo.
   * Considera duração quando disponível e rejeita palavras proibidas.
   * Retorna { score, titleSim, artistSim, rejectedBy } com score em 0..1.
   */
  function score4sharedCandidate(fileName, trackName, artistName, opts = {}) {
    const normFile = normalizeForAudioMatch(fileName);
    const normTrack = normalizeForAudioMatch(trackName);
    const normArtist = normalizeForAudioMatch(artistName);
    if (!normFile || !normTrack) return { score: 0, titleSim: 0, artistSim: 0, rejectedBy: 'vazio' };

    // Rejeição automática: versões alternativas não pedidas (cover, karaoke, live...)
    const forbidden = findForbiddenTerm(fileName, trackName);
    if (forbidden) {
      return { score: 0, titleSim: 0, artistSim: 0, rejectedBy: `termo proibido "${forbidden}"` };
    }

    const candidates = [];

    // Variante 1: arquivo inteiro contra o título (sem divisão)
    candidates.push({
      titleSim: textSimilarity(normFile, normTrack),
      artistSim: normArtist ? textSimilarity(normFile, normArtist) : 0
    });

    // Variante 2: divisões por hífen ("Artista - Título" e "Título - Artista")
    const rawParts = String(fileName).replace(/\.(mp3|m4a|aac|ogg|wav|flac|wma)$/i, '').split(/\s*[-–—]\s*/);
    if (rawParts.length >= 2) {
      for (let i = 1; i < rawParts.length; i++) {
        const left = normalizeForAudioMatch(rawParts.slice(0, i).join(' '));
        const right = normalizeForAudioMatch(rawParts.slice(i).join(' '));
        if (!left || !right) continue;

        // "Artista - Título"
        candidates.push({
          titleSim: textSimilarity(right, normTrack),
          artistSim: normArtist ? textSimilarity(left, normArtist) : 0
        });
        // "Título - Artista"
        candidates.push({
          titleSim: textSimilarity(left, normTrack),
          artistSim: normArtist ? textSimilarity(right, normArtist) : 0
        });
      }
    }

    // Variante 3: remove os tokens do artista do arquivo e compara o resto com o título
    if (normArtist) {
      const artistTokens = normArtist.split(' ').filter(Boolean);
      const fileTokens = normFile.split(' ').filter(Boolean);
      let found = 0;
      const residue = [];
      const pool = [...artistTokens];
      for (const token of fileTokens) {
        const idx = pool.indexOf(token);
        if (idx !== -1) {
          found += 1;
          pool.splice(idx, 1);
        } else {
          residue.push(token);
        }
      }
      const artistCoverage = artistTokens.length ? found / artistTokens.length : 0;
      candidates.push({
        titleSim: textSimilarity(residue.join(' '), normTrack),
        artistSim: artistCoverage
      });
    }

    // Componente de duração (quando disponível dos dois lados):
    // diferença ≤ 5s vale 1.0, decaindo linearmente até 0 em 60s
    const trackDurationSec = opts.trackDurationMs ? opts.trackDurationMs / 1000 : 0;
    const fileDurationSec = opts.fileDurationSec || 0;
    const hasDuration = trackDurationSec > 30 && fileDurationSec > 30;
    const durationSim = hasDuration
      ? Math.max(0, 1 - Math.max(0, Math.abs(trackDurationSec - fileDurationSec) - 5) / 55)
      : 0;

    // Escolhe a melhor variante. Pesos: título 60% / artista 40%;
    // com duração disponível: título 50% / artista 30% / duração 20%
    let best = { score: 0, titleSim: 0, artistSim: 0 };
    for (const c of candidates) {
      let score;
      if (normArtist && hasDuration) {
        score = (c.titleSim * 0.5) + (c.artistSim * 0.3) + (durationSim * 0.2);
      } else if (normArtist) {
        score = (c.titleSim * 0.6) + (c.artistSim * 0.4);
      } else if (hasDuration) {
        score = (c.titleSim * 0.8) + (durationSim * 0.2);
      } else {
        score = c.titleSim;
      }
      if (score > best.score) {
        best = { score, titleSim: c.titleSim, artistSim: c.artistSim };
      }
    }

    // Gate de artista: JAMAIS aceitar artista claramente divergente só porque
    // o título é parecido (ex: mesmo título gravado por outra banda)
    if (normArtist && best.artistSim < FOURSHARED_MIN_ARTIST_SIM) {
      return { ...best, score: 0, rejectedBy: `artista divergente (${(best.artistSim * 100).toFixed(0)}% < ${FOURSHARED_MIN_ARTIST_SIM * 100}%)` };
    }

    // Palavras extras relevantes no arquivo que não existem no pedido indicam
    // outra música/versão (ex: "freestyle", "remake", outro artista no título).
    // Uma palavra extra aplica penalidade; duas ou mais com título imperfeito
    // rejeitam o candidato — melhor sem fallback do que a música errada.
    const requestTokens = `${normTrack} ${normArtist}`.split(' ').filter(Boolean);
    const extraTokens = normFile.split(' ').filter(Boolean).filter((token) => {
      if (token.length <= 3) return false;
      return !requestTokens.some((req) => req === token || levenshteinSimilarity(token, req) >= 0.8);
    });
    if (extraTokens.length >= 2 && best.titleSim < 0.9) {
      return { ...best, score: 0, rejectedBy: `palavras extras relevantes (${extraTokens.join(', ')})` };
    }
    if (extraTokens.length) {
      best.score *= Math.pow(0.85, Math.min(extraTokens.length, 3));
    }

    best.score = Math.max(0, Math.min(1, best.score));
    return best;
  }

  // Score mínimo para aceitar um fallback do 4shared (0..1).
  // É preferível NÃO ter fallback do que tocar a música errada.
  const FOURSHARED_MIN_SCORE = 0.8;
  const FOURSHARED_MIN_TITLE_SIM = 0.6;
  const FOURSHARED_MIN_ARTIST_SIM = 0.4;

  /**
   * Busca uma faixa no 4shared como fonte alternativa de áudio.
   * Ativado quando YouTube + RapidAPI falham.
   */
  async function search4shared(trackName, artistName, durationMs = null) {
    // Só funciona em produção (Netlify) ou com netlify dev
    if (localDevFlag && !window.location.port.toString().startsWith('888')) {
      return null;
    }

    const query = `${trackName} ${artistName}`.trim();
    if (!query) return null;

    const startedAt = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(ApiClient.urls.fourshared(query, 10), {
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!response.ok) {
        console.warn(`[4SHARED] HTTP ${response.status}`);
        return null;
      }

      const data = await response.json();
      const files = data?.files;
      if (!Array.isArray(files) || !files.length) {
        console.log(`🔍 [4SHARED] Sem resultados para "${query}" (${Date.now() - startedAt}ms)`);
        return null;
      }

      // Pontua com comparação separada de título/artista (Dice + Levenshtein + Jaro-Winkler)
      const scored = files.map(file => {
        const match = score4sharedCandidate(file.name || '', trackName, artistName, {
          trackDurationMs: durationMs,
          fileDurationSec: file.duration || 0
        });
        return { ...file, ...match };
      });

      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];
      const elapsed = Date.now() - startedAt;

      // Rejeita match fraco: melhor não ter fallback do que tocar música errada
      if (!best || best.score < FOURSHARED_MIN_SCORE || best.titleSim < FOURSHARED_MIN_TITLE_SIM) {
        metrics.fourshared.rejected += 1;
        const pct = best ? (best.score * 100).toFixed(0) : '0';
        const titlePct = best ? (best.titleSim * 100).toFixed(0) : '0';
        const motivo = best?.rejectedBy ? ` [${best.rejectedBy}]` : '';
        console.warn(`❌ [4SHARED] Rejeitado: melhor candidato "${best?.name || 'nenhum'}" com score ${pct}% (título ${titlePct}%)${motivo} < mínimo ${FOURSHARED_MIN_SCORE * 100}% para "${trackName}" - "${artistName}" (${elapsed}ms)`);
        return null;
      }

      metrics.fourshared.accepted += 1;
      console.log(`🔄 [4SHARED] Match aceito: "${best.name}" score ${(best.score * 100).toFixed(0)}% (título ${(best.titleSim * 100).toFixed(0)}%, artista ${(best.artistSim * 100).toFixed(0)}%) para "${trackName}" - "${artistName}" (${elapsed}ms)`);
      return {
        fileId: best.id,
        name: best.name,
        source: '4shared'
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        console.warn('[4SHARED] Search timeout');
      } else {
        console.warn(`[4SHARED] Search error: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Obtém a URL de stream de um arquivo do 4shared.
   * Usa cache com TTL de AUDIO_URL_TTL_MS (10 min).
   */
  async function get4sharedStreamUrl(fileId) {
    if (!fileId) return null;

    // Chave de cache com prefixo para evitar colisão com videoIds do YouTube
    const cacheKey = `4s-${fileId}`;
    const cached = getCacheEntry(state.audioCache, cacheKey, AUDIO_URL_TTL_MS);
    if (cached !== null) return cached;

    // O endpoint /fourshared?action=stream atua como Proxy e usa Range Requests 
    // para fatiar o áudio em pedaços de 2MB, evitando IP Binding do 4shared e o limite de 6MB do Netlify.
    const streamUrl = `/fourshared?action=stream&id=${encodeURIComponent(fileId)}`;
    setCacheEntry(state.audioCache, cacheKey, streamUrl);
    return streamUrl;
  }

  /**
   * Tenta reproduzir via 4shared como fallback.
   * Retorna o resultado com audioUrl se bem-sucedido, ou null.
   */
  async function tryFoursharedFallback(track, index) {
    const trackName = getTrackTitle(track);
    const artists = getTrackArtists(track);
    const durationMs = extractDurationMs(track);

    console.log(`🔄 [4SHARED] Tentando fallback para: "${trackName}" - ${artists}`);

    const searchResult = await search4shared(trackName, artists, durationMs);
    if (!searchResult) {
      console.warn(`❌ [4SHARED] Nenhum resultado encontrado para: "${trackName}"`);
      return null;
    }

    const streamUrl = await get4sharedStreamUrl(searchResult.fileId);
    if (!streamUrl) {
      console.warn(`❌ [4SHARED] Não foi possível obter stream URL para: "${searchResult.name}"`);
      return null;
    }

    console.log(`✅ [4SHARED] Fallback disponível: "${searchResult.name}"`);

    const result = {
      videoId: `4s-${searchResult.fileId}`,
      instance: '4shared-fallback',
      audioUrl: streamUrl,
      lengthSeconds: 0 // Será detectado via getAudioDuration
    };

    // Marca a faixa como fonte 4shared de forma PERSISTENTE na sessão. Este campo
    // NÃO é apagado pelas rotinas de recuperação (que só mexem em _videoId), então
    // qualquer re-resolução volta a usar o 4shared — nunca a API /audio.
    track._foursharedFileId = searchResult.fileId;

    // Cache o resultado
    const key = getTrackKey(track);
    if (key) {
      setCacheEntry(state.searchCache, key, result);
    }

    return result;
  }

  // === End 4shared Fallback Functions ===

  async function resolveTrackAudio(track, index, forceRefresh = false) {
    if (!track) return null;

    const key = getTrackKey(track);
    const startedAt = Date.now();
    const label = track.name || 'desconhecida';

    // --- Log agrupado por faixa: acumula eventos e imprime um único grupo ---
    const events = [];
    const logEvent = (tag, msg) => events.push(`${tag} ${msg}`);
    const flushLog = (resultado, origem) => {
      const totalMs = Date.now() - startedAt;
      const ok = resultado === 'ok';

      // Métricas por origem
      metrics.resolve.count += 1;
      metrics.resolve.totalTimeMs += totalMs;
      if (!ok) metrics.resolve.failures += 1;
      else if (origem === 'cache') metrics.resolve.cache += 1;
      else if (origem === 'cache-persistente') metrics.resolve.persistentCache += 1;
      else if (origem.startsWith('4shared')) metrics.resolve.fallback += 1;
      else metrics.resolve.api += 1;

      const header = `${ok ? '🎵' : '❌'} [AUDIO] "${label}" · ${resultado} · origem=${origem} · ${totalMs}ms`;
      if (!events.length) {
        (ok ? console.log : console.warn)(header);
        return;
      }
      console.groupCollapsed(header);
      console.log(`Track: ${label} — ${getTrackArtists(track) || 'artista desconhecido'}`);
      for (const e of events) console.log(e);
      console.log(`Origem: ${origem}`);
      console.log(`Resultado: ${resultado}`);
      console.log(`Tempo total: ${totalMs}ms`);
      console.groupEnd();
    };
    const finishOk = (origem, result) => { flushLog('ok', origem); return result; };
    const finishFail = (origem, motivo) => { logEvent('❌', `Falha: ${motivo}`); flushLog('falha', origem); return null; };

    if (!forceRefresh) {
      const cached = getCacheEntry(state.searchCache, key);
      if (cached !== null) {
        return finishOk('cache', cached);
      }

      // Cache persistente (IndexedDB): aplica hints salvos em sessões anteriores
      const hint = key ? persistentResolveHints.get(key) : null;
      if (hint) {
        // Fonte 4shared persistida: restaura o marcador sticky
        if (hint.foursharedFileId && !track._foursharedFileId) {
          track._foursharedFileId = hint.foursharedFileId;
          logEvent('💾', `Cache: hint 4shared persistido (fileId=${hint.foursharedFileId})`);
        }
        // URL de áudio ainda válida: usa imediatamente, sem nenhuma chamada de rede
        const isFoursharedHint = String(hint.videoId || '').startsWith('4s-');
        if (!isFoursharedHint && hint.audioUrl && Date.now() < (hint.audioExpiresAt || 0)) {
          const result = {
            videoId: hint.videoId,
            instance: hint.source || 'cache-persistente',
            audioUrl: hint.audioUrl,
            lengthSeconds: hint.lengthSeconds || Math.floor((track.duration_ms || 0) / 1000)
          };
          if (key) setCacheEntry(state.searchCache, key, result);
          if (hint.videoId) setCacheEntry(state.audioCache, hint.videoId, hint.audioUrl);
          updateTrackDurationFromResult(track, index, result);
          logEvent('💾', `Cache: audioUrl persistida ainda válida (${hint.videoId})`);
          return finishOk('cache-persistente', result);
        }
        // URL expirou, mas o videoId segue válido: pula a busca no YouTube
        if (!isFoursharedHint && hint.videoId && !getTrackVideoId(track)) {
          track._videoId = hint.videoId;
          logEvent('💾', `Cache: videoId persistido reutilizado (${hint.videoId}), busca YouTube evitada`);
        }
      }
    }

    try {
      // Fonte 4shared "grudenta": se a faixa já foi resolvida via 4shared nesta
      // sessão, re-resolve SEMPRE pelo 4shared (stream fresco do mesmo arquivo),
      // sem nunca chamar a API /audio. Isso impede que reconexão/recuperação
      // sobrescrevam a URL do 4shared por uma URL inválida do YouTube.
      if (track._foursharedFileId) {
        const streamUrl = await get4sharedStreamUrl(track._foursharedFileId);
        if (streamUrl) {
          const fsResult = {
            videoId: `4s-${track._foursharedFileId}`,
            instance: '4shared-fallback',
            audioUrl: streamUrl,
            lengthSeconds: Math.floor((track.duration_ms || 0) / 1000)
          };
          if (key) setCacheEntry(state.searchCache, key, fsResult);
          persistResolvedAudio(key, fsResult, track);
          logEvent('🔄', `Fallback: stream 4shared do mesmo arquivo (fileId=${track._foursharedFileId})`);
          return finishOk('4shared-sticky', fsResult);
        }
        // Se não obteve o stream do mesmo arquivo, tenta nova busca no 4shared.
        logEvent('⚠️', 'Fallback: stream 4shared indisponível, refazendo busca no 4shared...');
        const rebuilt = await tryFoursharedFallback(track, index);
        if (rebuilt) {
          persistResolvedAudio(key, rebuilt, track);
          return finishOk('4shared-rebusca', rebuilt);
        }
        return finishFail('4shared-rebusca', 'sem correspondência confiável no 4shared');
      }

      let video;
      
      // Se a faixa já tem videoId (busca manual ou definido na playlist), usa diretamente
      const existingVideoId = getTrackVideoId(track);
      if (existingVideoId) {
        let lengthSeconds = Math.floor((track.duration_ms || 0) / 1000);
        
        video = {
          videoId: existingVideoId,
          instance: 'preset-video',
          lengthSeconds: lengthSeconds
        };
        logEvent('🎬', `YouTube: videoId pré-definido (${existingVideoId})`);
      } else {
        video = await findVideoForTrack(track);
        if (!video) {
          logEvent('⚠️', 'YouTube: busca sem resultados, tentando fallback 4shared...');
          const foursharedResult = await tryFoursharedFallback(track, index);
          if (foursharedResult) {
            persistResolvedAudio(key, foursharedResult, track);
            logEvent('🔄', 'Fallback: 4shared aceito (motivo: YouTube sem resultados)');
            return finishOk('4shared', foursharedResult);
          }
          return finishFail('nenhuma', 'nenhuma fonte encontrada (YouTube e 4shared)');
        }
        logEvent('🎬', `YouTube: encontrado ${video.videoId} (${video.instance || 'busca'})`);
      }

      updateTrackDurationFromResult(track, index, video);
      if (forceRefresh && video.videoId) {
        state.audioCache.delete(video.videoId);
      }
      const audioUrl = await getAudioUrl(video.videoId, 0, { log: logEvent });
      if (!audioUrl) {
        logEvent('⚠️', `YouTube: extração /audio falhou (${video.videoId}), tentando fallback 4shared...`);
        const foursharedResult = await tryFoursharedFallback(track, index);
        if (foursharedResult) {
          persistResolvedAudio(key, foursharedResult, track);
          logEvent('🔄', 'Fallback: 4shared aceito (motivo: extração /audio falhou)');
          return finishOk('4shared', foursharedResult);
        }
        return finishFail('nenhuma', 'extração /audio falhou e 4shared sem correspondência');
      }

      // Se não tem duração (preset videoId), tenta obter do áudio
      if (!video.lengthSeconds) {
        try {
          const duration = await getAudioDuration(audioUrl);
          if (duration > 0) {
            video.lengthSeconds = duration;
            updateTrackDurationFromResult(track, index, video);
          }
        } catch (e) { }
      }

      const result = { ...video, audioUrl };
      setCacheEntry(state.searchCache, key, result);
      persistResolvedAudio(key, result, track);
      return finishOk('api', result);
    } catch (error) {
      logEvent('⚠️', `Erro inesperado: ${error.message}, tentando fallback 4shared...`);
      try {
        const foursharedResult = await tryFoursharedFallback(track, index);
        if (foursharedResult) {
          persistResolvedAudio(key, foursharedResult, track);
          logEvent('🔄', 'Fallback: 4shared aceito (motivo: erro inesperado na resolução)');
          return finishOk('4shared', foursharedResult);
        }
      } catch (fbError) {
        logEvent('❌', `Fallback 4shared também falhou: ${fbError.message}`);
      }
      return finishFail('nenhuma', error.message);
    }
  }

  // Recuperação dedicada e enxuta para fontes 4shared: re-resolve APENAS via
  // 4shared (stream fresco), com no máximo 2 tentativas, sem busca alternativa no
  // YouTube e sem apagar o marcador _foursharedFileId. Evita loops e /audio.
  async function recoverFoursharedTrack(index, track, requestId) {
    if (state.audioRecoveryInProgress) return;
    const isStale = () => requestId !== state.playRequestId || state.currentTrackIndex !== index;

    const attempt = trackAudioError(index);
    if (attempt > 2) {
      console.warn(`⏭️ [4SHARED] Recuperação esgotada para track ${index}, marcando indisponível`);
      if (!isStale()) handleUnavailableTrack(index);
      return;
    }

    state.audioRecoveryInProgress = true;
    try {
      let streamUrl = null;
      if (track._foursharedFileId) {
        state.audioCache.delete(`4s-${track._foursharedFileId}`);
        streamUrl = await get4sharedStreamUrl(track._foursharedFileId);
      }
      if (!streamUrl) {
        const fb = await tryFoursharedFallback(track, index);
        streamUrl = fb?.audioUrl || null;
      }
      if (isStale() || !streamUrl) return;

      await resetAudioWithDelay();
      if (isStale()) return;
      loadAudioSource(streamUrl);
      const played = await tryPlayElement(audio);
      if (isStale()) return;
      if (played) {
        markPlaybackSuccess(index);
        console.log(`✅ [4SHARED] Recuperação bem-sucedida para track ${index}`);
      } else {
        handleUnavailableTrack(index);
      }
    } catch (e) {
      console.warn(`❌ [4SHARED] Falha na recuperação: ${e.message}`);
      if (!isStale()) handleUnavailableTrack(index);
    } finally {
      state.audioRecoveryInProgress = false;
    }
  }

  async function handleAudioError(event = null) {
    const failingIndex = state.currentTrackIndex;
    if (failingIndex < 0 || state.audioRecoveryInProgress) return;

    // Durante o carregamento inicial, o próprio playTrackInternal já trata falhas
    // (com sua recuperação e fallback). Reagir aqui em paralelo causaria um
    // pause()/reset() concorrente que interrompe o play() pendente
    // ("The play() request was interrupted by a call to pause()").
    if (state.isLoadingTrack) return;

    const track = state.tracks[failingIndex];
    if (!track) return;

    // Captura o playRequestId atual para detectar se o usuário clicou em outra música
    const currentRequestId = state.playRequestId;
    const isStale = () => currentRequestId !== state.playRequestId || state.currentTrackIndex !== failingIndex;

    const mediaError = audio.error || event?.target?.error || null;
    if (mediaError?.code === MEDIA_ERROR_ABORTED_CODE) {
      console.warn(`⚠️ [AUDIO] Abort error ignored for track ${failingIndex}`);
      resetAudioError(failingIndex);
      return;
    }

    // Se estamos offline ou em processo de reconexão, não pula para próxima faixa
    if (!navigator.onLine || state.connectionLost) {
      console.warn(`📡 [AUDIO] Erro durante perda de conexão, aguardando reconexão...`);
      state.connectionLost = true;
      state.savedPlaybackTime = audio.currentTime || 0;
      // Agenda tentativa de reconexão quando a conexão voltar
      if (!state.reconnectTimer) {
        state.reconnectTimer = setTimeout(() => {
          if (navigator.onLine) {
            attemptReconnect();
          }
        }, RECONNECT_INTERVAL_MS);
      }
      return;
    }

    // Se já estamos tentando reconectar, não processa erro
    if (state.reconnectAttempts > 0) {
      console.warn(`🔄 [AUDIO] Erro durante reconexão, ignorando...`);
      return;
    }

    // Verifica se o usuário já clicou em outra música
    if (isStale()) {
      return;
    }

    // Fonte 4shared: usa a recuperação dedicada (sem YouTube, sem loops, sem /audio).
    if (isFoursharedActive() || track._foursharedFileId) {
      await recoverFoursharedTrack(failingIndex, track, currentRequestId);
      return;
    }

    state.audioRecoveryInProgress = true;
    try {
      const attempt = trackAudioError(failingIndex);
      const codeLabel = mediaError?.code ? `, code ${mediaError.code}` : '';
      console.warn(`⚠️ [AUDIO] Attempting recovery for track ${failingIndex} (attempt ${attempt}${codeLabel})`);

      // Máximo de 3 tentativas de recuperação
      const maxAttempts = 3;
      if (attempt > maxAttempts) {
        console.warn(`⏭️ [AUDIO] Skipping track ${failingIndex} after ${attempt - 1} recovery attempts`);
        if (!isStale()) {
          handleUnavailableTrack(failingIndex);
        }
        return;
      }

      // Obtém o videoId do cache
      const trackKey = getTrackKey(track);
      const cachedResult = trackKey ? getCacheEntry(state.searchCache, trackKey) : null;
      const targetVideoId = cachedResult?.videoId || null;

      // Verifica se o usuário já clicou em outra música
      if (isStale()) {
        return;
      }

      // Limpa cache de áudio para forçar nova busca
      if (targetVideoId) {
        state.audioCache.delete(targetVideoId);
      }

      const refreshed = await resolveTrackWithCache(track, failingIndex, { forceRefresh: true, preserveFailures: true });
      // Verifica novamente após o await
      if (isStale()) {
        return;
      }

      // Se não conseguiu obter URL (todas as combinações falharam), tenta buscar vídeo alternativo
      if (!refreshed?.audioUrl) {
        console.warn(`⚠️ [AUDIO] No audio URL for track ${failingIndex}, trying alternative video search...`);

        // Tenta buscar um vídeo alternativo (limpa o cache de busca para forçar nova busca)
        const trackKey = getTrackKey(track);
        if (trackKey) {
          state.searchCache.delete(trackKey);
        }

        // Limpa o videoId manual se existir para forçar nova busca
        const originalVideoId = track._videoId;
        delete track._videoId;

        // Tenta resolver novamente com nova busca
        const alternativeResult = await resolveTrackWithCache(track, failingIndex, { forceRefresh: true, preserveFailures: false });

        if (alternativeResult?.audioUrl && alternativeResult.videoId !== originalVideoId) {
          if (!isStale()) {
            try {
              // Reseta o elemento de áudio antes de tentar nova URL
              await resetAudioWithDelay();

              loadAudioSource(alternativeResult.audioUrl);
              await delay(300);
              await audio.play();
              markPlaybackSuccess(failingIndex);
              return;
            } catch (altError) {
              console.error(`❌ [AUDIO] Alternative video play failed: ${altError.message}`);
            }
          }
        }

        // Último recurso: tenta 4shared antes de marcar como indisponível
        if (!isStale()) {
          console.log(`🔄 [AUDIO] Tentando fallback 4shared para track ${failingIndex}...`);
          const foursharedResult = await tryFoursharedFallback(track, failingIndex);
          if (foursharedResult?.audioUrl && !isStale()) {
            try {
              await resetAudioWithDelay();
              loadAudioSource(foursharedResult.audioUrl);
              await delay(300);
              await audio.play();
              markPlaybackSuccess(failingIndex);
              console.log(`✅ [4SHARED] Fallback bem-sucedido para track ${failingIndex}`);
              return;
            } catch (fbError) {
              console.error(`❌ [4SHARED] Fallback play failed: ${fbError.message}`);
            }
          }
        }

        // Se ainda não conseguiu, marca como indisponível
        console.warn(`⏭️ [AUDIO] No audio URL available for track ${failingIndex}, marking as unavailable`);
        if (!isStale()) {
          handleUnavailableTrack(failingIndex);
        }
        return;
      }

      try {
        // Salva a posição atual antes de resetar
        const savedPosition = audio.currentTime > 0 ? audio.currentTime : 0;

        // Reseta o elemento de áudio antes de tentar nova URL
        await resetAudioWithDelay();

        loadAudioSource(refreshed.audioUrl);

        // Aguarda o áudio estar pronto antes de tentar tocar (reduzido para 3s)
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => resolve(), 3000);
          const onCanPlay = () => {
            clearTimeout(timeout);
            audio.removeEventListener('canplay', onCanPlay);
            audio.removeEventListener('error', onError);
            resolve();
          };
          const onError = () => {
            clearTimeout(timeout);
            audio.removeEventListener('canplay', onCanPlay);
            audio.removeEventListener('error', onError);
            reject(new Error('Audio load error'));
          };
          audio.addEventListener('canplay', onCanPlay, { once: true });
          audio.addEventListener('error', onError, { once: true });
        });

        // Verifica mais uma vez antes de tocar
        if (isStale()) {
          return;
        }

        // Restaura a posição de reprodução se havia uma
        if (savedPosition > 1) {
          try {
            audio.currentTime = Math.max(0, savedPosition - 0.5); // Volta 0.5s para garantir continuidade
          } catch (_) { }
        }

        await audio.play();
        markPlaybackSuccess(failingIndex);
        return;
      } catch (retryError) {
        // Se o erro for "interrupted by pause", tenta novamente após um delay
        const isInterruptedError = retryError.message?.includes('interrupted') || retryError.name === 'AbortError';
        if (isInterruptedError && attempt <= 2) {
          console.warn(`⚠️ [AUDIO] Recovery interrupted, retrying in 500ms...`);
          await delay(500);
          try {
            await audio.play();
            markPlaybackSuccess(failingIndex);
            return;
          } catch (secondError) {
            console.error(`❌ [AUDIO] Recovery play failed after retry: ${secondError.message}`);
          }
        } else {
          console.error(`❌ [AUDIO] Recovery play failed: ${retryError.message}`);
        }
      }

      // Verifica se o usuário mudou de track antes de continuar
      if (isStale()) {
        return;
      }

      // Só marca como indisponível após esgotar todas as combinações
      if (attempt >= maxAttempts) {
        // Último recurso: tenta 4shared antes de desistir
        if (!isStale()) {
          const foursharedLast = await tryFoursharedFallback(track, failingIndex);
          if (foursharedLast?.audioUrl && !isStale()) {
            try {
              await resetAudioWithDelay();
              loadAudioSource(foursharedLast.audioUrl);
              await delay(300);
              await audio.play();
              markPlaybackSuccess(failingIndex);
              console.log(`✅ [4SHARED] Fallback final bem-sucedido para track ${failingIndex}`);
              return;
            } catch (fbLastErr) {
              console.error(`❌ [4SHARED] Fallback final falhou: ${fbLastErr.message}`);
            }
          }
          handleUnavailableTrack(failingIndex);
        }
      } else {
        // Agenda nova tentativa de recovery - reduzido para 500ms
        const savedRequestId = currentRequestId;
        setTimeout(() => {
          // Verifica se ainda é a mesma requisição
          if (state.playRequestId === savedRequestId && state.currentTrackIndex === failingIndex && !state.isPlaying) {
            handleAudioError();
          }
        }, 500);
      }
    } finally {
      state.audioRecoveryInProgress = false;
    }
  }

  function calculateStringSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;

    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();

    // Correspondência exata
    if (s1 === s2) return 1;
    if (s1.includes(s2) || s2.includes(s1)) return 0.8;

    // Normalizar: remover caracteres especiais
    const normalize = (str) => str.replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    const n1 = normalize(s1);
    const n2 = normalize(s2);

    if (n1 === n2) return 0.9;
    if (n1.includes(n2) || n2.includes(n1)) return 0.7;

    // Similaridade baseada em palavras em comum
    const words1 = n1.split(/\s+/).filter(w => w.length > 2);
    const words2 = n2.split(/\s+/).filter(w => w.length > 2);

    if (words1.length === 0 || words2.length === 0) return 0;

    const commonWords = words1.filter(w1 =>
      words2.some(w2 => w1.includes(w2) || w2.includes(w1))
    );

    return commonWords.length / Math.max(words1.length, words2.length);
  }

  function calculateTrackScore(candidate, track) {
    if (!candidate || !track) return 0;

    let score = 0;
    const candidateTitle = (candidate.title || '').toLowerCase();
    const trackName = (track.name || '').toLowerCase();
    const trackDurationMs = extractDurationMs(track);

    // Pontuação por título (0-50 pontos)
    const titleSimilarity = calculateStringSimilarity(candidateTitle, trackName);
    score += titleSimilarity * 50;

    // Pontuação por artista (0-30 pontos)
    const artistNames = getTrackArtists(track).replace(/, /g, ' ').toLowerCase();
    if (artistNames) {
      const artistSimilarity = calculateStringSimilarity(candidateTitle, artistNames);
      score += artistSimilarity * 30;
    }

    // Pontuação por duração (0-20 pontos)
    const candidateDuration = candidate.lengthSeconds ?? candidate.duration;
    if (candidateDuration && trackDurationMs) {
      const diff = Math.abs((candidateDuration * 1000) - trackDurationMs);
      const tolerance = Math.max(trackDurationMs * 0.35, 45000);
      const durationMatch = Math.max(0, 1 - (diff / tolerance));
      score += durationMatch * 20;
    }

    // Bonus para correspondências exatas
    if (candidateTitle.includes(trackName) || trackName.includes(candidateTitle)) {
      score += 10;
    }

    // Penalidades
    const negativeTerms = ['cover', 'remix', 'reaction', 'tutorial', 'instrumental', 'karaoke', 'live'];
    if (negativeTerms.some(term => candidateTitle.includes(term) && !trackName.includes(term))) {
      score -= 15;
    }

    return score;
  }

  async function findVideoForTrack(track) {
    const artists = getTrackArtists(track);
    const durationMs = extractDurationMs(track);

    // Busca via YouTube (scraping)
    const result = await searchPlayDl(track.name, artists, durationMs);

    if (result) {
      return result;
    }

    console.warn(`❌ [SEARCH FAILED] No results found for: "${track.name}"`);
    return null;
  }

  // Obtém duração do áudio a partir da URL (usado para preset videoId)
  async function getAudioDuration(audioUrl, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const tempAudio = new Audio();
      let resolved = false;
      
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        tempAudio.src = '';
        tempAudio.load();
      };
      
      const timeout = setTimeout(() => {
        cleanup();
        resolve(0);
      }, timeoutMs);
      
      tempAudio.addEventListener('loadedmetadata', () => {
        clearTimeout(timeout);
        const duration = Math.floor(tempAudio.duration);
        cleanup();
        resolve(duration > 0 ? duration : 0);
      }, { once: true });
      
      tempAudio.addEventListener('error', () => {
        clearTimeout(timeout);
        cleanup();
        resolve(0);
      }, { once: true });
      
      tempAudio.preload = 'metadata';
      tempAudio.src = audioUrl;
    });
  }

  const INVIDIOUS_INSTANCES = [
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://invidious.f5.si',
    'https://yt.chocolatemoo53.com',
    'https://invidious.tiekoetter.com',
    'https://invidious.asir.dev'
  ];

  // Busca URL de áudio diretamente do frontend nas APIs públicas do Invidious.
  // Evita o bloqueio 403 do datacenter da Netlify executando direto do IP residencial.
  async function getAudioUrl(videoId, retryCount = 0, ctx = {}) {
    if (!videoId) return null;
    const logEvent = ctx.log || ((tag, msg) => console.log(`${tag} [AUDIO] ${msg}`));

    const cached = getCacheEntry(state.audioCache, videoId, AUDIO_URL_TTL_MS);
    if (cached !== null) {
      metrics.audioCache.hits += 1;
      logEvent('🎵', `Cache: hit (${videoId})`);
      return cached;
    }
    if (retryCount === 0) metrics.audioCache.misses += 1;

    // Embaralha instâncias para balancear carga e tentar aleatoriamente
    const instances = [...INVIDIOUS_INSTANCES].sort(() => Math.random() - 0.5);

    for (const baseUrl of instances) {
      const startedAt = Date.now();
      try {
        logEvent('🔍', `Tentando Invidious: ${baseUrl} (${videoId})`);
        
        const response = await fetch(`${baseUrl}/api/v1/videos/${videoId}`, {
          // Sinal de timeout para não prender o player em instâncias lentas
          signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) {
           logEvent('⚠️', `Invidious HTTP ${response.status} em ${baseUrl}`);
           continue;
        }

        const data = await response.json();
        let audioUrl = null;

        // Tenta achar áudio no adaptiveFormats
        if (data.adaptiveFormats && data.adaptiveFormats.length > 0) {
          const audioFormats = data.adaptiveFormats.filter(f => f.type && f.type.startsWith('audio'));
          if (audioFormats.length > 0) {
            audioUrl = audioFormats[0].url;
          }
        }
        
        // Fallback: tenta achar no formatStreams
        if (!audioUrl && data.formatStreams && data.formatStreams.length > 0) {
          const audioFormats = data.formatStreams.filter(f => !f.resolution || f.resolution === 'Audio');
          if (audioFormats.length > 0) {
            audioUrl = audioFormats[0].url;
          }
        }

        if (audioUrl) {
          const elapsed = Date.now() - startedAt;
          logEvent('✅', `Sucesso via Invidious: ${baseUrl} em ${elapsed}ms`);
          
          setCacheEntry(state.audioCache, videoId, audioUrl);
          debouncedSave();
          
          return audioUrl;
        } else {
           logEvent('⚠️', `Sem formatos de áudio em ${baseUrl}`);
        }
      } catch (err) {
        logEvent('❌', `Falha de rede em ${baseUrl}: ${err.message}`);
      }
    }

    logEvent('🚫', `Todas as instâncias Invidious falharam para ${videoId}`);
    return null;
  }

  function findNextPlayableIndex(startIndex = 0) {
    // Usa as tracks de reprodução apenas para playlists da biblioteca
    const tracksToUse = hasLibraryPlaybackQueue() ? state.playingTracks : state.tracks;
    for (let i = startIndex; i < tracksToUse.length; i++) {
      if (!tracksToUse[i].unavailable) return i;
    }
    return -1;
  }

  async function playNextFrom(startIndex) {
    if (advanceScheduled || advancingToNext) return;
    advanceScheduled = true;
    advancingToNext = true;
    try {
      const nextIndex = findNextPlayableIndex(startIndex);
      if (nextIndex === -1) {
        stopPlaybackCountdown({ resetLabel: true });
        state.isPlaying = false;
        resetPlaybackState();
        state.currentTrackIndex = -1;
        updateUiState();
        return;
      }

      await playTrack(nextIndex);
    } finally {
      advancingToNext = false;
      advanceScheduled = false;
    }
  }

  // Toca a próxima música da playlist em reprodução (não da visualização)
  async function playNextFromPlaying(startIndex) {
    if (advanceScheduled || advancingToNext) return;
    advanceScheduled = true;
    advancingToNext = true;
    try {
      if (!hasLibraryPlaybackQueue()) {
        // Se não há tracks de reprodução da biblioteca, usa as de visualização
        await playNextFrom(startIndex);
        return;
      }

      // Encontra próxima track disponível nas tracks de reprodução
      let nextIndex = -1;
      for (let i = startIndex; i < state.playingTracks.length; i++) {
        if (!state.playingTracks[i].unavailable) {
          nextIndex = i;
          break;
        }
      }

      if (nextIndex === -1) {
        stopPlaybackCountdown({ resetLabel: true });
        state.isPlaying = false;
        resetPlaybackState();
        updateUiState();
        return;
      }

      // Toca a track das tracks de reprodução usando playTrack com flag
      await playTrackInternal(nextIndex, { fromPlayingTracks: true });
    } finally {
      advancingToNext = false;
      advanceScheduled = false;
    }
  }

  // Função interna unificada para reproduzir uma track
  async function playTrackInternal(index, options = {}) {
    const { fromPlayingTracks = false, useCrossfade = null } = options;
    const tracks = fromPlayingTracks ? state.playingTracks : state.tracks;

    if (!tracks.length || index < 0 || index >= tracks.length) {
      crossfadePending = false;
      return;
    }

    // Para a rádio se estiver tocando
    if (radioPlaying) stopRadio();

    // Cancela crossfade em andamento se o usuário trocar manualmente
    cancelCrossfade();

    // Se este é um crossfade automático, re-seta a flag após o cancelCrossfade
    if (useCrossfade) {
      crossfadePending = true;
    }

    // Limpa estado de reprodução do YouTube quando inicia reprodução de playlist normal
    if (!fromPlayingTracks || (youtubePlayingVideoId && state.playingPlaylistId !== 'youtube-search')) {
      clearYouTubePlaybackState({ updateUi: false });
    }

    const requestId = ++state.playRequestId;
    const isStale = () => requestId !== state.playRequestId;

    const track = tracks[index];
    if (track.unavailable) {
      crossfadePending = false;
      if (fromPlayingTracks) {
        playNextFromPlaying(index + 1);
      } else {
        playNextFrom(index + 1);
      }
      return;
    }

    // Reseta o progresso da faixa anterior (apenas se não for das playingTracks)
    if (!fromPlayingTracks && state.currentTrackIndex >= 0 && state.currentTrackIndex !== index) {
      resetTrackProgress(state.currentTrackIndex);
    }

    stopPlaybackCountdown({ resetLabel: true });

    if (fromPlayingTracks) {
      state.playingTrackIndex = index;
      // Se a playlist em reprodução é a mesma da visualização, sincroniza
      if (isViewingPlayingPlaylist()) {
        state.currentTrackIndex = index;
      }
    } else {
      state.currentTrackIndex = index;
      // Salva o estado de reprodução
      state.playingPlaylistId = state.currentPlaylist?.id || null;
      state.playingTrackIndex = index;
      state.playingTracks = [...state.tracks];
    }

    state.isLoadingTrack = true;
    if (!fromPlayingTracks) {
      setTrackLoading(index, true);
    }
    updateUiState();

    // Instrumentação TTFP: mede do gesto do usuário até o áudio tocando
    beginPlayTiming(track.name || 'desconhecida');

    // Reprioriza o preload ao redor da faixa e pausa novos inícios de preload
    // enquanto a faixa atual está sendo preparada (prioridade à reprodução)
    preloadScheduler.reprioritizeAround(index);
    preloadScheduler.pause();

    // Reseta o modo Vídeo para a nova faixa (re-detecta o clipe e reentra se aplicável).
    videoMode.onTrackChanged();

    debouncedSave();

    try {
      const shouldCrossfade = useCrossfade === true;
      // Overlap: o reset do elemento de áudio (~100ms) roda em paralelo com a
      // resolução da URL em vez de somar ao caminho crítico depois dela.
      const resetPromise = shouldCrossfade ? null : resetAudioWithDelay(audio);

      let audioUrl = await getTrackAudioUrl(track, index);

      if (!audioUrl) {
        metrics.playback.recoveries += 1;
        const refreshed = await resolveTrackWithCache(track, index, { forceRefresh: true });
        audioUrl = refreshed?.audioUrl || null;
      }

      markPlayPhase('resolucao');
      if (isStale()) return;

      if (!audioUrl) {
        if (fromPlayingTracks) {
          track.unavailable = true;
          playNextFromPlaying(index + 1);
        } else {
          skipUnavailableTrack(index);
        }
        return;
      }

      let played = false;
      if (shouldCrossfade) {
        played = await playWithCrossfade(audioUrl, { isStale });
      } else {
        await resetPromise;
        loadAudioSource(audioUrl, audio);
        markPlayPhase('carregamento');
        if (isStale()) return;
        played = await tryPlayElement(audio);
      }
      if (isStale()) return;

      if (!played) {
        // Se não conseguiu reproduzir após tentativas, tenta recuperação
        console.warn(`⚠️ [PLAY] Failed to play after attempts, trying recovery...`);
        metrics.playback.recoveries += 1;
        const refreshed = await resolveTrackWithCache(track, index, { forceRefresh: true });
        if (refreshed?.audioUrl && !isStale()) {
          if (shouldCrossfade) {
            played = await playWithCrossfade(refreshed.audioUrl, { isStale });
          } else {
            await resetAudioWithDelay(audio);
            loadAudioSource(refreshed.audioUrl, audio);
            try {
              await audio.play();
              markPlaybackSuccess(index);
              return;
            } catch (retryErr) {
              console.warn(`⚠️ [PLAY] Recovery also failed: ${retryErr.message}`);
            }
          }
        }
        // Se ainda falhou, marca como indisponível
        if (fromPlayingTracks) {
          track.unavailable = true;
          playNextFromPlaying(index + 1);
        } else {
          skipUnavailableTrack(index);
        }
        return;
      }

      markPlaybackSuccess(index);

    } catch (error) {
      if (error.message?.includes('interrupted') || error.message?.includes('removed')) {
        state.isLoadingTrack = false;
        if (!isStale()) {
          setTimeout(() => playTrackInternal(index, options), 500);
        }
        return;
      }

      metrics.playback.recoveries += 1;
      const refreshed = await resolveTrackWithCache(track, index, { forceRefresh: true });
      if (refreshed?.audioUrl) {
        try {
          setAudioSource(refreshed.audioUrl);
          await delay(AUDIO_RESET_DELAY_MS);
          if (!isStale()) {
            await audio.play();
            markPlaybackSuccess(index);
            return;
          }
        } catch (retryError) {
          // Ignorar erro de retry
        }
      }

      if (fromPlayingTracks) {
        track.unavailable = true;
        playNextFromPlaying(index + 1);
      } else {
        skipUnavailableTrack(index);
      }
      state.isPlaying = false;
    } finally {
      preloadScheduler.resume();
      state.isLoadingTrack = false;
      crossfadePending = false;
      if (!isStale()) {
        updateUiState();
      }
    }
  }

  function togglePlayback() {
    // Se a rádio está tocando, para a rádio
    if (handleCtrlPlayForRadio()) return;

    // No modo Vídeo, o play/pause controla o player do YouTube.
    if (videoMode.isVideo()) {
      videoMode.togglePlay();
      return;
    }

    // Se estiver reproduzindo no YouTube, controla o áudio normalmente
    if (isPlayingFromYouTube()) {
      if (audio.paused) {
        startPlaying();
        startYouTubeSearchCountdown();
      } else {
        pausePlaying();
        stopYouTubeSearchCountdown();
      }
      updateUiState();
      updateYouTubeSearchHighlight();
      return;
    }

    // Se o áudio está tocando, sempre permite pausar
    if (!audio.paused) {
      pausePlaying();
      updateUiState();
      stopPlaybackCountdown({ resetLabel: false });
      saveCurrentStateToStorage(); // grava a posição exata ao pausar
      return;
    }

    // Retomada após reload/crash: nada carregado no <audio>, mas há uma fila de
    // reprodução restaurada — inicia a faixa (o salto para a posição é aplicado
    // em markPlaybackSuccess via pendingResume).
    if (!audio.src && hasLibraryPlaybackQueue() && state.playingTrackIndex >= 0) {
      playTrackInternal(state.playingTrackIndex, { fromPlayingTracks: true });
      return;
    }

    // Áudio pausado - verifica se há track para tocar
    if (!hasValidTrack()) {
      // Se tem áudio carregado (pausado de uma reprodução anterior), retoma
      if (audio.src && audio.currentTime > 0) {
        startPlaying();
        updateUiState();
        startPlaybackCountdown();
        return;
      }
      playNextFrom(0);
      return;
    }

    startPlaying();
    updateUiState();
    startPlaybackCountdown();
  }

  function updateTrackHighlight() {
    const isActuallyPlaying = isAudioPlaying();
    // Só destaca se a playlist de visualização é a mesma da reprodução
    const isSamePlaylist = isViewingPlayingPlaylist();
    const activeIndex = isSamePlaylist ? state.playingTrackIndex : -1;

    document.querySelectorAll('.track-item').forEach((item) => {
      const index = Number(item.dataset.trackIndex);
      item.classList.toggle('active', index === activeIndex);
      item.classList.toggle('playing', index === activeIndex && isActuallyPlaying);
    });
  }

  // Mostra/esconde spinner de loading na capa do álbum
  function setTrackLoading(index, isLoading) {
    document.querySelectorAll('.track-item').forEach((item) => {
      const itemIndex = Number(item.dataset.trackIndex);
      item.classList.toggle('loading', itemIndex === index && isLoading);
    });
  }


  // === RÁDIO SUNSHINE LIVE — Multi-canal ===
  const RADIO_CHANNELS = [
    { id: 'live',      name: 'Sunshine Live',   desc: 'O principal canal eletrônico',         icon: 'ph-radio',           color: '#ff7a1f', cover: 'assets/images/radio/sunshine-sunshine-logo_bg.webp',       url: 'https://stream.sunshine-live.de/live/mp3-128', featured: true },
    { id: '80er',      name: '80s',             desc: 'Synthpop, New Wave & Italo Disco',     icon: 'ph-cassette-tape',   color: '#e879f9', cover: 'assets/images/radio/Die80er.webp',        url: 'https://stream.sunshine-live.de/80er/mp3-128' },
    { id: '90er',      name: '90s',             desc: 'Eurodance, Trance & Rave clássico',    icon: 'ph-vinyl-record',    color: '#38bdf8', cover: 'assets/images/radio/Die90er.webp',        url: 'https://stream.sunshine-live.de/90er/mp3-128' },
    { id: '2000er',    name: '2000s',           desc: 'Electro, Progressive & Minimal',       icon: 'ph-disc',            color: '#4ade80', cover: 'assets/images/radio/2000er.webp',      url: 'https://stream.sunshine-live.de/2000er/mp3-128' },
    { id: '2010er',    name: '2010s',           desc: 'EDM, Future Bass & Big Room',          icon: 'ph-waveform',        color: '#fb923c', cover: 'assets/images/radio/2010er.webp',      url: 'https://stream.sunshine-live.de/2010er/mp3-128' },
    { id: 'edm',       name: 'EDM',             desc: 'Electronic Dance Music mainstream',    icon: 'ph-lightning',       color: '#facc15', cover: 'assets/images/radio/edm_bg.webp',        url: 'https://stream.sunshine-live.de/edm/mp3-128', featured: true },
    { id: 'classics',  name: 'Classics',        desc: 'Os clássicos eternos da eletrônica',   icon: 'ph-star',            color: '#c084fc', cover: 'assets/images/radio/classics.webp',   url: 'https://stream.sunshine-live.de/classics/mp3-128', featured: true },
    { id: 'dnb',       name: "Drum 'n' Bass",   desc: 'Breakbeats rápidos e graves pesados',  icon: 'ph-speaker-high',    color: '#f87171', cover: 'assets/images/radio/drumnbass.webp',        url: 'https://stream.sunshine-live.de/dnb/mp3-128' },
    { id: 'hardcore',  name: 'Hardcore',         desc: 'Gabber, Hardcore & Hardstyle',         icon: 'ph-fire',            color: '#ef4444', cover: 'assets/images/radio/hardcore.webp',   url: 'https://stream.sunshine-live.de/Hardcore/mp3-128' },
    { id: 'hardtechno',name: 'Hardtechno',       desc: 'Techno pesado e industrial',           icon: 'ph-skull',           color: '#a3a3a3', cover: 'assets/images/radio/hardtechno.webp', url: 'https://stream.sunshine-live.de/Hardtechno/mp3-128' },
    { id: 'melodicb',  name: 'Melodic Beats',   desc: 'Melodic Techno & Progressive',         icon: 'ph-music-notes',     color: '#67e8f9', cover: 'assets/images/radio/melodic_beats.webp',    url: 'https://stream.sunshine-live.de/MelodicB/mp3-128', featured: true },
    { id: 'blue',      name: 'Blue',            desc: 'Chillout, Lounge & Ambient',           icon: 'ph-cloud',           color: '#60a5fa', cover: 'assets/images/radio/blue.webp',       url: 'https://stream.sunshine-live.de/Blue/mp3-128' },
    { id: 'calmflow',  name: 'Calm Flow',       desc: 'Lo-fi, Downtempo & relaxamento',       icon: 'ph-leaf',            color: '#34d399', cover: 'assets/images/radio/calmflow_plain_1.webp',   url: 'https://stream.sunshine-live.de/calmflow/mp3-128', featured: true },
  ];

  let radioAudio = null;
  let radioPlaying = false;
  let radioLoading = false;
  let radioCurrentChannel = null;

  function initRadio() {
    radioAudio = document.getElementById('radio-audio-player');
    if (!radioAudio) return;

    const grid = document.getElementById('radio-channels-grid');
    const featuredRow = document.getElementById('radio-featured-row');
    if (grid) renderRadioChannels(grid, RADIO_CHANNELS, 'blue');
    if (featuredRow) renderRadioChannels(featuredRow, RADIO_CHANNELS.filter(ch => ch.featured), 'purple');

    radioAudio.addEventListener('playing', () => {
      radioPlaying = true;
      radioLoading = false;
      updateRadioChannelUI();
      updateRadioControlsBar();
    });

    radioAudio.addEventListener('pause', () => {
      radioPlaying = false;
      radioLoading = false;
      updateRadioChannelUI();
      updateRadioControlsBar();
    });

    radioAudio.addEventListener('error', () => {
      radioPlaying = false;
      radioLoading = false;
      updateRadioChannelUI();
      updateRadioControlsBar();
    });
  }

  function renderRadioChannels(container, channels, btnColor = 'blue') {
    const btnHex = btnColor === 'purple' ? '#8b5cf6' : '#3b82f6';
    container.innerHTML = channels.map(ch => `
      <div class="radio-channel-card group cursor-pointer rounded-xl overflow-hidden transition-all duration-300" 
           data-radio-id="${ch.id}" style="--accent: ${ch.color}; --btn-color: ${btnHex};">
        <div class="relative aspect-square">
          <img src="${ch.cover}" 
               alt="${ch.name}" 
               class="w-full h-full object-cover"
               onerror="if(this.src.indexOf('default.svg')===-1){this.src='assets/images/radio/default.svg'}else{this.src='assets/images/genericCover.png'}">
          <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent"></div>
          ${btnColor === 'purple' ? '<div class="absolute top-2 right-2 z-[2]"><i class="ph-fill ph-lightning text-orange-500 text-lg drop-shadow-lg"></i></div>' : ''}
          <div class="radio-card-darken"></div>
          <div class="radio-play-wrapper">
            <button class="radio-play-circle discover-play-circle liquid-glass" type="button" style="--btn-color: ${btnHex};">
              <span class="liquid-glass-edge"></span>
              <i class="ph-fill ph-play radio-icon-play discover-play-icon"></i>
              <i class="ph ph-spinner radio-icon-spinner"></i>
            </button>
          </div>
          <div class="radio-card-text absolute bottom-0 left-0 right-0 p-3">
            <p class="text-white font-semibold text-sm truncate">${ch.name}</p>
            <p class="text-white/50 text-xs truncate">${ch.desc}</p>
          </div>
        </div>
      </div>
    `).join('');

    container.addEventListener('click', (e) => {
      const card = e.target.closest('.radio-channel-card');
      if (!card) return;
      const id = card.dataset.radioId;
      const ch = RADIO_CHANNELS.find(c => c.id === id);
      if (!ch) return;

      if (radioPlaying && radioCurrentChannel?.id === id) {
        stopRadio();
      } else {
        startRadio(ch);
      }
    });
  }

  function startRadio(channel) {
    if (!radioAudio || !channel) return;
    if (state.isPlaying && audio) {
      pausePlaying();
      updateUiState();
    }
    radioCurrentChannel = channel;
    radioLoading = true;
    radioPlaying = false;
    updateRadioChannelUI();
    radioAudio.src = channel.url + '?t=' + Date.now();
    radioAudio.load();
    radioAudio.play().catch(() => {});
  }

  function stopRadio() {
    if (!radioAudio) return;
    radioAudio.pause();
    radioAudio.removeAttribute('src');
    radioAudio.load();
    radioCurrentChannel = null;
    radioPlaying = false;
    radioLoading = false;
    updateRadioChannelUI();
    updateRadioControlsBar();
  }

  function updateRadioChannelUI() {
    document.querySelectorAll('.radio-channel-card').forEach(card => {
      const isTarget = radioCurrentChannel?.id === card.dataset.radioId;
      card.classList.toggle('active', radioPlaying && isTarget);
      card.classList.toggle('loading', radioLoading && isTarget);
    });
  }

  function setRadioTransportDisabled(disabled) {
    [ui.ctrlShuffle, ui.ctrlPrev, ui.ctrlNext, ui.ctrlRepeat].forEach(btn => {
      if (!btn) return;
      btn.disabled = disabled;
      btn.classList.toggle('radio-disabled', disabled);
    });
  }

  function updateRadioControlsBar() {
    if (!radioPlaying || !radioCurrentChannel) {
      // Restaura o estado normal do controls bar
      const controlsBar = document.getElementById('player-controls-bar');
      if (controlsBar) controlsBar.classList.remove('radio-mode');

      // Reativa botões de transporte
      setRadioTransportDisabled(false);

      // Restaura o play button para controle de música
      const playIcon = ui.ctrlPlay?.querySelector('i');
      if (playIcon) playIcon.className = state.isPlaying ? 'ph-fill ph-pause' : 'ph-fill ph-play';

      // Restaura info da música e media session
      updateControlsBar();
      updateMediaSession();
      return;
    }

    const controlsBar = document.getElementById('player-controls-bar');
    if (controlsBar) controlsBar.classList.add('radio-mode');

    // Desativa botões de transporte (visíveis porém inativos)
    setRadioTransportDisabled(true);

    // Play/pause controla a rádio
    const playIcon = ui.ctrlPlay?.querySelector('i');
    if (playIcon) playIcon.className = 'ph-fill ph-stop';

    // Atualiza info com dados da rádio
    if (ui.ctrlTitle) ui.ctrlTitle.textContent = radioCurrentChannel.name;
    if (ui.ctrlArtist) ui.ctrlArtist.textContent = 'SUNSHINE LIVE · Ao Vivo';

    // Rádio ao vivo não tem letra sincronizada.
    clearLyrics();
    lyricsState.key = null;
    lyricsState.requestedKey = null;

    // Atualiza capa com imagem do canal
    const coverImg = ui.ctrlCover?.querySelector('img');
    if (coverImg) {
      coverImg.src = radioCurrentChannel.cover;
    }

    // Ativa animação de wave no cover
    ui.ctrlCover?.classList.add('playing');

    // Atualiza Media Session com dados da rádio
    updateRadioMediaSession();
  }

  function updateRadioMediaSession() {
    if (!('mediaSession' in navigator) || !radioCurrentChannel) return;

    const artwork = [];
    if (radioCurrentChannel.cover) {
      artwork.push({ src: radioCurrentChannel.cover, sizes: '512x512', type: 'image/jpeg' });
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: radioCurrentChannel.name,
      artist: 'SUNSHINE LIVE · Ao Vivo',
      album: radioCurrentChannel.desc || '',
      artwork
    });

    navigator.mediaSession.playbackState = radioPlaying ? 'playing' : 'none';

    // Para rádio: pause e stop ambos param a rádio
    navigator.mediaSession.setActionHandler('play', () => {
      if (radioCurrentChannel && !radioPlaying) startRadio(radioCurrentChannel);
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      if (radioPlaying) stopRadio();
    });

    try {
      navigator.mediaSession.setActionHandler('stop', () => {
        if (radioPlaying) stopRadio();
      });
    } catch (e) {}

    navigator.mediaSession.setActionHandler('previoustrack', null);
    navigator.mediaSession.setActionHandler('nexttrack', null);
    forceRemoveSeekHandlers();
  }

  // Sobrescreve o comportamento do play button quando rádio está ativa
  function handleCtrlPlayForRadio() {
    if (radioPlaying) {
      stopRadio();
      return true;
    }
    return false;
  }

  return { init, importPlaylistFromCsv, getMetrics: getMetricsSnapshot, ApiClient };
})();

if (typeof document !== 'undefined') {
  const startApp = async () => {
    await MUSIC_PLAYER.init();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp, { once: true });
  } else {
    startApp();
  }
}

/**
 * HyperMusic Player — API Pública
 * 
 * Uso:
 *   HyperMusicPlayer.open()   // Abre o modal do player
 *   HyperMusicPlayer.close()  // Fecha o modal do player (dispatch close event)
 *   HyperMusicPlayer.importCSV()  // Abre o diálogo de importação CSV
 *   HyperMusicPlayer.getMetrics() // Retorna snapshot de métricas internas
 * 
 * Eventos (no document):
 *   'hypermusic:open' — abre o player
 */
window.HyperMusicPlayer = {
  configure: (options) => MUSIC_PLAYER.ApiClient.configure(options),
  open: () => MUSIC_PLAYER.openModal(),
  importCSV: () => MUSIC_PLAYER.importPlaylistFromCsv?.(),
  getMetrics: () => MUSIC_PLAYER.getMetrics(),
  /** @internal Referência ao módulo completo para uso avançado */
  _internal: MUSIC_PLAYER
};
