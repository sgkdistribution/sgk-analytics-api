// ---------------------------------------------------------------------------
// THE COMPANY MAP — verified email -> which company -> which WMS client key.
//
// Held here on the server, never in the browser. Configure it with one env var
// on Railway, CLIENT_MAP, containing JSON:
//
// [
//   {
//     "companyId": "roseland",              // must match the portal's company id
//     "name":      "Roseland Furniture",
//     "sqlKey":    "ROSELAND FURNITURE",     // the PartnerName in the WMS.
//                                            // Can also be a LIST if a client
//                                            // has more than one partner code:
//                                            // ["ROSELAND FURNITURE","Roseland Service Call"]
//     "domains":   ["roselandfurniture.co.uk"],
//     "emails":    ["michael.broom@roselandfurniture.co.uk"]
//   }
// ]
//
// A person matches a company by exact email first, then by email domain. Domains
// are the practical way in — add the client's domain once and every colleague
// they invite to the portal works without another config change.
//
// SGK staff are matched by SGK_DOMAINS / SGK_EMAILS (or a Cognito group named in
// SGK_GROUP) and may read any company by passing ?company=<companyId>. Staff
// requests also match on the company NAME, so companyId can be anything you like
// — you never have to go digging in DynamoDB for the portal's internal id.
//
// WHY NOT STORE THE KEY ON THE COMPANY RECORD IN THE PORTAL, so it can be typed
// into the SGK admin screen? Because whatever the browser can set, the browser
// can change. The key has to live somewhere the client cannot reach. Managing it
// here is one Railway variable per new client; if that becomes tedious, the next
// step is a small table in SQL Server that this file reads instead — same
// principle, still server side, but editable from the SGK portal through this
// service. Say the word and it is a short change.
// ---------------------------------------------------------------------------

