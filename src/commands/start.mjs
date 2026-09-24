import { once } from 'node:events';
import path from 'node:path';
import { openHomeDatabase } from '../runtime/home.mjs';
import { createServer, FRIENDLY_DASHBOARD_HOST } from '../server/app.mjs';

export async function startCommand(parsed, io, runtime) {
  const context = await openHomeDatabase(parsed.options.home ?? process.cwd());
  const port = Number(parsed.options.port ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer from 0 to 65535');
  const host = parsed.options.host ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('host must be a loopback address');
  const server = createServer({ db: context.db, config: context.config, artifactRoot: context.artifactRoot, webRoot: path.join(runtime.root, 'web') });
  server.listen(port, host);
  await once(server, 'listening');
  const address = server.address();
  const dashboardHost = parsed.options.host ? host : FRIENDLY_DASHBOARD_HOST;
  const urlHost = dashboardHost.includes(':') ? `[${dashboardHost}]` : dashboardHost;
  io.out(`CAREER JOURNAL dashboard: http://${urlHost}:${address.port}`);
  server.on('close', () => context.db.close());
  return 0;
}
