// ===========================================================================
// ADD COMPANIES TO THE DASHBOARDS — the work behind deploy/add-client.sh.
//
//   sudo bash /opt/sgk-analytics-api/deploy/add-client.sh
//   sudo bash /opt/sgk-analytics-api/deploy/add-client.sh Abode     (starts with Abode)
//
// One company or several in one run. For each one it asks:
//   • the name, exactly as the portal shows it;
//   • the portal id (from the CloudShell company list), or the Cognito group,
//     which is the same id with company_ in front. The id is the
//     lockdown key: a login sees a company's figures only if it carries that id;
//   • which client name(s) in the delivery system are that company's — it finds
//     them itself, and refuses one that another company already owns.
// Then, once for the whole run:
//   1. Shows exactly what it will save and waits for a yes.
//   2. Reads /etc/sgk-analytics.env the way systemd does, keeps a dated copy,
//      writes the new CLIENT_MAP line and touches no other line.
//   3. PROVES THE LOCKDOWN with the code that will actually run: each company's
//      own login sees its dashboard; a second company with the same name, and an
//      unrelated company, do not — for client logins and for SGK's own view; and
//      every company pinned to its id gets its own dashboard and no other. Any
//      failure puts the old file back and stops, without a restart.
//   4. Restarts the service and checks it answers.
// Ctrl+C at any question stops it with nothing changed.
// ===========================================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENVF = process.env.SGK_ENV_FILE || '/etc/sgk-analytics.env';
const SERVICE = 'sgk-analytics-api';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const slugOf = (name) => norm(name).slice(0, 24);
const say = (s = '') => stdout.write(`${s}\n`);
const stop = (msg) => { say(`\n✖ ${msg}`); process.exit(1); };
const count = (n) => Number(n || 0).toLocaleString('en-GB');

// A portal company id: the name squashed to 24 letters at most, a dash, then the
// time it was made (base 36) and a few random letters — about 14 in all.
const isPortalId = (id) => /^[a-z0-9]{1,24}-[a-z0-9]{10,}$/.test(String(id || ''));
// An example that once appeared in the instructions looked like a real id and was
// pasted as one. It is refused outright; no example shown now looks real.
const NOT_REAL = new Set(['abode-mtx3k9q2b1c4ze']);
const keysOf = (c) => (Array.isArray(c?.sqlKey) ? c.sqlKey : [c?.sqlKey])
  .filter((k) => k != null && k !== '').map(String);

