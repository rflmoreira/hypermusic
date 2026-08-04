// Netlify Function - 4shared API proxy with OAuth 1.0 authentication
// Provides search and stream endpoints for music files as a fallback source

import { CORS_HEADERS, makeResponse } from './utils.js';

import { createHmac, randomBytes } from 'crypto';

const FOURSHARED_CONSUMER_KEY = process.env.FOURSHARED_CONSUMER_KEY;
const FOURSHARED_CONSUMER_SECRET = process.env.FOURSHARED_CONSUMER_SECRET;

// === OAuth 1.0 Signature Generation ===

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function generateNonce() {
  return randomBytes(16).toString('hex');
}

function generateTimestamp() {
  return Math.floor(Date.now() / 1000).toString();
}

/**
 * Generates OAuth 1.0 Authorization header for 4shared API requests.
 * Uses HMAC-SHA1 signature method with consumer credentials only (no user tokens needed for search).
 * For download endpoints, an access token would be needed but we use consumer-only auth
 * combined with the oauth_consumer_key parameter approach that 4shared supports for public files.
 */
function generateOAuthHeader(method, url, params = {}, tokenSecret = '') {
  const oauthParams = {
    oauth_consumer_key: FOURSHARED_CONSUMER_KEY,
    oauth_nonce: generateNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: generateTimestamp(),
    oauth_version: '1.0'
  };

  // Combine all parameters for signature base string
  const allParams = { ...params, ...oauthParams };

  // Sort parameters alphabetically
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys
    .map(key => `${percentEncode(key)}=${percentEncode(allParams[key])}`)
    .join('&');

  // Create signature base string
  const signatureBase = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString)
  ].join('&');

  // Create signing key (consumer_secret&token_secret)
  const signingKey = `${percentEncode(FOURSHARED_CONSUMER_SECRET)}&${percentEncode(tokenSecret)}`;

  // Generate HMAC-SHA1 signature
  const signature = createHmac('sha1', signingKey)
    .update(signatureBase)
    .digest('base64');

  oauthParams.oauth_signature = signature;

  // Build Authorization header
  const authHeader = 'OAuth ' + Object.keys(oauthParams)
    .sort()
    .map(key => `${percentEncode(key)}="${percentEncode(oauthParams[key])}"`)
    .join(', ');

  return authHeader;
}

// === 4shared API Functions ===

/**
 * Search for music files on 4shared.
 * Uses the search endpoint with category=1 (Music) and type=mp3.
 */
