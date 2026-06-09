import type { Context, Next } from 'hono';
import { verifyAccessToken } from '../auth.js';
import { config } from '../config.js';

export type AuthVariables = {
  userId: string;
};

export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  if (!config.requireAuth) {
    return c.json({ error: 'auth_required' }, 401);
  }

  const header = c.req.header('Authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const queryToken = c.req.query('token');
  const token = bearer ?? queryToken;

  if (!token) {
    return c.json({ error: 'missing_token' }, 401);
  }

  try {
    const verified = await verifyAccessToken(token, {
      supabaseUrl: config.supabaseUrl,
      jwtAudience: config.jwtAudience,
    });
    c.set('userId', verified.userId);
    await next();
  } catch {
    return c.json({ error: 'invalid_token' }, 401);
  }
}
