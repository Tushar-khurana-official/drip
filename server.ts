/**
 * Node entry point: the API plus the React app (Vite middleware in development, dist/ in production).
 * Also runs the sender every 30 seconds. On Vercel the API runs from api/index.ts and the sender
 * is triggered by /api/cron/send-due instead.
 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { app } from './src/server/app';
import { startSenderTimer } from './src/server/sender';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
  }
  app.listen(PORT, () => console.log(JSON.stringify({ event: 'server_started', port: PORT })));
  startSenderTimer();
}

start();
