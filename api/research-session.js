import { createSessionToken, isDatabaseConfigured, sanitizeParticipantCode, validUuid } from '../lib/research-db.js';

const TEST_PARTICIPANT_CODE = 'TESTE-MATEUS';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  if (!isDatabaseConfigured()) return res.status(503).json({ configured: false, error: 'Armazenamento central ainda não configurado.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const sessionId = String(body.session_id || '');
    const participantCode = sanitizeParticipantCode(body.participant_code);

    if (!validUuid(sessionId)) return res.status(400).json({ error: 'session_id inválido.' });
    if (!participantCode) return res.status(400).json({ error: 'Código do participante inválido.' });

    const isTest = participantCode === TEST_PARTICIPANT_CODE;
    const token = createSessionToken({ sessionId, participantCode, isTest });

    return res.status(200).json({ configured: true, token, is_test: isTest, expires_in_seconds: 86400 });
  } catch (error) {
    console.error('Erro ao criar sessão de pesquisa:', error);
    return res.status(500).json({ error: 'Não foi possível iniciar a sincronização da pesquisa.' });
  }
}
