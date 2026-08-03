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
//     "sqlKey":    "RSL",                   // the value the WMS uses for this client
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
// SGK_GROUP) and may read any company by passing ?company=<companyId>.
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
      sqlKey: String(c.sqlKey),
      domains: (c.domains || []).map((d) => String(d).toLowerCase().replace(/^@/, '')),
      emails: (c.emails || []).map((e) => String(e).toLowerCase()),
    }));
  return cache;
}

export function isSgk({ email, groups }) {
  const group = (process.env.SGK_GROUP || '').trim();
  if (group && groups.includes(group)) return true;
  const domain = email.split('@')[1] || '';
  return parseList(process.env.SGK_EMAILS).includes(email)
    || parseList(process.env.SGK_DOMAINS || 'sgkhomedelivery.co.uk').includes(domain);
}

// The ONLY way a company is chosen. Clients get theirs; SGK may ask for one.
export function resolveCompany(identity, requestedCompanyId) {
  const map = clientMap();

  if (isSgk(identity)) {
    if (!requestedCompanyId) return { staff: true, company: null };
    const hit = map.find((c) => c.companyId === String(requestedCompanyId));
    if (!hit) throw Object.assign(new Error(`No analytics key configured for "${requestedCompanyId}"`), { status: 404 });
    return { staff: true, company: hit };
  }

  // A client. The request does not get a say in which company this is.
  const domain = identity.email.split('@')[1] || '';
  const hit = map.find((c) => c.emails.includes(identity.email))
    || map.find((c) => c.domains.includes(domain));
  if (!hit) throw Object.assign(new Error('No dashboard is configured for this account yet.'), { status: 403 });
  return { staff: false, company: hit };
}

export function listCompanies() {
  return clientMap().map((c) => ({ companyId: c.companyId, name: c.name }));
}
