/* Worker 入口。
 *
 * 静态资源（public/）由 Cloudflare 的 assets 先行处理：命中就直接返回，
 * 不会进到这里。所以走到这个 fetch 的基本只有 /api/travel。
 */
import { onRequestGet, onRequestPost } from './src/api.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/travel') {
      if (request.method === 'GET') return onRequestGet({ request, env });
      if (request.method === 'POST') return onRequestPost({ request, env });
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, POST' }
      });
    }

    // 不是接口也不是已有的静态文件 —— 交回 assets 出标准 404
    return env.ASSETS.fetch(request);
  }
};
