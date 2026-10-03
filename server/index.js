import { createApp } from './app.js';

const port = Number(process.env.PORT) || 2567;
const app = await createApp(port);
console.log(`RT Arena server listening on port ${app.port}`);

const stop = () => {
  app.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
