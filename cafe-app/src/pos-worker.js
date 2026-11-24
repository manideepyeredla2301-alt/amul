import cafeWorker from './worker.js';

export default {
  fetch(request, env, context) {
    const url = new URL(request.url);
    if ((request.method === 'GET' || request.method === 'HEAD') &&
        (url.pathname === '/' || url.pathname === '/index.html')) {
      const destination = new URL('/pos/', url);
      destination.search = url.search;
      return new Response(null, {
        status: 302,
        headers: { Location: destination.toString(), 'Cache-Control': 'no-store' },
      });
    }
    return cafeWorker.fetch(request, env, context);
  },
};
