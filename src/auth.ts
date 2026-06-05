import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from 'jose';

export type AuthConfig = {
  supabaseUrl: string;
  jwtAudience: string;
};

export type VerifiedUser = {
  userId: string;
  payload: JWTPayload;
};

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function issuer(config: AuthConfig): string {
  return `${config.supabaseUrl}/auth/v1`;
}

function jwksUrl(config: AuthConfig): string {
  return `${issuer(config)}/.well-known/jwks.json`;
}

function getJwks(config: AuthConfig) {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUrl(config)));
  }
  return jwks;
}

export async function verifyAccessToken(
  token: string,
  config: AuthConfig,
): Promise<VerifiedUser> {
  const { payload } = await jwtVerify(token, getJwks(config), {
    issuer: issuer(config),
    audience: config.jwtAudience,
    algorithms: ['RS256', 'ES256'],
  });

  const userId = payload.sub;
  if (!userId) {
    throw new Error('missing_subject');
  }

  return { userId, payload };
}
