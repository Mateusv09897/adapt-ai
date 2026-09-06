import {
  adminClientHash,
  ensureResearchSchema,
  getSql,
  isDatabaseConfigured,
  mapDbEvent,
  sanitizeParticipantCode,
  validUuid,
  verifyAdminToken
} from '../lib/research-db.js';

const DEFAULT_PARTICIPANT_PAGE_SIZE = 25;
const MAX_PARTICIPANT_PAGE_SIZE = 50;
const DEFAULT_SESSION_PAGE_SIZE = 10;
const MAX_SESSION_PAGE_SIZE = 25;

function bearer(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

function positiveInteger(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, Math.trunc(n));
}

function pageMeta(total, page, limit) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return {
    page,
    limit,
    total,
    pages,
    has_previous: page > 1,
    has_next: page < pages
  };
}

export default async function handler(req, res) {
  setNoStore(res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  if (!isDatabaseConfigured()) return res.status(503).json({ configured: false, error: 'Armazenamento central ainda não configurado.' });

  try {
    verifyAdminToken(bearer(req), adminClientHash(req));
  } catch {
    return res.status(401).json({ error: 'Sessão administrativa inválida ou expirada.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const action = String(body.action || '');
    const sql = getSql();
    await ensureResearchSchema(sql);

    // O painel usa agregações no servidor para não transferir todos os eventos ao navegador.
    if (action === 'dashboard-summary') {
      const [metricsRows, barrierRows, helpRows] = await Promise.all([
        sql`
          WITH research AS (
            SELECT session_id, participant_code, event_type, help_level, duration_seconds
            FROM adapt_research_events
            WHERE is_test = FALSE
          ),
          started AS (
            SELECT DISTINCT session_id, participant_code
            FROM research
            WHERE event_type = 'session_started'
          ),
          mediated AS (
            SELECT DISTINCT session_id
            FROM research
            WHERE event_type = 'mediation_generated'
          ),
          returned AS (
            SELECT DISTINCT session_id
            FROM research
            WHERE event_type = 'return_to_activity'
          ),
          max_help AS (
            SELECT session_id, MAX(COALESCE(help_level, 0)) AS max_help
            FROM research
            WHERE event_type IN ('mediation_generated', 'additional_hint_requested')
            GROUP BY session_id
          )
          SELECT
            (SELECT COUNT(DISTINCT participant_code) FROM started WHERE participant_code IS NOT NULL) AS participants,
            (SELECT COUNT(DISTINCT session_id) FROM started) AS sessions,
            (SELECT COUNT(*) FROM research WHERE event_type = 'mediation_generated') AS mediations,
            (SELECT COUNT(*) FROM mediated) AS mediated_sessions,
            (SELECT COUNT(*) FROM mediated m INNER JOIN returned r USING (session_id)) AS returned_mediated_sessions,
            (SELECT AVG(max_help)::float8 FROM max_help) AS avg_help,
            (SELECT AVG(duration_seconds)::float8 FROM research WHERE event_type = 'session_ended' AND duration_seconds IS NOT NULL) AS avg_duration
        `,
        sql`
          SELECT COALESCE(module, 'Outro') AS module, COUNT(*) AS count
          FROM adapt_research_events
          WHERE is_test = FALSE AND event_type = 'barrier_selected'
          GROUP BY COALESCE(module, 'Outro')
          ORDER BY count DESC, module ASC
        `,
        sql`
          WITH max_help AS (
            SELECT session_id, MAX(COALESCE(help_level, 0)) AS level
            FROM adapt_research_events
            WHERE is_test = FALSE
              AND event_type IN ('mediation_generated', 'additional_hint_requested')
            GROUP BY session_id
          )
          SELECT
            COUNT(*) FILTER (WHERE level <= 1) AS one_mediation,
            COUNT(*) FILTER (WHERE level = 2) AS two_hints,
            COUNT(*) FILTER (WHERE level >= 3) AS three_plus_hints
          FROM max_help
        `
      ]);

      const metrics = metricsRows[0] || {};
      const mediatedSessions = Number(metrics.mediated_sessions) || 0;
      const returnedMediated = Number(metrics.returned_mediated_sessions) || 0;
      const help = helpRows[0] || {};

      return res.status(200).json({
        metrics: {
          participants: Number(metrics.participants) || 0,
          sessions: Number(metrics.sessions) || 0,
          mediations: Number(metrics.mediations) || 0,
          return_rate: mediatedSessions ? Math.round((returnedMediated / mediatedSessions) * 100) : 0,
          avg_help: Number(metrics.avg_help) || 0,
          avg_duration: Number(metrics.avg_duration) || 0
        },
        barriers: barrierRows.map(row => ({ module: row.module, count: Number(row.count) || 0 })),
        help_distribution: {
          one_mediation: Number(help.one_mediation) || 0,
          two_hints: Number(help.two_hints) || 0,
          three_plus_hints: Number(help.three_plus_hints) || 0
        }
      });
    }

    if (action === 'list-participants') {
      const page = positiveInteger(body.page, 1, 1000000);
      const limit = positiveInteger(body.limit, DEFAULT_PARTICIPANT_PAGE_SIZE, MAX_PARTICIPANT_PAGE_SIZE);
      const offset = (page - 1) * limit;

      const [countRows, rows] = await Promise.all([
        sql`
          SELECT COUNT(DISTINCT participant_code) AS total
          FROM adapt_research_events
          WHERE is_test = FALSE AND participant_code IS NOT NULL
        `,
        sql`
          SELECT
            participant_code,
            COUNT(*) AS events,
            COUNT(DISTINCT session_id) AS sessions,
            MAX(occurred_at) AS last_activity
          FROM adapt_research_events
          WHERE is_test = FALSE AND participant_code IS NOT NULL
          GROUP BY participant_code
          ORDER BY participant_code ASC
          LIMIT ${limit} OFFSET ${offset}
        `
      ]);

      const total = Number(countRows[0]?.total) || 0;
      return res.status(200).json({
        participants: rows.map(row => ({
          participant_code: row.participant_code,
          events: Number(row.events) || 0,
          sessions: Number(row.sessions) || 0,
          last_activity: row.last_activity instanceof Date ? row.last_activity.toISOString() : row.last_activity
        })),
        pagination: pageMeta(total, page, limit)
      });
    }

    if (action === 'participant-sessions') {
      const code = sanitizeParticipantCode(body.participant_code);
      if (!code) return res.status(400).json({ error: 'Código inválido.' });

      const page = positiveInteger(body.page, 1, 1000000);
      const limit = positiveInteger(body.limit, DEFAULT_SESSION_PAGE_SIZE, MAX_SESSION_PAGE_SIZE);
      const offset = (page - 1) * limit;

      const [countRows, eventCountRows, rows] = await Promise.all([
        sql`
          SELECT COUNT(DISTINCT session_id) AS total
          FROM adapt_research_events
          WHERE is_test = FALSE AND participant_code = ${code}
        `,
        sql`
          SELECT COUNT(*) AS total_events
          FROM adapt_research_events
          WHERE is_test = FALSE AND participant_code = ${code}
        `,
        sql`
          SELECT
            session_id,
            COALESCE(
              MIN(occurred_at) FILTER (WHERE event_type = 'session_started'),
              MIN(occurred_at)
            ) AS started_at,
            COUNT(*) AS event_count,
            ARRAY_AGG(DISTINCT module) FILTER (WHERE module IS NOT NULL) AS modules,
            MAX(COALESCE(help_level, 0)) AS max_help_level,
            BOOL_OR(event_type = 'return_to_activity') AS returned_to_activity,
            MAX(duration_seconds) FILTER (WHERE event_type = 'session_ended') AS duration_seconds,
            BOOL_OR(event_type = 'session_ended') AS ended
          FROM adapt_research_events
          WHERE is_test = FALSE AND participant_code = ${code}
          GROUP BY session_id
          ORDER BY COALESCE(
            MIN(occurred_at) FILTER (WHERE event_type = 'session_started'),
            MIN(occurred_at)
          ) DESC
          LIMIT ${limit} OFFSET ${offset}
        `
      ]);

      const total = Number(countRows[0]?.total) || 0;
      return res.status(200).json({
        participant_code: code,
        total_events: Number(eventCountRows[0]?.total_events) || 0,
        sessions: rows.map(row => ({
          session_id: row.session_id,
          started_at: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
          event_count: Number(row.event_count) || 0,
          modules: Array.isArray(row.modules) ? row.modules.filter(Boolean) : [],
          max_help_level: Number(row.max_help_level) || 0,
          returned_to_activity: Boolean(row.returned_to_activity),
          duration_seconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
          ended: Boolean(row.ended)
        })),
        pagination: pageMeta(total, page, limit)
      });
    }

    // Exportações continuam podendo solicitar a base completa de eventos.
    if (action === 'list-research' || action === 'list-tests') {
      const isTest = action === 'list-tests';
      const rows = await sql`
        SELECT event_id, session_id, participant_code, event_type, occurred_at, is_test,
               module, help_level, input_length, with_code, mode, completed, reason, duration_seconds
        FROM adapt_research_events
        WHERE is_test = ${isTest}
        ORDER BY occurred_at ASC
      `;
      return res.status(200).json({ events: rows.map(mapDbEvent) });
    }

    if (action === 'delete-participant') {
      const code = sanitizeParticipantCode(body.participant_code);
      if (!code) return res.status(400).json({ error: 'Código inválido.' });
      const rows = await sql`DELETE FROM adapt_research_events WHERE participant_code = ${code} AND is_test = FALSE RETURNING event_id`;
      return res.status(200).json({ deleted: rows.length });
    }

    if (action === 'delete-session') {
      const code = sanitizeParticipantCode(body.participant_code);
      const sessionId = String(body.session_id || '');
      if (!code || !validUuid(sessionId)) return res.status(400).json({ error: 'Código ou sessão inválidos.' });
      const rows = await sql`DELETE FROM adapt_research_events WHERE participant_code = ${code} AND session_id = ${sessionId} AND is_test = FALSE RETURNING event_id`;
      return res.status(200).json({ deleted: rows.length });
    }

    if (action === 'clear-tests') {
      const rows = await sql`DELETE FROM adapt_research_events WHERE is_test = TRUE RETURNING event_id`;
      return res.status(200).json({ deleted: rows.length });
    }

    return res.status(400).json({ error: 'Ação administrativa desconhecida.' });
  } catch (error) {
    if (error instanceof SyntaxError) return res.status(400).json({ error: 'Payload inválido.' });
    console.error('Erro administrativo da pesquisa:', error);
    return res.status(500).json({ error: 'Falha ao acessar o armazenamento central.' });
  }
}
