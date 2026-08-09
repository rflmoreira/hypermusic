// Netlify Function - YouTube video search via scraping

import { CORS_HEADERS, makeResponse } from './utils.js';

async function fetchYouTubeHTML(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error(`YouTube fetch failed: ${response.status}`);
  }

  return response.text();
}

function parseYouTubeInitialData(html) {
  let jsonData = null;
  
  const pattern1 = /var\s+ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s;
  let match = html.match(pattern1);
  if (match) {
    try { jsonData = JSON.parse(match[1]); } catch (e) {}
  }
  
  if (!jsonData) {
    const pattern2 = /ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s;
    match = html.match(pattern2);
    if (match) {
      try { jsonData = JSON.parse(match[1]); } catch (e) {}
    }
  }
  
  if (!jsonData) {
    const startMarker = 'var ytInitialData = ';
    const startIdx = html.indexOf(startMarker);
    if (startIdx !== -1) {
      const jsonStart = startIdx + startMarker.length;
      let depth = 0, jsonEnd = jsonStart, inString = false, escapeNext = false;
      
      for (let i = jsonStart; i < html.length && i < jsonStart + 500000; i++) {
        const char = html[i];
        if (escapeNext) { escapeNext = false; continue; }
        if (char === '\\' && inString) { escapeNext = true; continue; }
        if (char === '"' && !escapeNext) { inString = !inString; continue; }
        if (!inString) {
          if (char === '{') depth++;
          else if (char === '}') {
            depth--;
            if (depth === 0) { jsonEnd = i + 1; break; }
          }
        }
      }
      
      if (jsonEnd > jsonStart) {
        try { jsonData = JSON.parse(html.slice(jsonStart, jsonEnd)); } catch (e) {}
      }
    }
  }
  
  return jsonData;
}

