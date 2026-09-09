'use strict';
const http = require('node:http');
const args = process.argv.slice(2);
const get = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(args.includes('--slow') ? 503 : 200);
    res.end('{}');
  } else if (req.url === '/props') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ default_generation_settings: { n_ctx: 4096 } }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"Fixture response"}}]}\n\ndata: [DONE]\n\n');
  }
});
server.listen(Number(get('--port', 8080)), get('--host', '127.0.0.1'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
