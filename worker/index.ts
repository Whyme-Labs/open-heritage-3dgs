interface Env {
  SCENES: R2Bucket;
  ASSETS: Fetcher;
}

const MIME: Record<string, string> = {
  '.ply': 'application/octet-stream',
  '.sog': 'application/octet-stream',
  '.spz': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const BASE_HEADERS = {
  'Accept-Ranges': 'bytes',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Cache-Control': 'public, max-age=0, must-revalidate'
};

const textResponse = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers }
  });

type ResolvedRange =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'partial'; range: R2Range; start: number; end: number; length: number };

const resolveRange = (header: string | null, size: number): ResolvedRange => {
  if (!header) return { kind: 'none' };

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return { kind: 'invalid' };

  let start: number;
  let end: number;

  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    const suffixLength = Number(match[2]);
    if (suffixLength <= 0) return { kind: 'invalid' };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }

  if (!Number.isSafeInteger(start) || start < 0 || start >= size || end < start) {
    return { kind: 'invalid' };
  }

  return {
    kind: 'partial',
    range: { offset: start, length: end - start + 1 },
    start,
    end,
    length: end - start + 1
  };
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/scenes/' && !url.pathname.startsWith('/scenes/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return textResponse(405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }

    let key: string;
    try {
      key = decodeURIComponent(url.pathname.slice(1));
    } catch {
      return textResponse(400, 'Bad URL encoding');
    }

    if (!key || key.includes('..') || key.startsWith('/') || key.includes('\0')) {
      return textResponse(403, 'Forbidden');
    }

    let objectHead: R2Object | null;
    try {
      objectHead = await env.SCENES.head(key);
    } catch (error) {
      console.error('R2 head failed', error);
      return textResponse(500, 'Internal server error');
    }

    if (!objectHead) {
      return textResponse(404, 'Not found');
    }

    const extension = key.slice(key.lastIndexOf('.')).toLowerCase();
    const contentType = MIME[extension] ?? 'application/octet-stream';
    const commonHeaders: Record<string, string> = {
      ...BASE_HEADERS,
      'Content-Type': contentType,
      ETag: objectHead.httpEtag,
      'Last-Modified': objectHead.uploaded.toUTCString()
    };

    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { ...commonHeaders, 'Content-Length': String(objectHead.size) }
      });
    }

    const resolved = resolveRange(request.headers.get('range'), objectHead.size);

    if (resolved.kind === 'invalid') {
      return textResponse(416, 'Range not satisfiable', {
        'Content-Range': `bytes */${objectHead.size}`
      });
    }

    if (resolved.kind === 'none') {
      const object = await env.SCENES.get(key);
      if (!object) return textResponse(404, 'Not found');
      return new Response(object.body, {
        status: 200,
        headers: { ...commonHeaders, 'Content-Length': String(object.size) }
      });
    }

    let object: R2ObjectBody | null;
    try {
      object = await env.SCENES.get(key, { range: resolved.range as R2Range });
    } catch (error) {
      console.error('R2 ranged get failed', error);
      return textResponse(416, 'Range not satisfiable', {
        'Content-Range': `bytes */${objectHead.size}`
      });
    }

    if (!object) return textResponse(404, 'Not found');

    return new Response(object.body, {
      status: 206,
      headers: {
        ...commonHeaders,
        'Content-Length': String(resolved.length),
        'Content-Range': `bytes ${resolved.start}-${resolved.end}/${objectHead.size}`
      }
    });
  }
} satisfies ExportedHandler<Env>;