async function searchYouTubePlaylists(query, limit = 10) {
  // Busca com "playlist" na query para melhorar resultados
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query + ' playlist')}`;
  
  const html = await fetchYouTubeHTML(searchUrl);
  const jsonData = parseYouTubeInitialData(html);
  
  if (!jsonData) {
    console.error('[PLAYLIST SEARCH] Could not parse ytInitialData');
    return [];
  }

  const playlists = [];
  const seenIds = new Set();
  
  // Função recursiva para encontrar playlists em qualquer formato
  function findPlaylists(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 25 || playlists.length >= limit) return;
    
    // Formato antigo: playlistRenderer
    if (obj.playlistRenderer?.playlistId) {
      const playlist = obj.playlistRenderer;
      if (!seenIds.has(playlist.playlistId)) {
        seenIds.add(playlist.playlistId);
        
        // Tenta extrair videoCount de múltiplas fontes
        let videoCount = 0;
        
        // Fonte 1: videoCount direto
        if (playlist.videoCount) {
          videoCount = parseInt(String(playlist.videoCount).replace(/\D/g, ''), 10) || 0;
        }
        
        // Fonte 2: videoCountText
        if (!videoCount && playlist.videoCountText?.simpleText) {
          videoCount = parseInt(String(playlist.videoCountText.simpleText).replace(/\D/g, ''), 10) || 0;
        }
        
        // Fonte 3: videoCountShortText
        if (!videoCount && playlist.videoCountShortText?.simpleText) {
          videoCount = parseInt(String(playlist.videoCountShortText.simpleText).replace(/\D/g, ''), 10) || 0;
        }
        
        // Fonte 4: thumbnailText (overlay no thumbnail que mostra "100 videos")
        if (!videoCount && playlist.thumbnailText?.runs) {
          for (const run of playlist.thumbnailText.runs) {
            const match = (run.text || '').match(/(\d+)/);
            if (match) {
              videoCount = parseInt(match[1], 10);
              break;
            }
          }
        }
        
        // Fonte 5: sidebarThumbnails length ou videoCountText em runs
        if (!videoCount && playlist.videoCountText?.runs) {
          for (const run of playlist.videoCountText.runs) {
            const match = (run.text || '').match(/(\d+)/);
            if (match) {
              videoCount = parseInt(match[1], 10);
              break;
            }
          }
        }
        
        let thumbnail = '';
        if (playlist.thumbnails?.[0]?.thumbnails) {
          thumbnail = playlist.thumbnails[0].thumbnails.slice(-1)[0]?.url || '';
        } else if (playlist.thumbnail?.thumbnails) {
          thumbnail = playlist.thumbnail.thumbnails.slice(-1)[0]?.url || '';
        }
        
        let author = playlist.ownerText?.runs?.[0]?.text || playlist.shortBylineText?.runs?.[0]?.text || '';
        // Remove padrões como "X vídeos", "X videos" do author
        author = author.replace(/\d+\s*(vídeos?|videos?|músicas?|musicas?|songs?)/gi, '').trim();
        
        playlists.push({
          type: 'playlist',
          playlistId: playlist.playlistId,
          title: playlist.title?.simpleText || playlist.title?.runs?.[0]?.text || '',
          author: author,
          videoCount: videoCount,
          thumbnail: thumbnail
        });
      }
      return;
    }
    
    // Formato novo: lockupViewModel com playlistId
    if (obj.lockupViewModel) {
      const lockup = obj.lockupViewModel;
      const contentId = lockup.contentId;
      
      // Verifica se é uma playlist (começa com PL, OL, ou RD)
      if (contentId && (contentId.startsWith('PL') || contentId.startsWith('OL'))) {
        if (!seenIds.has(contentId)) {
          seenIds.add(contentId);
          
          const metadata = lockup.metadata?.lockupMetadataViewModel;
          const title = metadata?.title?.content || '';
          
          // Tenta extrair informações de várias fontes possíveis
          let subtitle = '';
          let videoCount = 0;
          
          // Tenta pegar do metadataRows
          const metadataRows = metadata?.metadata?.contentMetadataViewModel?.metadataRows || [];
          for (const row of metadataRows) {
            const parts = row.metadataParts || [];
            for (const part of parts) {
              const text = part.text?.content || '';
              if (text) {
                subtitle += (subtitle ? ' • ' : '') + text;
                // Tenta extrair número de vídeos
                const countMatch = text.match(/(\d+)/);
                if (countMatch && !videoCount) {
                  videoCount = parseInt(countMatch[1], 10);
                }
              }
            }
          }
          
          // Tenta pegar videoCount de outras fontes
          if (!videoCount && lockup.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.overlays) {
            const overlays = lockup.contentImage.collectionThumbnailViewModel.primaryThumbnail.thumbnailViewModel.overlays;
            for (const overlay of overlays) {
              const text = overlay.thumbnailOverlayBadgeViewModel?.thumbnailBadges?.[0]?.thumbnailBadgeViewModel?.text || '';
              const match = text.match(/(\d+)/);
              if (match) {
                videoCount = parseInt(match[1], 10);
                break;
              }
            }
          }
          
          let thumbnail = '';
          const thumbUrl = lockup.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources?.[0]?.url;
          if (thumbUrl) thumbnail = thumbUrl;
          
          // Extrai autor do subtitle - remove a parte de contagem de vídeos
          let author = subtitle.split('•')[0]?.trim() || '';
          // Remove padrões como "X vídeos", "X videos", "X músicas" do author
          author = author.replace(/\d+\s*(vídeos?|videos?|músicas?|musicas?|songs?)/gi, '').trim();
          
          playlists.push({
            type: 'playlist',
            playlistId: contentId,
            title: title,
            author: author,
            videoCount: videoCount,
            thumbnail: thumbnail
          });
        }
      }
      return;
    }
    
    // Procura por playlistId em qualquer lugar e tenta extrair info
    if (obj.playlistId && typeof obj.playlistId === 'string') {
      const pid = obj.playlistId;
      if ((pid.startsWith('PL') || pid.startsWith('OL')) && !seenIds.has(pid)) {
        seenIds.add(pid);
        
        // Tenta encontrar título e thumbnail no mesmo objeto ou pai
        let title = obj.title?.simpleText || obj.title?.runs?.[0]?.text || 
                    obj.headline?.simpleText || obj.headline?.runs?.[0]?.text || '';
        let thumbnail = '';
        if (obj.thumbnail?.thumbnails) {
          thumbnail = obj.thumbnail.thumbnails.slice(-1)[0]?.url || '';
        } else if (obj.thumbnails?.[0]?.thumbnails) {
          thumbnail = obj.thumbnails[0].thumbnails.slice(-1)[0]?.url || '';
        }
        
        if (title) {
          let author = obj.shortBylineText?.runs?.[0]?.text || obj.ownerText?.runs?.[0]?.text || '';
          // Remove padrões como "X vídeos", "X videos" do author
          author = author.replace(/\d+\s*(vídeos?|videos?|músicas?|musicas?|songs?)/gi, '').trim();
          
          playlists.push({
            type: 'playlist',
            playlistId: pid,
            title: title,
            author: author,
            videoCount: parseInt(String(obj.videoCount || '0').replace(/\D/g, ''), 10) || 0,
            thumbnail: thumbnail
          });
        }
      }
    }
    
    // Continua buscando recursivamente
    if (Array.isArray(obj)) {
      for (const item of obj) {
        findPlaylists(item, depth + 1);
      }
    } else {
      for (const key of Object.keys(obj)) {
        if (key !== 'responseContext' && key !== 'trackingParams') {
          findPlaylists(obj[key], depth + 1);
        }
      }
    }
  }
  
  findPlaylists(jsonData);
  
  return playlists;
}

async function searchYouTube(query, limit = 50) {
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  
  const html = await fetchYouTubeHTML(searchUrl);
  const jsonData = parseYouTubeInitialData(html);
  
  if (!jsonData) {
    throw new Error('Could not parse YouTube response');
  }

  const contents = jsonData?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
  const videos = [];
  
  for (const section of contents) {
    const items = section?.itemSectionRenderer?.contents || [];
    
    for (const item of items) {
      const video = item.videoRenderer;
      if (video?.videoId) {
        const durationText = video.lengthText?.simpleText || '0:00';
        let durationSeconds = 0;
        const timeParts = durationText.match(/(\d+):(\d+)(?::(\d+))?/);
        if (timeParts) {
          durationSeconds = timeParts[3]
            ? parseInt(timeParts[1]) * 3600 + parseInt(timeParts[2]) * 60 + parseInt(timeParts[3])
            : parseInt(timeParts[1]) * 60 + parseInt(timeParts[2]);
        }

        videos.push({
          type: 'video',
          videoId: video.videoId,
          title: video.title?.runs?.[0]?.text || '',
          author: video.ownerText?.runs?.[0]?.text || '',
          lengthSeconds: durationSeconds,
          thumbnail: video.thumbnail?.thumbnails?.slice(-1)[0]?.url || ''
        });

        if (videos.length >= limit) break;
      }
    }
    if (videos.length >= limit) break;
  }

  return videos;
}

const INNERTUBE_CLIENT_CONTEXT = {
  client: {
    clientName: 'WEB',
    clientVersion: '2.20241126.01.00',
    hl: 'en',
    gl: 'US'
  }
};

// Converte um texto de duração ("16:09" ou "1:02:33") para segundos
function parseDurationToSeconds(text) {
  const timeParts = String(text || '').match(/(\d+):(\d+)(?::(\d+))?/);
  if (!timeParts) return 0;
  return timeParts[3]
    ? parseInt(timeParts[1], 10) * 3600 + parseInt(timeParts[2], 10) * 60 + parseInt(timeParts[3], 10)
    : parseInt(timeParts[1], 10) * 60 + parseInt(timeParts[2], 10);
}

// Extrai um vídeo a partir do novo formato lockupViewModel
function parseLockupVideo(lockup) {
  if (!lockup || lockup.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;

  const videoId = lockup.contentId;
  if (!videoId) return null;

  const metadata = lockup.metadata?.lockupMetadataViewModel;
  const title = metadata?.title?.content || '';
  const author = metadata?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || '';

  // Duração fica num badge sobreposto ao thumbnail (ex.: "16:09")
  let durationText = '';
  const overlays = lockup.contentImage?.thumbnailViewModel?.overlays || [];
  for (const overlay of overlays) {
    const badges = overlay?.thumbnailBottomOverlayViewModel?.badges || [];
    for (const badge of badges) {
      const text = badge?.thumbnailBadgeViewModel?.text;
      if (text && /\d+:\d+/.test(text)) {
        durationText = text;
        break;
      }
    }
    if (durationText) break;
  }

  const sources = lockup.contentImage?.thumbnailViewModel?.image?.sources || [];
  const thumbnail = sources.length
    ? sources[sources.length - 1].url
    : `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

  return {
    videoId,
    title,
    author,
    lengthSeconds: parseDurationToSeconds(durationText),
    thumbnail
  };
}

