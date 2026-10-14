// Optional local-development workaround for ISP DNS failures resolving Atlas.
// Does not change Windows DNS, credentials, hostname/SNI, or TLS validation.
import dns from 'node:dns';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
if (process.env.NODE_ENV === 'production') throw new Error('This DNS workaround is for local development only');
dns.setServers(['1.1.1.1', '8.8.8.8']);
const systemLookup = dns.lookup;
dns.lookup = function lookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') options = { family: options };
  if (!hostname.endsWith('.mongodb.net')) return systemLookup(hostname, options, callback);
  const family = options?.family === 6 ? 6 : 4;
  const resolver = family === 6 ? dns.resolve6 : dns.resolve4;
  resolver(hostname, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length) return callback(Object.assign(new Error('Atlas hostname could not be resolved'), { code: 'ENOTFOUND' }));
    if (options?.all) callback(null, addresses.map(address => ({ address, family })));
    else callback(null, addresses[0], family);
  });
};
await import('../dist/main.js');
