import { RenderMode, ServerRoute } from '@angular/ssr';

// prerendered at build time (also with outputMode server)
export const serverRoutes: ServerRoute[] = [{ path: '**', renderMode: RenderMode.Prerender }];
