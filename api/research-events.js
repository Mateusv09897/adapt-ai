import { ensureResearchSchema, getSql, isDatabaseConfigured, validUuid, verifySessionToken } from '../lib/research-db.js';

const ALLOWED_EVENTS = new Set([
  'session_started','barrier_selected','mediation_generated','additional_hint_requested',
  'return_to_activity','session_ended','voice_started','mediation_narrated',
  'inactivity_warning','inactivity_session_continued','research_data_deleted'
]);

function bearer(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function cleanString(value, max) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, max);
}

function cleanInteger(value, min, max) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  if (!isDatabaseConfigured()) return res.status(503).json({ configured: false, error: 'Armazenamento central ainda não configurado.' });

  try {
    const payload = verifySessionToken(bearer(req));
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const events = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
    if (!events.length) return res.status(400).json({ error: 'Nenhum evento recebido.' });

    const sql = getSql();
    await ensureResearchSchema(sql);

    let saved = 0;
    for (const item of events) {
      if (!validUuid(item.event_id) || !validUuid(item.session_id)) continue;
      if (item.session_id !== payload.session_id || String(item.participant_code || '').toUpperCase() !== payload.participant_code) continue;
      if (!ALLOWED_EVENTS.has(item.event)) continue;

      const occurredAt = new Date(item.timestamp);
      if (Number.isNaN(occurredAt.getTime())) continue;

      const rows = await sql`
        INSERT INTO adapt_research_events (
          event_id, session_id, participant_code, event_type, occurred_at, is_test,
          module, help_level, input_length, with_code, mode, completed, reason, duration_seconds
        ) VALUES (
          ${item.event_id}, ${item.session_id}, ${payload.participant_code}, ${item.event}, ${occurredAt.toISOString()}, ${Boolean(payload.is_test)},
          ${cleanString(item.module,80)}, ${cleanInteger(item.help_level,0,20)}, ${cleanInteger(item.input_length,0,100000)},
          ${item.with_code === undefined ? null : Boolean(item.with_code)}, ${cleanString(item.mode,24)},
          ${item.completed === undefined ? null : Boolean(item.completed)}, ${cleanString(item.reason,64)}, ${cleanInteger(item.duration_seconds,0,86400)}
        )
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id
      `;
      if (rows.length) saved++;
    }

    return res.status(200).json({ configured: true, received: events.length, saved });
  } catch (error) {
    console.error('Erro ao salvar eventos da pesquisa:', error);
    return res.status(401).json({ error: error.message || 'Não foi possível validar a sessão de pesquisa.' });
  }
}