async function searchFiles(query, limit = 10) {
  const baseUrl = 'https://search.4shared.com/v1_2/files';
  const params = {
    query: query,
    category: '1', // Music category
    type: 'mp3',
    limit: String(Math.min(limit, 50)),
    offset: '0'
  };

  const queryString = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const fullUrl = `${baseUrl}?${queryString}`;
  const authHeader = generateOAuthHeader('GET', baseUrl, params);

  const response = await fetch(fullUrl, {
    method: 'GET',
    headers: {
      'Authorization': authHeader,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    console.error(`[4SHARED] Search failed: ${response.status} ${response.statusText}`);
    return [];
  }

  const data = await response.json();

  // Response format: { files: [...] }
  const files = data?.files || (Array.isArray(data) ? data : []);

  return files
    .filter(f => f && f.id && f.name)
    .map(f => ({
      id: f.id,
      name: cleanFileName(f.name),
      size: f.size || 0,
      downloadUrl: f.downloadUrl || null,
      downloadPage: f.downloadPage || null
    }));
}

/**
 * Get the download/stream URL for a specific file by scraping the download page.
 * The API's /download endpoint requires user-level OAuth tokens, so we scrape
 * the public download page to extract the direct link (same approach as YouTube scraping).
 */
async function getStreamUrl(fileId) {
  // First, get the file info to obtain the downloadPage URL
  const infoUrl = `https://api.4shared.com/v1_2/files/${fileId}`;
  const authHeader = generateOAuthHeader('GET', infoUrl);

  let downloadPageUrl;
  try {
    const infoRes = await fetch(infoUrl, {
      headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
    });
    if (infoRes.ok) {
      const info = await infoRes.json();
      downloadPageUrl = info?.downloadPage;
    }
  } catch (e) {
    console.warn(`[4SHARED] File info fetch failed: ${e.message}`);
  }

  // Fallback: construct the download page URL from the file ID
  if (!downloadPageUrl) {
    downloadPageUrl = `https://www.4shared.com/s/f${fileId}`;
  }

  // Scrape the download page for the direct download link
  try {
    const pageRes = await fetch(downloadPageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      redirect: 'follow'
    });

    if (!pageRes.ok) {
      console.error(`[4SHARED] Download page fetch failed: ${pageRes.status}`);
      return null;
    }

    const html = await pageRes.text();
    let streamUrl = null;

    // Strategy 1: Extract jsD1PreviewUrl hidden input (Best for streaming)
    const match = html.match(/class=["']jsD1PreviewUrl["'][^>]*value=["']([^"']+)["']/i) || 
                  html.match(/value=["']([^"']+)["'][^>]*class=["']jsD1PreviewUrl["']/i);
    
    if (match && match[1]) {
      streamUrl = match[1];
      console.log(`[4SHARED] Found jsD1PreviewUrl for ${fileId}`);
    }

    if (streamUrl) return streamUrl;

    // Strategy 2: Extract jsDirectDownloadLink hidden input (Fallback)
    const directLinkMatch = html.match(
      /id=["']jsDirectDownloadLink["'][^>]*value=["']([^"']+)["']/i
    );
    if (directLinkMatch?.[1]) {
      console.log(`[4SHARED] Found jsDirectDownloadLink for ${fileId}`);
      return directLinkMatch[1];
    }

    // Strategy 3: Look for any direct audio source
    const audioSrcMatch = html.match(
      /(?:audio|source)[^>]*src=["'](https?:\/\/[^"']+\.mp3[^"']*?)["']/i
    );
    if (audioSrcMatch?.[1]) {
      console.log(`[4SHARED] Found audio src for ${fileId}`);
      return audioSrcMatch[1];
    }

    console.warn(`[4SHARED] No stream URL found in download page for ${fileId}`);
    return null;
  } catch (e) {
    console.error(`[4SHARED] Download page scraping error: ${e.message}`);
    return null;
  }
}

/**
 * Clean file name — removes .mp3 extension and common file naming patterns.
 */
function cleanFileName(name) {
  return (name || '')
    .replace(/\.mp3$/i, '')
    .replace(/\s*\[.*?\]\s*/g, ' ')
    .replace(/\s*\(www\..*?\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// === Handler ===

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return makeResponse(405, { error: 'Method not allowed' });
  }

  if (!FOURSHARED_CONSUMER_KEY || !FOURSHARED_CONSUMER_SECRET) {
    console.error('[4SHARED] Consumer credentials not configured');
    return makeResponse(503, {
      error: '4shared service not configured. Set FOURSHARED_CONSUMER_KEY and FOURSHARED_CONSUMER_SECRET.'
    });
  }

  const { action, q, id, limit } = event.queryStringParameters || {};

  try {
    // Search for music files
    if (action === 'search' && q) {
      const maxResults = Math.min(parseInt(limit, 10) || 10, 50);
      const files = await searchFiles(q, maxResults);

      return makeResponse(200, {
        files,
        query: q,
        total: files.length
      });
    }

    // Stream audio for a file (proxied through this function)
    // The 4shared download URLs are IP-bound, so the same server that scraped
    // the page must also fetch the audio content.
    if (action === 'stream' && id) {
      const streamUrl = await getStreamUrl(id);

      if (!streamUrl) {
        return makeResponse(404, { error: 'Could not resolve stream URL' });
      }

      const rangeHeader = event.headers.range || event.headers.Range || '';
      let start = 0;
      let end = '';
      
      if (rangeHeader) {
        const parts = rangeHeader.replace(/bytes=/, "").split("-");
        start = parseInt(parts[0], 10) || 0;
        end = parts[1] ? parseInt(parts[1], 10) : '';
      }
      
      // Limit chunks to 2MB to safely fit within Netlify's 6MB Lambda payload limit (Base64 overhead is ~33%)
      const MAX_CHUNK = 2 * 1024 * 1024;
      let targetEnd = end !== '' ? end : start + MAX_CHUNK - 1;

      try {
        // Probe file size using a 1-byte GET request instead of HEAD.
        // Some CDNs block HEAD requests or omit Content-Length.
        const probeRes = await fetch(streamUrl, {
          method: 'GET',
          headers: {
             'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
             'Range': 'bytes=0-0'
          }
        });
        
        let contentLength = 0;
        if (probeRes.ok || probeRes.status === 206) {
          const cr = probeRes.headers.get('content-range');
          if (cr) {
            const match = cr.match(/\/(\d+)$/);
            if (match && match[1]) contentLength = parseInt(match[1], 10);
          } else {
            contentLength = parseInt(probeRes.headers.get('content-length') || '0', 10);
          }
        }
        
        if (contentLength > 0) {
          if (start >= contentLength) {
             return {
               statusCode: 416,
               headers: {
                 ...CORS_HEADERS,
                 'Content-Range': `bytes */${contentLength}`
               },
               body: ''
             };
          }
          if (targetEnd >= contentLength) {
            targetEnd = contentLength - 1;
          }
        }

        const proxyRes = await fetch(streamUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
            'Range': `bytes=${start}-${targetEnd}`
          }
        });

        if (!proxyRes.ok && proxyRes.status !== 206) {
          return makeResponse(proxyRes.status, { error: 'Failed to proxy audio stream' });
        }

        const arrayBuffer = await proxyRes.arrayBuffer();
        const base64Body = Buffer.from(arrayBuffer).toString('base64');

        const headers = {
          ...CORS_HEADERS,
          'Content-Type': proxyRes.headers.get('content-type') || 'audio/mpeg',
          'Accept-Ranges': 'bytes',
          'X-Debug-Content-Length': String(contentLength),
          'X-Debug-Target-End': String(targetEnd)
        };

        const contentRange = proxyRes.headers.get('content-range');
        if (contentRange) {
           headers['Content-Range'] = contentRange;
        }
        
        headers['Content-Length'] = arrayBuffer.byteLength.toString();

        return {
          statusCode: proxyRes.status, // typically 206 or 200
          headers,
          body: base64Body,
          isBase64Encoded: true
        };
      } catch (error) {
        console.error('Proxy stream error:', error);
        return makeResponse(500, { error: 'Internal server error while streaming' });
      }
    }

    return makeResponse(400, {
      error: 'Use action=search&q=query or action=stream&id=fileId'
    });
  } catch (error) {
    console.error('[4SHARED] Error:', error.message);
    return makeResponse(500, { error: error.message || 'Internal error' });
  }
};
