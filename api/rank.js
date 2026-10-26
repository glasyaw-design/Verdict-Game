// 판결의 무게 · 랭킹 API (Vercel Serverless Function, 의존성 없음)
// 저장소: Upstash Redis (Vercel Marketplace에서 연결하면 환경 변수가 자동으로 들어옵니다)
//   KV_REST_API_URL / KV_REST_API_TOKEN  또는  UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
// GET  /api/rank?ping=1                         → {ok:true|false}
// GET  /api/rank?board=career&len=normal&pid=…  → {ok, top:[…], me:{rank,entry}|null}
// GET  /api/rank?board=daily&date=YYYY-MM-DD&pid=…
// GET  /api/rank?board=weekly&week=YYYY-Www&pid=…
// GET  /api/rank?board=quiz&pid=…
// POST /api/rank  {board:'career', len, pid, name, pts, cases, rep, grade, diff, dock}
//                 {board:'daily', date, pid, name, score, no}      (첫 도전만)
//                 {board:'weekly', week, pid, name, score}         (이번 주 최고 기록)
//                 {board:'quiz', pid, name, ok, sec}               (최고 기록)
//                 {board:'const', pid, name, score, n, perfect}    (헌법재판소 총점, 최고 기록)

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const LENS = { short: 8, normal: 12, long: 20, epic: 40 };
const DIFF_MULT = { easy: 0.9, normal: 1, hard: 1.1, master: 1.2 };
const TOP_N = 50;

async function redis(cmds) {
  const r = await fetch(URL_.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  const out = await r.json();
  return out.map((x) => (x && 'result' in x ? x.result : null));
}

const cleanName = (s) =>
  String(s || '')
    .replace(/[<>"'&\\/`]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 6) || '익명';
const cleanPid = (s) => (/^[a-z0-9]{12,40}$/.test(String(s || '')) ? String(s) : null);
const int = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};
// 한국 시간 기준 날짜
const kstDay = (offsetDays = 0) => {
  const d = new Date(Date.now() + 9 * 3600e3 + offsetDays * 864e5);
  return d.toISOString().slice(0, 10);
};
// ISO 주 (한국 시간 기준)
const kstWeek = (offsetDays = 0) => {
  const d = new Date(Date.now() + 9 * 3600e3 + offsetDays * 864e5);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
};

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return null; } }
  const chunks = [];
  for await (const c of req) { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 4096) return null; }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

async function topList(zkey, hkey, pid) {
  const [ids] = await redis([['ZREVRANGE', zkey, 0, TOP_N - 1, 'WITHSCORES']]);
  const members = [];
  for (let i = 0; i < (ids || []).length; i += 2) members.push([ids[i], Number(ids[i + 1])]);
  const cmds = [];
  if (members.length) cmds.push(['HMGET', hkey, ...members.map((m) => m[0])]);
  if (pid) { cmds.push(['ZREVRANK', zkey, pid]); cmds.push(['HGET', hkey, pid]); cmds.push(['ZCARD', zkey]); }
  const r = cmds.length ? await redis(cmds) : [];
  let k = 0;
  const details = members.length ? r[k++] || [] : [];
  const top = members.map((m, i) => {
    let e = {};
    try { e = JSON.parse(details[i] || '{}'); } catch {}
    return { ...e, rank: i + 1, score: m[1], me: m[0] === pid };
  });
  let me = null, total = 0;
  if (pid) {
    const rk = r[k++], raw = r[k++];
    total = r[k++] || 0;
    if (rk !== null && rk !== undefined) {
      let e = {};
      try { e = JSON.parse(raw || '{}'); } catch {}
      me = { ...e, rank: Number(rk) + 1 };
    }
  }
  return { top, me, total };
}

// 기록은 그대로 두고 이름만 새 이름으로 맞춘다
async function renameIfNeeded(hkey, pid, name) {
  const [raw] = await redis([['HGET', hkey, pid]]);
  if (!raw) return;
  let e = {};
  try { e = JSON.parse(raw); } catch {}
  if (e.name !== name) { e.name = name; await redis([['HSET', hkey, pid, JSON.stringify(e)]]); }
}
// 더 높은 점수일 때만 바꾼다
async function keepBest(zkey, hkey, pid, score, detail, ttl) {
  const [prev] = await redis([['ZSCORE', zkey, pid]]);
  let improved = false;
  if (prev === null || Number(prev) < score) {
    improved = true;
    const cmds = [['ZADD', zkey, score, pid], ['HSET', hkey, pid, JSON.stringify(detail)]];
    if (ttl) cmds.push(['EXPIRE', zkey, ttl], ['EXPIRE', hkey, ttl]);
    await redis(cmds);
  } else if (prev !== null) {
    await renameIfNeeded(hkey, pid, detail.name);
  }
  const [rk] = await redis([['ZREVRANK', zkey, pid]]);
  return { ok: true, improved, rank: rk === null ? null : Number(rk) + 1, score };
}

