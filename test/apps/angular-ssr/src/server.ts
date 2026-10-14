// the server (outputMode server): Angular bundles it with its dependencies into dist/server; left-pad only here
import { AngularNodeAppEngine, createNodeRequestHandler, isMainModule, writeResponseToNodeResponse } from '@angular/ssr/node';
import { createServer } from 'node:http';
import leftPad from 'left-pad';
import { used } from 'bl-canary-used'; // canary: only in the server (with its own bl-canary-dup 1.0.0)

const engine = new AngularNodeAppEngine();
export const reqHandler = createNodeRequestHandler(async (req, res) => {
  const response = await engine.handle(req);
  if (response) await writeResponseToNodeResponse(response, res);
  else { res.statusCode = 404; res.end(leftPad('404', 5) + used().join()); }
});
if (isMainModule(import.meta.url)) createServer(reqHandler).listen(Number(process.env['PORT'] || 4000));
