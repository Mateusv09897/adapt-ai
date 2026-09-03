import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const TOKEN_TTL_SECONDS = 60 * 60 * 24;

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL && process.env.RESEARCH_SIGNING_SECRET);
}

export function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada.');
  return neon(process.env.DATABASE_URL);
}

export async function ensureResearchSchema(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS adapt_research_events (
      event_id UUID PRIMARY KEY,
      session_id UUID NOT NULL,
      participant_code VARCHAR(32) NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_test BOOLEAN NOT NULL DEFAULT FALSE,
      module VARCHAR(80),
      help_level SMALLINT,
      input_length INTEGER,
      with_code BOOLEAN,
      mode VARCHAR(24),
      completed BOOLEAN,
      reason VARCHAR(64),
      duration_seconds INTEGER
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_adapt_events_participant ON adapt_research_events (participant_code)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_adapt_events_session ON adapt_research_events (session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_adapt_events_occurred ON adapt_research_events (occurred_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_adapt_events_test ON adapt_research_events (is_test)`;
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signValue(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function createSessionToken({ sessionId, participantCode, isTest }) {
  const secret = process.env.RESEARCH_SIGNING_SECRET;
  if (!secret) throw new Error('RESEARCH_SIGNING_SECRET não configurado.');
  const payload = {
    session_id: sessionId,
    participant_code: participantCode,
    is_test: Boolean(isTest),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  };
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${signValue(encoded, secret)}`;
}

export function verifySessionToken(token) {
  const secret = process.env.RESEARCH_SIGNING_SECRET;
  if (!secret || !token || !token.includes('.')) throw new Error('Token de sessão inválido.');
  const [encoded, signature] = token.split('.');
  const expected = signValue(encoded, secret);
  const a = Buffer.from(signature || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Token de sessão inválido.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token de sessão expirado.');
  return payload;
}

export function verifyAdminKey(value) {
  const expected = process.env.RESEARCH_ADMIN_KEY;
  if (!expected || !value) return false;
  const a = Buffer.from(String(value));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

export function sanitizeParticipantCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,32}$/.test(code)) return null;
  return code;
}

export function mapDbEvent(row) {
  return {
    event_id: row.event_id,
    event: row.event_type,
    timestamp: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    session_id: row.session_id,
    participant_code: row.participant_code,
    is_test: row.is_test,
    module: row.module,
    help_level: row.help_level,
    input_length: row.input_length,
    with_code: row.with_code,
    mode: row.mode,
    completed: row.completed,
    reason: row.reason,
    duration_seconds: row.duration_seconds
  };
}