// The day the portal made an id — it is written into the id itself.
function madeOn(id) {
  const t = parseInt(String(id).split('-')[1]?.slice(0, 8) || '', 36);
  if (!Number.isFinite(t) || t < Date.UTC(2020, 0, 1) || t > Date.now() + 864e5) return '';
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── the settings file, read the way systemd reads it ─────────────────────────
// KEY=value per line; '#' or ';' at the start is a comment; a value starting
// with ' or " is quoted; an unquoted value runs to the end of the line, with a
// backslash taking the next character literally. A later line wins.
function parseEnv(text) {
  const lines = text.split('\n');
  const vars = new Map();
  lines.forEach((line, i) => {
    const t = line.replace(/\r$/, '');
    if (!t.trim() || /^\s*[#;]/.test(t)) return;
    const eq = t.indexOf('=');
    if (eq < 1) return;
    const key = t.slice(0, eq).trim();
    let raw = t.slice(eq + 1).replace(/^\s+/, '');
    let value = '';
    if (raw.startsWith("'")) {
      const end = raw.indexOf("'", 1);
      value = end === -1 ? raw.slice(1) : raw.slice(1, end);
    } else if (raw.startsWith('"')) {
      for (let j = 1; j < raw.length; j++) {
        const c = raw[j];
        if (c === '\\' && j + 1 < raw.length) { value += raw[++j]; continue; }
        if (c === '"') break;
        value += c;
      }
    } else {
      raw = raw.replace(/\s+$/, '');
      for (let j = 0; j < raw.length; j++) {
        const c = raw[j];
        if (c === '\\' && j + 1 < raw.length) { value += raw[++j]; continue; }
        value += c;
      }
    }
    vars.set(key, { value, line: i });
  });
  return { lines, vars };
}

// ── the delivery system's client names that look like a company ──────────────
// Word by word, so "Steel and Sap" finds "Steel & Sap", "Kove Ltd" finds "KOVE
// LIMITED" and "Thats Furniture" finds "That's Furniture Ltd". A word that is in
// lots of client names ("furniture", "beds") counts for little; a rare one
// ("domli") counts for a lot; one found only INSIDE another word ("kove" in
// "Bukovel") counts half. Strong matches are offered as a set, weaker ones only
// one by one — and nothing is used until it is picked.
const LEGAL_WORDS = new Set(['ltd', 'limited', 'the', 'and', 'plc', 'llp', 'inc', 'co', 'uk', 'group', 'company']);
function wordStarts(text) {
  const starts = new Set();
  let at = 0;
  for (const w of String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) { starts.add(at); at += w.length; }
  return starts;
}
// 1 = starts where a word of the client name starts ("mybespoke" in "My Bespoke"),
// 0.5 = only inside a word, 0 = not there.
function hit(n, starts, w) {
  let i = n.indexOf(w);
  if (i === -1) return 0;
  for (; i !== -1; i = n.indexOf(w, i + 1)) if (starts.has(i)) return 1;
  return 0.5;
}
function matchPartners(name, partners) {
  const all = partners.map((p) => ({ ...p, n: norm(p.partnerName), starts: wordStarts(p.partnerName) }));
  const whole = norm(name);
  let words = [...new Set(String(name).toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !LEGAL_WORDS.has(w)))];
  if (!words.length && whole) words = [whole];
  const weights = words
    .map((w) => ({ w, seen: all.filter((p) => p.n.includes(w)).length }))
    .filter((x) => x.seen > 0)
    .map((x) => ({ w: x.w, wt: 1 / x.seen }));
  const total = weights.reduce((s, x) => s + x.wt, 0);
  const scored = all
    .map((p) => ({
      ...p,
      score: whole && hit(p.n, p.starts, whole) === 1 ? 1
        : total ? weights.reduce((s, x) => s + x.wt * hit(p.n, p.starts, x.w), 0) / total : 0,
    }))
    .filter((p) => p.score >= 0.4)
    .sort((a, b) => b.score - a.score || Number(b.orders) - Number(a.orders))
    .slice(0, 15);
  return { strong: scored.filter((p) => p.score >= 0.75), weak: scored.filter((p) => p.score < 0.75) };
}

// ── one company's portal id ──────────────────────────────────────────────────
async function askId(ask, name) {
  const slug = slugOf(name);
  say(`  Copy ${name}'s id from the CloudShell list (its Cognito group works too).`);
  for (let tries = 0; tries < 3; tries++) {
    const raw = (await ask(`  Paste ${name}'s id: `)).toLowerCase();
    if (!raw) return '';
    // A paste can carry the terminal's paste markers or "company_" — take just
    // the id out of whatever arrived.
    const m = raw.match(/[a-z0-9]{1,24}-[a-z0-9]{10,}/);
    if (!m) { say('  That is not a company id. It is the name, a dash, then about 14 letters and numbers. Try again.'); continue; }
    if (NOT_REAL.has(m[0])) { say('  That is the example from the instructions, not a real id. Copy the real one from CloudShell.'); continue; }
    const id = m[0];
    const madeFor = id.split('-')[0];
    if (madeFor !== slug) {
      // The id carries the name the company had when it was made. A different one
      // means the company was renamed since — or this is another company's id.
      const when = madeOn(id);
      const a = (await ask(`  That id was made for "${madeFor}"${when ? ` on ${when}` : ''}, not "${name}". Use it anyway? (y/n): `)).toLowerCase();
      if (a !== 'y') continue;
    }
    return id;
  }
  return '';
}

// ── one company's client name(s) ─────────────────────────────────────────────
async function pickNames(ask, name, old, work, partners) {
  // Who owns each client name now — this run included — apart from the entry
  // being replaced.
  const ownedBy = new Map();
  for (const c of work) if (c !== old) for (const k of keysOf(c)) ownedBy.set(k, c);

  let chosen = [];
  // Already on: keep its client names exactly as they are unless told otherwise —
  // pinning a company to its id must never change which orders it counts.
  const kept = keysOf(old);
  let search = true;
  if (kept.length) {
    say(`  ${name} already has a dashboard, counting: ${kept.join(' + ')}`);
    const k = (await ask('  Keep exactly these? (y = keep / s = search again / n = skip): ')).toLowerCase();
    if (k === 'y') { chosen = kept; search = false; } else if (k !== 's') return [];
  }

  if (search) {
    const { strong, weak } = matchPartners(name, partners);
    const found = [...strong, ...weak];
    if (found.length) {
      const line = (p, i) => {
        const o = ownedBy.get(String(p.partnerName));
        say(`    ${i + 1}. ${p.partnerName}   (${count(p.orders)} orders)${o ? `   ⚠ already belongs to ${o.name || o.companyId}` : ''}`);
      };
      if (strong.length) say(`  Client names in the delivery system that match "${name}":`);
      strong.forEach((p, i) => line(p, i));
      if (weak.length) say(strong.length ? '  These might be theirs too:' : `  Nothing matches "${name}" closely. These might be theirs:`);
      weak.forEach((p, i) => line(p, strong.length + i));
      const all = strong.length === 1 ? 'y for 1, ' : strong.length ? `y for 1–${strong.length}, ` : '';
      for (let tries = 0; tries < 3 && !chosen.length; tries++) {
        const a = (await ask(`  Type ${all}the numbers to keep (e.g. 1,3), or n to skip: `)).toLowerCase();
        if (!a || a === 'n') return [];
        if (a === 'y' && strong.length) { chosen = strong.map((p) => String(p.partnerName)); break; }
        chosen = a.split(/[\s,]+/).map(Number)
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= found.length)
          .map((n) => String(found[n - 1].partnerName));
        if (!chosen.length) say('  Type the numbers shown, e.g. 1 or 1,3.');
      }
    } else {
      say(`  Nothing in the delivery system matches "${name}". The biggest client names there are:`);
      partners.slice(0, 40).forEach((p) => say(`    • ${p.partnerName}   (${count(p.orders)} orders)`));
      const exact = new Set(partners.map((p) => String(p.partnerName)));
      for (let tries = 0; tries < 3 && !chosen.length; tries++) {
        const typed = await ask(`  Type ${name}'s client name(s) exactly, separated by commas — or press Enter to skip: `);
        if (!typed) return [];
        const list = typed.split(',').map((s) => s.trim()).filter(Boolean);
        const unknown = list.filter((k) => !exact.has(k));
        if (unknown.length) { say(`  Not in the delivery system: ${unknown.join(', ')}. Try again.`); continue; }
        chosen = list;
      }
    }
  }

  chosen = [...new Set(chosen)];
  // A client name belongs to ONE company — two owners means two companies see
  // the same orders.
  const taken = chosen.filter((k) => ownedBy.has(k));
  for (const k of taken) {
    const o = ownedBy.get(k);
    say(`  "${k}" already belongs to ${o.name || o.companyId}.`
      + (isPortalId(o.companyId) ? '' : ` If that is ${name} under another name, enter it again as "${o.name}".`));
  }
  return taken.length ? [] : chosen;
}

async function main() {
  if (!fs.existsSync(ENVF)) stop(`${ENVF} is missing.`);
  const original = fs.readFileSync(ENVF, 'utf8');
  const { lines, vars } = parseEnv(original);
  for (const [k, v] of vars) process.env[k] = v.value;

  let map = [];
  try {
    map = JSON.parse(vars.get('CLIENT_MAP')?.value || '[]');
    if (!Array.isArray(map)) throw new Error('not a list');
  } catch (e) {
    stop(`CLIENT_MAP in ${ENVF} is not valid JSON (${e.message}). Nothing was changed.`);
  }

  say('\n=== COMPANIES WITH A DASHBOARD NOW ===');
  if (!map.length) say('  (none)');
  for (const c of map) {
    // A short handle ('roseland') is matched by NAME, so a second company with the
    // same name — a testing copy — would see these figures too.
    say(`  • ${c.name || c.companyId}   [${c.companyId}]   ← ${keysOf(c).join(' + ')}`
      + (isPortalId(c.companyId) ? '' : '   ⚠ matched by name — enter it below with its id to pin it'));
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = async (q) => (await rl.question(q)).trim();

  // Everything works on a COPY. The file is written only after the last yes.
  const work = map.map((c) => ({ ...c }));
  const changes = [];          // { old, entry } — one per company in this run
  let partners = null;         // the delivery system's client names, read once
  let first = process.argv.slice(2).join(' ').trim();

  say('\nOne company at a time. Press Enter on an empty name when you have finished.');
  for (let turn = 0; ; turn++) {
    const name = first || await ask(turn
      ? '\nNext company name (or press Enter to finish): '
      : '\nCompany name, exactly as the portal shows it: ');
    first = '';
    if (!name) break;

    // 1. Its portal id — the lockdown key.
    const id = await askId(ask, name);
    if (!id) { say(`  Skipped ${name}.`); continue; }
    if (changes.some((c) => c.entry.companyId === id)) { say(`  ${name} is already in this run.`); continue; }

    // 2. Already on the dashboards? By its id, or — only for an entry still on a
    //    short handle — by its name.
    const byId = work.find((c) => c.companyId === id);
    const byName = byId ? null : work.find((c) => norm(c.name) === norm(name) || norm(c.companyId) === norm(name));
    let movedFrom = '';
    if (byName && isPortalId(byName.companyId)) {
      // Pinned to ANOTHER id. Usually that is a different company with the same
      // name (a testing copy), and the dashboard must stay where it is. It moves
      // only when the old id is wrong — and only on a clear yes.
      if (changes.some((c) => c.entry === byName)) { say(`  ${byName.name} is already set in this run. Skipped.`); continue; }
      const was = madeOn(byName.companyId);
      const now = madeOn(id);
      say(`  ${byName.name}'s dashboard is pinned to ${byName.companyId}${was ? ` (made ${was})` : ''}.`);
      const mv = (await ask(`  Move it to ${id}${now ? ` (made ${now})` : ''}? Only if the old id is wrong. (y/n): `)).toLowerCase();
      if (mv !== 'y') { say('  It stays where it is. Skipped.'); continue; }
      movedFrom = byName.companyId;
    }
    const old = byId || byName || null;

    // 3. Its client name(s).
    if (!partners) {
      say('  Reading the client names in the delivery system…');
      try {
        const Q = await import(path.join(APP, 'queries.js'));
        partners = await Q.partnerNames();
      } catch (e) {
        stop(`Could not read the delivery system: ${e?.message || e}. Nothing was changed.`);
      }
    }
    const chosen = await pickNames(ask, name, old, work, partners);
    if (!chosen.length) { say(`  Skipped ${name}.`); continue; }

    const entry = {
      companyId: id,
      name,
      sqlKey: chosen.length === 1 ? chosen[0] : chosen,
      // Matched by its id, so no email domain is needed — and none is guessed: a
      // wrong domain would hand these figures to strangers.
      domains: old?.domains || [],
      emails: old?.emails || [],
    };
    const same = (c) => JSON.stringify([c.companyId, c.name, keysOf(c), c.domains || [], c.emails || []]);
    if (old && same(old) === same(entry)) { say(`  ✓ ${name} is already set up exactly like that. Nothing to change.`); continue; }
    if (old) work[work.indexOf(old)] = entry; else work.push(entry);
    changes.push({ old, entry, movedFrom });
    say(`  ✓ ${name} is ready to save.`);
  }

  if (!changes.length) { rl.close(); stop('Nothing to save. Nothing was changed.'); }

  // 4. What will be saved.
  say('\n=== WHAT WILL BE SAVED ===');
  for (const { old, entry, movedFrom } of changes) {
    say(`\n  ${movedFrom ? 'MOVING' : old ? 'REPLACING' : 'ADDING'}  ${entry.name}`);
    if (old) say(`    was: ${JSON.stringify(old)}`);
    say(`    now: ${JSON.stringify(entry)}`);
  }
  const n = changes.length;
  const go = (await ask(`\nSave ${n === 1 ? 'this' : `these ${n}`} and restart the dashboards? (y/n): `)).toLowerCase();
  rl.close();
  if (go !== 'y') stop('Stopped. Nothing was changed.');

  // 5. Write it — CLIENT_MAP only, every other line exactly as it was.
  const json = JSON.stringify(work);
  if (json.includes('\\') || json.includes('\n')) stop('A name contains a character the settings file cannot hold. Nothing was changed.');
  const cm = vars.get('CLIENT_MAP');
  const out = [...lines];
  if (cm) out[cm.line] = `CLIENT_MAP=${json}`;
  else out.splice(out.length && out[out.length - 1] === '' ? out.length - 1 : out.length, 0, `CLIENT_MAP=${json}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const backup = `${ENVF}.bak-${stamp}`;
  const st = fs.statSync(ENVF);
  fs.copyFileSync(ENVF, backup);
  fs.chmodSync(backup, 0o600);
  const tmp = `${ENVF}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, out.join('\n'), { mode: st.mode & 0o777 });
  fs.chownSync(tmp, st.uid, st.gid);
  fs.renameSync(tmp, ENVF);
  say(`\nSaved. The old file is kept as ${backup}`);
  const putBack = (why) => {
    fs.copyFileSync(backup, ENVF);
    fs.chmodSync(ENVF, st.mode & 0o777);
    fs.chownSync(ENVF, st.uid, st.gid);
    stop(`${why}\nThe old settings file has been put back. The dashboards were NOT restarted.`);
  };

  // 6. Prove the lockdown with the code that will actually run.
  say('\n=== LOCKDOWN CHECK ===');
  const plan = {
    changed: changes.map(({ entry, movedFrom }) => ({
      id: entry.companyId,
      name: entry.name,
      // A same-name company made later gets the slug of today's name; one made
      // earlier carries the slug that is in this id. Both are tried.
      // A dashboard that moved must not answer to its old id any more either.
      twins: [...new Set([slugOf(entry.name), entry.companyId.split('-')[0]])].map((s) => `${s}-zzzzzzzzzzzzzz`)
        .concat(movedFrom ? [movedFrom] : []),
    })),
    pinned: work.filter((c) => isPortalId(c.companyId)).map((c) => c.companyId),
  };
  const probe = `
    const { resolveCompany } = await import(${JSON.stringify(path.join(APP, 'clients.js'))});
    const P = JSON.parse(process.env.LOCKDOWN_PLAN);
    const grp = String(process.env.SGK_GROUP || '').trim();
    const dom = String(process.env.SGK_DOMAINS || 'sgkhomedelivery.co.uk').split(',').map((s) => s.trim()).filter(Boolean)[0] || 'sgkhomedelivery.co.uk';
    const staff = { email: 'lockdown-check@' + dom, groups: grp ? [grp] : [] };
    let isStaff = false;
    try { isStaff = resolveCompany(staff).staff === true; } catch {}
    const client = (id) => { try { return resolveCompany({ email: 'lockdown-check@example.invalid', groups: ['company_' + id] }).company?.companyId ?? null; } catch { return null; } };
    const sgk = (id, name) => { try { return resolveCompany(staff, { companyId: id, companyName: name }).company?.companyId ?? null; } catch { return null; } };
    console.log(JSON.stringify({
      staff: isStaff,
      changed: P.changed.map((c) => ({
        own: client(c.id),
        twins: c.twins.map((t) => client(t)),
        stranger: client('somebodyelse-zzzzzzzzzzzzzz'),
        sgkOwn: isStaff ? sgk(c.id, c.name) : null,
        sgkTwins: isStaff ? c.twins.map((t) => sgk(t, c.name)) : [],
      })),
      pinned: P.pinned.map((id) => client(id)),
    }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: APP, encoding: 'utf8', env: { ...process.env, CLIENT_MAP: json, LOCKDOWN_PLAN: JSON.stringify(plan) },
  });
  let r = null;
  try { r = JSON.parse(String(run.stdout).trim().split('\n').pop()); } catch { /* reported below */ }
  if (!r || !Array.isArray(r.changed)) putBack(`The check could not run: ${String(run.stderr || run.stdout).slice(0, 400)}`);
  const pass = (ok, text) => { say(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`); return ok; };
  let allOk = true;
  let oldCode = false;
  plan.changed.forEach((c, i) => {
    const x = r.changed[i];
    const twinLeak = x.twins.some((t) => t === c.id) || (r.staff && x.sgkTwins.some((t) => t === c.id));
    if (twinLeak) oldCode = true;
    const ok = x.own === c.id && !twinLeak && x.stranger !== c.id && (!r.staff || x.sgkOwn === c.id);
    allOk = pass(ok, `${c.name}: its own login sees it; a same-name company and an unrelated one do not`) && allOk;
  });
  const pinnedOk = plan.pinned.every((id, i) => r.pinned[i] === id);
  allOk = pass(pinnedOk, `each of the ${plan.pinned.length} companies pinned to its id gets its own dashboard`) && allOk;
  if (!r.staff) say('  (SGK\'s own view was not checked — this box does not recognise an SGK login.)');
  if (!allOk) {
    putBack(oldCode
      ? 'The code on this box is out of date — it still matches companies by name. Update it first, then run this again.'
      : 'The lockdown check failed.');
  }

  // 7. Restart and make sure it answers.
  say('\nRestarting the dashboards…');
  const restart = spawnSync('systemctl', ['restart', SERVICE], { encoding: 'utf8' });
  if (restart.status !== 0) stop(`The restart failed: ${restart.stderr}`);
  const port = process.env.PORT || 8080;
  let health = null;
  for (let i = 0; i < 20 && !health; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    try {
      const h = await fetch(`http://127.0.0.1:${port}/health`);
      if (h.ok) health = await h.json();
    } catch { /* still starting */ }
  }
  if (!health) stop(`The service did not answer after the restart. Run:  sudo journalctl -u ${SERVICE} -n 50`);
  say(`  The service is running · database: ${health.db} · companies with a dashboard: ${health.clients}`);
  const names = changes.map((c) => c.entry.name);
  say(`\n✔ DONE — ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} live. Each one's Dashboard in the portal shows it now.`);
  process.exit(0);
}

main().catch((e) => stop(e?.stack || e?.message || String(e)));
