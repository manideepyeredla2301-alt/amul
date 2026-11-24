import cafeWorker from './worker.js';

export default {
  fetch(request, env, context) {
    const url = new URL(request.url);
    const pagePaths = new Set(['/', '/index.html', '/pos', '/pos/', '/pos/index.html',
      '/admin', '/admin/', '/admin/index.html', '/kitchen', '/kitchen/', '/kitchen/index.html',
      '/staff', '/staff/', '/staff/index.html', '/ads', '/ads/', '/ads/index.html']);
    if ((request.method === 'GET' || request.method === 'HEAD') && pagePaths.has(url.pathname)) {
      const path = url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/pos'
        ? '/pos/' : url.pathname === '/admin' ? '/admin/' : url.pathname === '/kitchen' ? '/kitchen/'
          : url.pathname === '/staff' ? '/staff/' : url.pathname === '/ads' ? '/ads/' : url.pathname;
      const destination = new URL(path, env.CAFE_CANONICAL_ORIGIN || url.origin);
      destination.search = url.search;
      return new Response(null, {
        status: 302,
        headers: { Location: destination.toString(), 'Cache-Control': 'no-store' },
      });
    }
    return cafeWorker.fetch(request, env, context);
  },
};
