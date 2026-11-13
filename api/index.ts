/** Vercel serverless entry point: vercel.json sends every /api/* request here. */
import { app } from '../src/server/app.js';

export default app;