export default async function handler(req, res) {
  if (!URL_ || !TOKEN) return send(res, 200, { ok: false, reason: 'storage_not_configured' });
  try {
    if (req.method === 'GET') {
      const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      if (q.ping) return send(res, 200, { ok: true });
      const pid = cleanPid(q.pid);
      if (q.board === 'career') {
        const len = LENS[q.len] ? q.len : 'normal';
        return send(res, 200, { ok: true, ...(await topList('vr:cr:' + len, 'vr:crd:' + len, pid)) });
      }
      if (q.board === 'daily') {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : kstDay();
        return send(res, 200, { ok: true, date, ...(await topList('vr:dl:' + date, 'vr:dld:' + date, pid)) });
      }
      if (q.board === 'weekly') {
        const week = /^\d{4}-W\d{2}$/.test(q.week || '') ? q.week : kstWeek();
        return send(res, 200, { ok: true, week, ...(await topList('vr:wk:' + week, 'vr:wkd:' + week, pid)) });
      }
      if (q.board === 'quiz') {
        return send(res, 200, { ok: true, ...(await topList('vr:qz', 'vr:qzd', pid)) });
      }
      if (q.board === 'const') {
        return send(res, 200, { ok: true, ...(await topList('vr:cs', 'vr:csd', pid)) });
      }
      return send(res, 400, { ok: false, reason: 'bad_board' });
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (!b) return send(res, 400, { ok: false, reason: 'bad_body' });
      const pid = cleanPid(b.pid);
      if (!pid) return send(res, 400, { ok: false, reason: 'bad_pid' });
      // 간단한 속도 제한: 기기당 1분 10회
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'na';
      const [cnt] = await redis([['INCR', 'vr:rl:' + pid + ':' + ip], ['EXPIRE', 'vr:rl:' + pid + ':' + ip, 60]]);
      if (cnt > 10) return send(res, 429, { ok: false, reason: 'rate_limited' });
      const name = cleanName(b.name);
      if (b.board === 'career') {
        const len = LENS[b.len] ? b.len : null;
        if (!len) return send(res, 400, { ok: false, reason: 'bad_len' });
        const cases = int(b.cases, 1, 999);
        if (cases !== LENS[len] * 3) return send(res, 400, { ok: false, reason: 'career_not_complete' });
        const pts = int(b.pts, 0, cases * 100);
        const rep = int(b.rep, 0, 100);
        const grade = int(b.grade ?? b.rank, 0, 4);
        const diff = DIFF_MULT[b.diff] ? b.diff : 'normal';
        if (pts === null || rep === null || grade === null) return send(res, 400, { ok: false, reason: 'bad_values' });
        // 랭킹 점수 = 경력 점수 × 난이도 배율 (+ 평판 동점 처리)
        const score = Math.round(pts * DIFF_MULT[diff]) + rep / 1000;
        const zkey = 'vr:cr:' + len, hkey = 'vr:crd:' + len;
        const [prev] = await redis([['ZSCORE', zkey, pid]]);
        let improved = false;
        if (prev === null || Number(prev) < score) {
          improved = true;
          await redis([
            ['ZADD', zkey, score, pid],
            ['HSET', hkey, pid, JSON.stringify({ name, pts, rep, grade, diff, cases, date: kstDay() })],
          ]);
        } else {
          await renameIfNeeded(hkey, pid, name);
        }
        const [rk] = await redis([['ZREVRANK', zkey, pid]]);
        return send(res, 200, { ok: true, improved, rank: rk === null ? null : Number(rk) + 1, score });
      }
      if (b.board === 'daily') {
        const date = String(b.date || '');
        if (date !== kstDay() && date !== kstDay(-1)) return send(res, 400, { ok: false, reason: 'bad_date' });
        const s = int(b.score, 0, 100);
        if (s === null) return send(res, 400, { ok: false, reason: 'bad_values' });
        const zkey = 'vr:dl:' + date, hkey = 'vr:dld:' + date;
        // 첫 도전만 기록 (NX). 같은 점수면 먼저 낸 사람이 위: 점수 + 하루 중 남은 시간 비율
        const t = (Date.now() + 9 * 3600e3) % 864e5;
        const score = s + (1 - t / 864e5) / 10;
        const [added] = await redis([
          ['ZADD', zkey, 'NX', score, pid],
          ['EXPIRE', zkey, 60 * 60 * 24 * 14],
        ]);
        if (added) await redis([['HSET', hkey, pid, JSON.stringify({ name, total: s, no: String(b.no || '').slice(0, 20) })], ['EXPIRE', hkey, 60 * 60 * 24 * 14]]);
        else await renameIfNeeded(hkey, pid, name);
        const [rk] = await redis([['ZREVRANK', zkey, pid]]);
        return send(res, 200, { ok: true, first: !!added, rank: rk === null ? null : Number(rk) + 1 });
      }
      if (b.board === 'weekly') {
        const week = String(b.week || '');
        if (week !== kstWeek() && week !== kstWeek(-1)) return send(res, 400, { ok: false, reason: 'bad_week' });
        const score = int(b.score, 0, 300);
        if (score === null) return send(res, 400, { ok: false, reason: 'bad_values' });
        return send(res, 200, await keepBest('vr:wk:' + week, 'vr:wkd:' + week, pid, score, { name }, 60 * 60 * 24 * 60));
      }
      if (b.board === 'quiz') {
        const ok = int(b.ok, 0, 10), sec = int(b.sec, 1, 7200);
        if (ok === null || sec === null) return send(res, 400, { ok: false, reason: 'bad_values' });
        const score = ok * 1000 + Math.max(0, 600 - sec);
        return send(res, 200, await keepBest('vr:qz', 'vr:qzd', pid, score, { name, ok, sec, date: kstDay() }, 0));
      }
      if (b.board === 'const') {
        const total = int(b.score, 0, 10000), n = int(b.n, 0, 100), perfect = int(b.perfect, 0, 100);
        if (total === null || n === null || perfect === null || total > n * 100 || perfect > n) return send(res, 400, { ok: false, reason: 'bad_values' });
        const score = total * 100 + perfect;
        return send(res, 200, await keepBest('vr:cs', 'vr:csd', pid, score, { name, total, n, perfect, date: kstDay() }, 0));
      }
      return send(res, 400, { ok: false, reason: 'bad_board' });
    }
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { ok: false });
  } catch (e) {
    return send(res, 500, { ok: false, reason: 'server_error' });
  }
}