// Percorre a resposta da InnerTube coletando vídeos (lockupViewModel) e o token de continuação
function collectLockupVideos(node, videos, limit, seenIds, tokenRef, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return;

  if (node.lockupViewModel) {
    const video = parseLockupVideo(node.lockupViewModel);
    if (video && !seenIds.has(video.videoId) && videos.length < limit) {
      seenIds.add(video.videoId);
      videos.push(video);
    }
  }

  if (node.continuationItemRenderer) {
    const token = node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (token) tokenRef.token = token;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectLockupVideos(item, videos, limit, seenIds, tokenRef, depth + 1);
    }
  } else {
    for (const key of Object.keys(node)) {
      if (key === 'responseContext' || key === 'trackingParams') continue;
      collectLockupVideos(node[key], videos, limit, seenIds, tokenRef, depth + 1);
    }
  }
}

async function getPlaylistVideos(playlistId, limit = 100) {
  // A página HTML da playlist não expõe mais os vídeos server-side; usa a API InnerTube.
  let data = await fetchInnertubeBrowse({ browseId: `VL${playlistId}` });

  if (!data) {
    throw new Error('Could not parse YouTube playlist response');
  }

  const videos = [];
  const seenIds = new Set();
  const tokenRef = { token: null };

  collectLockupVideos(data, videos, limit, seenIds, tokenRef);

  // Pagina enquanto houver token e não tiver atingido o limite
  let pages = 0;
  while (tokenRef.token && videos.length < limit && pages < 10) {
    const token = tokenRef.token;
    tokenRef.token = null;
    pages++;

    try {
      data = await fetchInnertubeBrowse({ continuation: token });
      if (!data) break;
      collectLockupVideos(data, videos, limit, seenIds, tokenRef);
    } catch (e) {
      console.error('[PLAYLIST] Continuation fetch error:', e.message);
      break;
    }
  }

  const playlistInfo = extractPlaylistInfo(data, videos.length);

  return { playlistInfo, videos: videos.slice(0, limit) };
}

