import { ensureResearchSchema, getSql, isDatabaseConfigured, mapDbEvent, sanitizeParticipantCode, validUuid, verifyAdminKey } from '../lib/research-db.js';

function adminKey(req) {
  return req.headers['x-research-admin-key'] || '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  if (!isDatabaseConfigured()) return res.status(503).json({ configured: false, error: 'Armazenamento central ainda não configurado.' });
  if (!verifyAdminKey(adminKey(req))) return res.status(401).json({ error: 'Credencial administrativa inválida.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const action = String(body.action || '');
    const sql = getSql();
    await ensureResearchSchema(sql);

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
    console.error('Erro administrativo da pesquisa:', error);
    return res.status(500).json({ error: 'Falha ao acessar o armazenamento central.' });
  }
}