function parseList(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

let cache = null;

export function clientMap() {
  if (cache) return cache;
  let raw = [];
  try {
    raw = JSON.parse(process.env.CLIENT_MAP || '[]');
    if (!Array.isArray(raw)) raw = [];
  } catch (e) {
    console.error('[clients] CLIENT_MAP is not valid JSON — no client will resolve:', e?.message || e);
    raw = [];
  }
  cache = raw
    .filter((c) => c && c.companyId && c.sqlKey)
    .map((c) => ({
      companyId: String(c.companyId),
      name: String(c.name || c.companyId),
      // One company can own several PartnerName values in the WMS.
      sqlKey: Array.isArray(c.sqlKey) ? c.sqlKey.map(String) : [String(c.sqlKey)],
      domains: (c.domains || []).map((d) => String(d).toLowerCase().replace(/^@/, '')),
      emails: (c.emails || []).map((e) => String(e).toLowerCase()),
    }));
  warnAboutOverlaps(cache);
  return cache;
}

/**
 * Shout if two companies claim the same email or domain.
 *
 * THIS IS NOT THEORETICAL. There are now two Roseland entries — the real account
 * and a testing one — and a client is matched by exact email first, then by
 * DOMAIN. If both entries list roselandfurniture.com, whichever appears first in
 * CLIENT_MAP silently wins every lookup, and the real client could end up looking
 * at the testing company's dashboard (or the reverse) with nothing on screen to
 * say so. Two companies whose names differ by one word is exactly the situation
 * where that goes unnoticed.
 *
 * Warn rather than throw: refusing to start would take every OTHER company's
 * dashboard down over one duplicated line.
 */
function warnAboutOverlaps(list) {
  const seenEmail = new Map();
  const seenDomain = new Map();
  for (const c of list) {
    for (const e of c.emails) {
      if (seenEmail.has(e)) {
        console.warn(`[clients] "${e}" is listed under BOTH "${seenEmail.get(e)}" and "${c.name}" — `
          + `the first one wins and the second will never match. Remove the duplicate.`);
      } else seenEmail.set(e, c.name);
    }
    for (const d of c.domains) {
      if (seenDomain.has(d)) {
        console.warn(`[clients] domain "${d}" is listed under BOTH "${seenDomain.get(d)}" and "${c.name}" — `
          + `every user on that domain resolves to "${seenDomain.get(d)}". If these are separate accounts `
          + `(a live one and a testing one, say), give them different domains or match on exact emails.`);
      } else seenDomain.set(d, c.name);
    }
    if (!c.emails.length && !c.domains.length) {
      // NOT necessarily dead any more: a client whose Cognito group matches this
      // entry's companyId resolves without either list. Still worth saying, since
      // it is a fair bet when an entry looks unreachable.
      console.warn(`[clients] "${c.name}" has no emails and no domains — it can only be reached by `
        + `Cognito group (companyId "${c.companyId}") or by SGK with ?company=.`);
    }
  }
}

export function isSgk({ email, groups }) {
  const group = (process.env.SGK_GROUP || '').trim();
  if (group && groups.includes(group)) return true;
  const domain = email.split('@')[1] || '';
  return parseList(process.env.SGK_EMAILS).includes(email)
    || parseList(process.env.SGK_DOMAINS || 'sgkhomedelivery.co.uk').includes(domain);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------------------------------------------------------------------------
// WHO A CLIENT IS — FROM THEIR COGNITO GROUP, NOT THEIR EMAIL ADDRESS.
//
// Matching on email domain works right up until a client invites somebody on a
// personal address — a gmail, an outlook — and then their dashboard says "no
// dashboard is configured for this account". The answer can never be to add
// outlook.com to the map: that would hand every Outlook user on earth somebody's
// sales figures.
//
// The portal already knows the answer and puts it in the token. Every client user
// carries a Cognito group `company_<companyId>`, stamped by the post-confirmation
// trigger and used by AppSync to decide which rows they may read at all. It is
// issued by Cognito, cannot be spoofed by the browser, and is the SAME id the
// portal writes on every record.
//
// So a client is resolved by group first, and email/domain is kept only as a
// fallback for anything the group cannot answer.
// ---------------------------------------------------------------------------

/** The company ids carried on a token: ['company_bedroomking-mrup3q…'] -> ['bedroomking-mrup3q…']. */
function groupCompanyIds(groups) {
  return (groups || [])
    .filter((g) => typeof g === 'string' && g.startsWith('company_'))
    .map((g) => g.slice('company_'.length))
    .filter(Boolean);
}

/**
 * The SLUG half of a portal company id.
 *
 * The portal builds ids as `<slug>-<uid>`, where the slug is the company name
 * lowercased with every non-alphanumeric stripped, and the uid is base36 with no
 * dashes. So everything before the FIRST dash is exactly the slug.
 */
const idSlug = (id) => String(id || '').split('-')[0];

/**
 * Match a token's groups against a CLIENT_MAP entry.
 *
 *   1. EXACT companyId. Correct, and what a properly filled-in map gives you.
 *   2. The slug, against the entry's companyId or its NAME.
 *
 * Rule 2 exists because CLIENT_MAP entries predate this and carry short handles
 * ("roseland", "bedroomking") rather than the portal's full id. Comparing the
 * slug to the normalised NAME simply reverses how the portal built the id in the
 * first place, so those entries keep working with no config change — and setting
 * the real companyId makes rule 1 hit first and rule 2 irrelevant.
 */
function matchesGroups(entry, groupIds) {
  if (!groupIds.length) return false;
  if (groupIds.includes(entry.companyId)) return true;
  const wanted = new Set([norm(entry.companyId).slice(0, 24), norm(entry.name).slice(0, 24)]);
  return groupIds.some((g) => wanted.has(idSlug(g)));
}

// The ONLY way a company is chosen. Clients get theirs; SGK may ask for one.
export function resolveCompany(identity, requested = {}) {
  const map = clientMap();
  const { companyId, companyName } = requested;

  if (isSgk(identity)) {
    if (!companyId && !companyName) return { staff: true, company: null };
    // Match on the portal's id if it happens to be in the map, otherwise on the
    // company NAME — which is why nobody needs to look up a DynamoDB id.
    const hit = map.find((c) => c.companyId === String(companyId || ''))
      || (companyName ? map.find((c) => norm(c.name) === norm(companyName)) : null)
      || (companyName ? map.find((c) => norm(c.companyId) === norm(companyName)) : null);
    if (!hit) {
      const known = map.map((c) => c.name).join(', ') || '(CLIENT_MAP is empty)';
      throw Object.assign(
        new Error(`No analytics key configured for "${companyName || companyId}". Configured: ${known}`),
        { status: 404 },
      );
    }
    return { staff: true, company: hit };
  }

  // A client. The request does not get a say in which company this is.
  const domain = identity.email.split('@')[1] || '';
  const groupIds = groupCompanyIds(identity.groups);

  // GROUP FIRST. It is the only signal that is right for every colleague a
  // client will ever invite, whatever address they use.
  const hit = map.find((c) => matchesGroups(c, groupIds))
    || map.find((c) => c.emails.includes(identity.email))
    || map.find((c) => c.domains.includes(domain));

  if (!hit) {
    // Say what was actually looked for. "nothing covers outlook.com" sent people
    // off to add a public email domain to the map, which would have been a leak.
    const seen = groupIds.length ? groupIds.join(', ') : '(none on the token)';
    throw Object.assign(
      new Error(
        'No dashboard is configured for this account yet. '
        + `Company group on the token: ${seen}. Set that as the companyId on the right CLIENT_MAP entry `
        + `(or add ${identity.email} to its emails). Do NOT add "${domain}" as a domain if it is a public one.`,
      ),
      { status: 403 },
    );
  }
  return { staff: false, company: hit };
}

export function listCompanies() {
  return clientMap().map((c) => ({ companyId: c.companyId, name: c.name }));
}

// For /analytics/whoami — what the server sees, so a misconfigured map can be
// diagnosed in one look instead of guessed at.
export function describeAccess(identity) {
  const staff = isSgk(identity);
  const domain = identity.email.split('@')[1] || '';
  const map = clientMap();
  const groupIds = groupCompanyIds(identity.groups);
  const match = map.find((c) => matchesGroups(c, groupIds))
    || map.find((c) => c.emails.includes(identity.email))
    || map.find((c) => c.domains.includes(domain));
  return {
    email: identity.email,
    domain,
    // The groups are the thing to look at first when a dashboard says no.
    groups: identity.groups || [],
    companyGroups: groupIds,
    matchedBy: match
      ? (matchesGroups(match, groupIds) ? 'cognito group'
        : match.emails.includes(identity.email) ? 'email' : 'domain')
      : null,
    treatedAs: staff ? 'SGK staff' : 'client',
    matched: match ? { companyId: match.companyId, name: match.name, sqlKey: match.sqlKey } : null,
    // Staff see the whole map; a client only ever sees their own entry.
    configured: staff
      ? map.map((c) => ({ companyId: c.companyId, name: c.name, domains: c.domains, sqlKey: c.sqlKey }))
      : undefined,
    hint: match
      ? 'This account resolves correctly.'
      : staff
        ? 'Staff account — pass ?company= to pick a client.'
        : `No CLIENT_MAP entry lists "${domain}" under domains, and no entry lists this exact email. Add "${domain}" to the right company's domains.`,
  };
}