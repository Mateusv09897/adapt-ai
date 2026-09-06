import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const SESSION_TOKEN_TTL_SECONDS = 60 * 60 * 24;
const ADMIN_TOKEN_TTL_SECONDS = 60 * 30;
const ADMIN_RATE_WINDOW_MINUTES = 15;
const ADMIN_MAX_FAILURES = 5;

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL && process.env.RESEARCH_SIGNING_SECRET);
}

export function isAdminConfigured() {
  return Boolean(isDatabaseConfigured() && process.env.RESEARCH_ADMIN_KEY);
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

  // Mantém somente um identificador irreversível do cliente e contadores de tentativas.
  // Nenhum IP, user-agent ou senha administrativa é persistido.
  await sql`
    CREATE TABLE IF NOT EXISTS adapt_admin_auth_attempts (
      client_hash VARCHAR(64) PRIMARY KEY,
      failures SMALLINT NOT NULL DEFAULT 0,
      window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      blocked_until TIMESTAMPTZ
    )
  `;
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signValue(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createSignedToken(payload) {
  const secret = process.env.RESEARCH_SIGNING_SECRET;
  if (!secret) throw new Error('RESEARCH_SIGNING_SECRET não configurado.');
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${signValue(encoded, secret)}`;
}

function verifySignedToken(token) {
  const secret = process.env.RESEARCH_SIGNING_SECRET;
  if (!secret || !token || !token.includes('.')) throw new Error('Token inválido.');
  const [encoded, signature] = token.split('.');
  const expected = signValue(encoded, secret);
  const a = Buffer.from(signature || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Token inválido.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expirado.');
  return payload;
}

export function createSessionToken({ sessionId, participantCode, isTest }) {
  return createSignedToken({
    token_type: 'research-session',
    session_id: sessionId,
    participant_code: participantCode,
    is_test: Boolean(isTest),
    exp: Math.floor(Date.now() / 1000) + SESSION_TOKEN_TTL_SECONDS
  });
}

export function verifySessionToken(token) {
  const payload = verifySignedToken(token);
  // Compatibilidade com tokens emitidos antes da introdução de token_type.
  if (payload.token_type && payload.token_type !== 'research-session') throw new Error('Token de sessão inválido.');
  return payload;
}

export function createAdminToken({ clientHash }) {
  return createSignedToken({
    token_type: 'research-admin',
    client_hash: clientHash,
    exp: Math.floor(Date.now() / 1000) + ADMIN_TOKEN_TTL_SECONDS
  });
}

export function verifyAdminToken(token, expectedClientHash) {
  const payload = verifySignedToken(token);
  if (payload.token_type !== 'research-admin') throw new Error('Sessão administrativa inválida.');
  if (!payload.client_hash || payload.client_hash !== expectedClientHash) throw new Error('Sessão administrativa inválida para este cliente.');
  return payload;
}

export function adminTokenTtlSeconds() {
  return ADMIN_TOKEN_TTL_SECONDS;
}

export function verifyAdminKey(value) {
  const expected = process.env.RESEARCH_ADMIN_KEY;
  if (!expected || !value) return false;
  const a = Buffer.from(String(value));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function adminClientHash(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || String(req.socket?.remoteAddress || 'unknown');
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 300);
  const secret = process.env.RESEARCH_SIGNING_SECRET || 'adapt';
  return crypto.createHmac('sha256', secret).update(`${ip}|${userAgent}`).digest('hex');
}

export async function getAdminRateLimit(sql, clientHash) {
  const rows = await sql`
    SELECT failures, window_started_at, blocked_until
    FROM adapt_admin_auth_attempts
    WHERE client_hash = ${clientHash}
    LIMIT 1
  `;
  if (!rows.length) return { blocked: false, failures: 0, retry_after: 0 };

  const row = rows[0];
  const now = Date.now();
  const blockedUntil = row.blocked_until ? new Date(row.blocked_until).getTime() : 0;
  if (blockedUntil > now) {
    return {
      blocked: true,
      failures: Number(row.failures) || 0,
      retry_after: Math.max(1, Math.ceil((blockedUntil - now) / 1000))
    };
  }

  const windowStart = new Date(row.window_started_at).getTime();
  if (!Number.isFinite(windowStart) || now - windowStart > ADMIN_RATE_WINDOW_MINUTES * 60 * 1000) {
    await sql`
      UPDATE adapt_admin_auth_attempts
      SET failures = 0, window_started_at = NOW(), blocked_until = NULL
      WHERE client_hash = ${clientHash}
    `;
    return { blocked: false, failures: 0, retry_after: 0 };
  }

  return { blocked: false, failures: Number(row.failures) || 0, retry_after: 0 };
}

export async function recordAdminAuthFailure(sql, clientHash) {
  const rows = await sql`
    INSERT INTO adapt_admin_auth_attempts (client_hash, failures, window_started_at, blocked_until)
    VALUES (${clientHash}, 1, NOW(), NULL)
    ON CONFLICT (client_hash) DO UPDATE SET
      failures = CASE
        WHEN adapt_admin_auth_attempts.window_started_at < NOW() - INTERVAL '15 minutes' THEN 1
        ELSE adapt_admin_auth_attempts.failures + 1
      END,
      window_started_at = CASE
        WHEN adapt_admin_auth_attempts.window_started_at < NOW() - INTERVAL '15 minutes' THEN NOW()
        ELSE adapt_admin_auth_attempts.window_started_at
      END,
      blocked_until = CASE
        WHEN adapt_admin_auth_attempts.window_started_at < NOW() - INTERVAL '15 minutes' THEN NULL
        WHEN adapt_admin_auth_attempts.failures + 1 >= ${ADMIN_MAX_FAILURES} THEN NOW() + INTERVAL '15 minutes'
        ELSE adapt_admin_auth_attempts.blocked_until
      END
    RETURNING failures, blocked_until
  `;
  const row = rows[0] || {};
  const blockedUntil = row.blocked_until ? new Date(row.blocked_until).getTime() : 0;
  return {
    failures: Number(row.failures) || 0,
    blocked: blockedUntil > Date.now(),
    retry_after: blockedUntil > Date.now() ? Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000)) : 0
  };
}

export async function clearAdminAuthFailures(sql, clientHash) {
  await sql`
    INSERT INTO adapt_admin_auth_attempts (client_hash, failures, window_started_at, blocked_until)
    VALUES (${clientHash}, 0, NOW(), NULL)
    ON CONFLICT (client_hash) DO UPDATE SET
      failures = 0,
      window_started_at = NOW(),
      blocked_until = NULL
  `;
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
