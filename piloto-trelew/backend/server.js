'use strict';
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const app = express();
app.use(express.json({ limit: '20kb' }));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required; refusing to use ephemeral storage');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000
});
pool.on('error', err => console.error('PostgreSQL idle connection error:', err.message));

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://nicoamici-lang.github.io');
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Key,X-Merchant-Key');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const allowed = new Set(['scan', 'open']);
app.get('/health', (req, res) => res.json({ ok: true, service: 'vt-piloto-v2' }));
app.get('/health/db', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'postgresql' });
  } catch (err) {
    console.error('Database health check failed:', err.message);
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});

app.post('/api/events', async (req, res) => {
  const { id, vt, type, offer, session } = req.body || {};
  const m = typeof vt === 'string' && /^VT-\d{6}$/.test(vt);
  const num = m ? Number(vt.slice(3)) : 0;
  if (!m || num < 1 || num > 36 || !allowed.has(type) ||
      typeof id !== 'string' || !/^[-\w]{12,90}$/.test(id) ||
      typeof session !== 'string' || !session.length || session.length > 100) {
    return res.status(400).json({ error: 'invalid event' });
  }
  const sessionHash = crypto.createHash('sha256').update(session).digest('hex');
  const record = [id, new Date().toISOString(), vt, Math.floor((num - 1) / 6) + 1,
    (num - 1) % 6 + 1, type, typeof offer === 'string' ? offer.slice(0, 80) : null, sessionHash];
  try {
    const result = await pool.query(
      'INSERT INTO events (id,created_at,vt,bus,position,type,offer,session_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING',
      record
    );
    res.json({ ok: true, stored: result.rowCount === 1 });
  } catch (err) {
    console.error('Event insert failed:', err.message);
    res.status(503).json({ error: 'storage unavailable' });
  }
});

app.get('/api/stats', async (req, res) => {
  const expected = process.env.ADMIN_KEY;
  const provided = req.get('X-Admin-Key') || '';
  const a = Buffer.from(provided), b = Buffer.from(expected || '');
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const [totals, byVT, recent] = await Promise.all([
      pool.query('SELECT type, COUNT(*)::int AS count FROM events GROUP BY type'),
      pool.query("SELECT vt,bus,position,COUNT(*) FILTER (WHERE type='scan')::int AS scans,COUNT(*) FILTER (WHERE type='open')::int AS opens FROM events GROUP BY vt,bus,position ORDER BY vt"),
      pool.query('SELECT created_at,vt,bus,position,type,offer FROM events ORDER BY created_at DESC LIMIT 100')
    ]);
    res.json({ totals: totals.rows, byVT: byVT.rows, recent: recent.rows });
  } catch (err) {
    console.error('Stats query failed:', err.message);
    res.status(503).json({ error: 'storage unavailable' });
  }
});


const couponOffer = 'pueblo-demo';
function merchantAuthorized(req) {
  const expected = process.env.MERCHANT_KEY || '';
  const provided = req.get('X-Merchant-Key') || '';
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return !!expected && a.length === b.length && crypto.timingSafeEqual(a,b);
}
app.post('/api/coupons', async (req,res) => {
  const { vt } = req.body || {};
  if (vt !== undefined && (typeof vt !== 'string' || !/^VT-\\d{6}$/.test(vt) || Number(vt.slice(3)) < 1 || Number(vt.slice(3)) > 36)) return res.status(400).json({error:'invalid marker'});
  const code = 'VT-PUE-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  try {
    await pool.query('INSERT INTO demo_coupons (code,offer,vt) VALUES ($1,$2,$3)',[code,couponOffer,vt||null]);
    res.status(201).json({ok:true,code,status:'available'});
  } catch(e){console.error('Coupon issue failed:',e.message);res.status(503).json({error:'storage unavailable'})}
});
app.get('/api/coupons/:code', async(req,res)=>{
  const code=String(req.params.code||'').toUpperCase();
  if(!/^VT-PUE-[A-F0-9]{12}$/.test(code))return res.status(400).json({error:'invalid code'});
  try{
    const q=await pool.query('SELECT code,used_at FROM demo_coupons WHERE code=$1',[code]);
    if(!q.rowCount)return res.status(404).json({error:'not found'});
    res.json({ok:true,code,status:q.rows[0].used_at?'used':'available'});
  }catch(e){console.error('Coupon lookup failed:',e.message);res.status(503).json({error:'storage unavailable'})}
});
app.post('/api/coupons/redeem',async(req,res)=>{
  if(!merchantAuthorized(req))return res.status(401).json({error:'unauthorized'});
  const code=String(req.body?.code||'').trim().toUpperCase();
  if(!/^VT-PUE-[A-F0-9]{12}$/.test(code))return res.status(400).json({error:'invalid code'});
  try{
    const q=await pool.query('UPDATE demo_coupons SET used_at=NOW() WHERE code=$1 AND used_at IS NULL RETURNING code',[code]);
    if(q.rowCount)return res.json({ok:true,status:'redeemed'});
    const found=await pool.query('SELECT used_at FROM demo_coupons WHERE code=$1',[code]);
    return res.status(found.rowCount?409:404).json({error:found.rowCount?'already redeemed':'not found'});
  }catch(e){console.error('Coupon redemption failed:',e.message);res.status(503).json({error:'storage unavailable'})}
});

async function start() {
  try {
    await pool.query('SELECT 1');
    await pool.query(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL,
      vt TEXT NOT NULL,
      bus INTEGER NOT NULL,
      position INTEGER NOT NULL,
      type TEXT NOT NULL,
      offer TEXT,
      session_hash TEXT
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS demo_coupons (
      code TEXT PRIMARY KEY,
      offer TEXT NOT NULL,
      vt TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ
    )`);
    const port = process.env.PORT || 3000;
    app.listen(port, '0.0.0.0', () => console.log('VT pilot API listening on 0.0.0.0:' + port + ' (PostgreSQL)'));
  } catch (err) {
    console.error('PostgreSQL startup failed:', err.message);
    process.exit(1);
  }
}
start();
