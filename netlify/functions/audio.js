// Netlify Function - Extrai áudio do YouTube e faz proxy usando YTDL-Core
// Usa cabeçalhos HTTP Range para contornar o limite de 10 segundos da Lambda.

import { CORS_HEADERS, makeResponse } from './utils.js';
import ytdl from '@distube/ytdl-core';
import https from 'https';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return makeResponse(405, { error: 'Method not allowed' });
  }

  const { v: videoId, stream } = event.queryStringParameters || {};

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    console.warn(`[AUDIO] Rejected invalid videoId: "${videoId}"`);
    return makeResponse(400, { error: 'Invalid or missing video ID', reason: 'invalid-video-id', retryable: false });
  }

  try {
    // 1. Obter informações e a URL direta do YouTube
    const info = await ytdl.getInfo(videoId);
    const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });

    if (!format || !format.url) {
      console.warn(`[AUDIO] Format not found for video: ${videoId}`);
      return makeResponse(404, { error: 'No audio stream found', reason: 'format-not-found', retryable: false });
    }

    // Se NÃO for a requisição de streaming, retornamos JSON para o player.js
    if (!stream) {
      const title = info.videoDetails?.title || '';
      const durationStr = info.videoDetails?.lengthSeconds;
      const duration = durationStr ? parseInt(durationStr, 10) : 0;
      
      return makeResponse(200, {
        videoId,
        audioUrl: `/.netlify/functions/audio?v=${videoId}&stream=1`,
        title,
        duration
      });
    }

    // 2. Modo Proxy (stream=1) - Repassando a requisição para o YouTube
    // Extrai o header Range que o <audio> do navegador envia (ex: bytes=0-1000)
    const rangeHeader = event.headers.range || event.headers.Range;

    // Fazer a requisição para a URL do YouTube repassando o Range
    return new Promise((resolve) => {
      const options = {
        method: 'GET',
        headers: {}
      };
      
      if (rangeHeader) {
        options.headers['Range'] = rangeHeader;
      }

      const req = https.request(format.url, options, (res) => {
        const headers = { ...CORS_HEADERS };
        
        // Repassar os headers relevantes do YouTube para o cliente
        if (res.headers['content-type']) headers['Content-Type'] = res.headers['content-type'];
        if (res.headers['content-length']) headers['Content-Length'] = res.headers['content-length'];
        if (res.headers['content-range']) headers['Content-Range'] = res.headers['content-range'];
        if (res.headers['accept-ranges']) headers['Accept-Ranges'] = res.headers['accept-ranges'];

        // Lê a resposta do YouTube para a memória antes de enviar 
        // (necessário porque Netlify Functions não suportam true stream)
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            headers,
            body: bodyBuffer.toString('base64'),
            isBase64Encoded: true
          });
        });
      });

      req.on('error', (err) => {
        console.error(`[AUDIO PROXY] Request error: ${err.message}`);
        resolve(makeResponse(502, { error: 'Upstream network error' }));
      });
      
      // Netlify Functions limit to ~10s. Set a 5s timeout on our end.
      req.setTimeout(5000, () => {
        console.error('[AUDIO PROXY] Timeout waiting for youtube data');
        req.destroy();
        resolve(makeResponse(504, { error: 'Upstream timeout' }));
      });

      req.end();
    });

  } catch (error) {
    console.error(`[AUDIO] Failed to fetch info for ${videoId}: ${error.message}`);
    
    // Classifica o erro
    let reason = 'internal-error';
    let retryable = true;
    const msg = error.message.toLowerCase();
    
    if (msg.includes('private') || msg.includes('unavailable') || msg.includes('not exist')) {
      reason = 'video-not-found';
      retryable = false;
    } else if (msg.includes('copyright') || msg.includes('blocked')) {
      reason = 'video-blocked';
      retryable = false;
    } else if (msg.includes('sign in')) {
      reason = 'age-restricted';
      retryable = false;
    }
    
    return makeResponse(retryable ? 502 : 404, { 
      error: 'Could not extract audio', 
      reason, 
      detail: error.message, 
      retryable 
    });
  }
};
