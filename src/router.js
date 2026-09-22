import { parseRoute } from './utils.js';

export class Router {
  routes = [];
  add(method, pattern, handler, options = {}) { this.routes.push({ method, pattern, handler, options }); }
  get(pattern, handler, options) { this.add('GET', pattern, handler, options); }
  post(pattern, handler, options) { this.add('POST', pattern, handler, options); }
  patch(pattern, handler, options) { this.add('PATCH', pattern, handler, options); }
  delete(pattern, handler, options) { this.add('DELETE', pattern, handler, options); }
  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = parseRoute(route.pattern, pathname);
      if (params) return { ...route, params };
    }
    return null;
  }
}