// Best-effort: extrai informações gerais da playlist quando disponíveis
function extractPlaylistInfo(data, videoCount) {
  const headerViewModel = data?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel;
  const title = headerViewModel?.title?.dynamicTextViewModel?.text?.content
    || data?.metadata?.playlistMetadataRenderer?.title
    || '';

  return {
    title,
    author: '',
    videoCount: videoCount || 0,
    thumbnail: ''
  };
}

async function fetchInnertubeBrowse(payload) {
  const apiUrl = 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false';

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    body: JSON.stringify({
      context: INNERTUBE_CLIENT_CONTEXT,
      ...payload
    })
  });

  if (!response.ok) {
    throw new Error(`InnerTube browse failed: ${response.status}`);
  }

  return response.json();
}

async function getVideoInfo(videoId) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  
  const html = await fetchYouTubeHTML(videoUrl);
  
  // Tenta extrair ytInitialPlayerResponse
  let playerData = null;
  const playerPattern = /var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|<\/script>)/s;
  let match = html.match(playerPattern);
  if (match) {
    try { playerData = JSON.parse(match[1]); } catch (e) {}
  }
  
  if (!playerData) {
    const pattern2 = /ytInitialPlayerResponse\s*=\s*(\{.+?\});/s;
    match = html.match(pattern2);
    if (match) {
      try { playerData = JSON.parse(match[1]); } catch (e) {}
    }
  }
  
  if (!playerData) {
    throw new Error('Could not parse video info');
  }
  
  const videoDetails = playerData?.videoDetails || {};
  const lengthSeconds = parseInt(videoDetails.lengthSeconds, 10) || 0;
  
  return {
    videoId: videoId,
    title: videoDetails.title || '',
    author: videoDetails.author || '',
    lengthSeconds: lengthSeconds,
    thumbnail: videoDetails.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
  };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return makeResponse(405, { error: 'Method not allowed' });
  }

  const { action, q, limit, offset, playlistId, type, videoId } = event.queryStringParameters || {};

  try {
    if (action === 'video' && videoId) {
      const info = await getVideoInfo(videoId);
      return makeResponse(200, info);
    }
    
    if (action === 'search' && q) {
      const maxResults = Math.min(parseInt(limit, 10) || 10, 50);
      const skipResults = parseInt(offset, 10) || 0;
      const totalNeeded = skipResults + maxResults + 1;
      
      // Se type=playlists, busca apenas playlists
      if (type === 'playlists') {
        const playlists = await searchYouTubePlaylists(q, maxResults);
        return makeResponse(200, {
          videos: [],
          playlists: playlists,
          hasMore: false,
          total: playlists.length
        });
      }
      
      // Busca apenas videos (comportamento padrão)
      const videos = await searchYouTube(q, totalNeeded);
      const paginatedVideos = videos.slice(skipResults, skipResults + maxResults);
      const hasMore = videos.length > skipResults + maxResults;
      
      return makeResponse(200, {
        videos: paginatedVideos,
        playlists: [],
        hasMore: hasMore,
        total: videos.length
      });
    }
    
    if (action === 'playlist' && playlistId) {
      const maxResults = Math.min(parseInt(limit, 10) || 100, 200);
      const result = await getPlaylistVideos(playlistId, maxResults);
      return makeResponse(200, result);
    }
    
    return makeResponse(400, { error: 'Use action=search&q=query or action=playlist&playlistId=ID' });
  } catch (error) {
    console.error('YouTube error:', error);
    return makeResponse(500, { error: error.message || 'Internal error' });
  }
};
