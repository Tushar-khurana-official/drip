/**
 * Login for the one business that uses this Drip instance.
 * - The login comes from APP_EMAIL / APP_PASSWORD environment variables, never from code.
 * - Sessions are HMAC-signed tokens in an httpOnly cookie.
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface Session {
  role: 'owner';
  sub: string;
  exp: number; // unix seconds
}
export type AuthedRequest = Request & { session?: Session };

const COOKIE = 'drip_session';
const MAX_AGE_S = 30 * 24 * 3600;
/** Without "keep me signed in": the cookie ends when the browser closes, and the token after 12 hours anyway. */
const SHORT_S = 12 * 3600;

function secret(): Buffer {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return Buffer.from(s);
  // Fallback so serverless instances agree without extra setup. Set SESSION_SECRET in production.
  const basis = `${process.env.APP_EMAIL ?? ''}|${process.env.APP_PASSWORD ?? ''}|${process.env.DATABASE_URL ?? ''}|drip`;
  return crypto.createHash('sha256').update(basis).digest();
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function loginConfigured(): boolean {
  return Boolean(process.env.APP_EMAIL && process.env.APP_PASSWORD);
}

export function isOwnerLogin(email: string, password: string): boolean {
  const e = process.env.APP_EMAIL?.trim().toLowerCase();
  const p = process.env.APP_PASSWORD;
  if (!e || !p) return false;
  return safeEqual(email.trim().toLowerCase(), e) && safeEqual(password, p);
}

export function signSession(remember = true): string {
  const payload = Buffer.from(JSON.stringify({ role: 'owner', sub: 'main', exp: Math.floor(Date.now() / 1000) + (remember ? MAX_AGE_S : SHORT_S) })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function readSession(token: string | undefined): Session | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Session;
    if (s.exp < Date.now() / 1000 || s.role !== 'owner') return null;
    return s;
  } catch {
    return null;
  }
}

function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/**
 * Session from the cookie (app served by this server) or from "Authorization: Bearer <token>"
 * (app hosted elsewhere, e.g. GitHub Pages, where cross-site cookies are blocked by browsers).
 */
export function getSession(req: Request): Session | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return readSession(auth.slice(7).trim());
  return readSession(cookieValue(req, COOKIE));
}

export function setSessionCookie(res: Response, token: string, remember = true) {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : '';
  // No Max-Age = session cookie: the browser forgets it when it is closed.
  const age = remember ? `; Max-Age=${MAX_AGE_S}` : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax${age}${secure}`);
}

export function clearSessionCookie(res: Response) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

export function requireLogin(req: AuthedRequest, res: Response, next: NextFunction) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Login required' });
  req.session = s;
  next();
}

/** Small in-memory limiter for login attempts (per instance; slows down password guessing). */
const attempts = new Map<string, { count: number; until: number }>();
export function loginRateLimited(key: string): boolean {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.until < now) {
    attempts.set(key, { count: 1, until: now + 15 * 60_000 });
    return false;
  }
  return ++a.count > 10;
}
export function resetLoginAttempts(key: string) {
  attempts.delete(key);
}
