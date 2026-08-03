// ---------------------------------------------------------------------------
// WHO IS ASKING, AND WHAT ARE THEY ALLOWED TO SEE.
//
// This is the file that stops one client seeing another client's numbers, so it
// is worth being blunt about how it works.
//
// The browser sends the Cognito ID token it already holds from signing in to
// the portal. This service verifies that token's SIGNATURE against the user
// pool's public keys — which means it cannot be forged, edited or replayed from
// another pool. Only then does it read the email out of it.
//
// The company then comes from THE SERVER'S OWN MAP (clients.js), keyed on that
// verified email. It is never taken from the request. That distinction is the
// whole security model: if the browser could say "show me Roseland's data",
// anyone could say it. It cannot. It can only say "here is who I am", and the
// server decides what that person is allowed to see.
//
// SGK staff are the one exception — they may pass ?company=<id> to look at any
// client, exactly as they can already switch companies inside the SGK portal.
// ---------------------------------------------------------------------------
import { createRemoteJWKSet, jwtVerify } from 'jose';

const REGION = process.env.COGNITO_REGION || 'eu-north-1';
const POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || '';

let jwks = null;
function keySet() {
  if (!POOL_ID) throw new Error('COGNITO_USER_POOL_ID is not set');
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}/.well-known/jwks.json`),
    );
  }
  return jwks;
}

export function authConfigured() {
  return Boolean(POOL_ID);
}

// Returns { email, groups[] } or throws.
export async function verifyToken(header) {
  const raw = String(header || '');
  const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
  if (!token) throw Object.assign(new Error('Missing bearer token'), { status: 401 });

  let payload;
  try {
    ({ payload } = await jwtVerify(token, keySet(), {
      issuer: `https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}`,
      // audience is only present on ID tokens; skip the check if no client id is configured
      ...(CLIENT_ID ? { audience: CLIENT_ID } : {}),
    }));
  } catch (e) {
    throw Object.assign(new Error(`Invalid session: ${e?.message || e}`), { status: 401 });
  }

  const email = String(payload.email || '').toLowerCase().trim();
  if (!email) throw Object.assign(new Error('Token carries no email'), { status: 401 });

  return { email, groups: Array.isArray(payload['cognito:groups']) ? payload['cognito:groups'] : [] };
}
