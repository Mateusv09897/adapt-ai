import {
  adminClientHash,
  adminTokenTtlSeconds,
  clearAdminAuthFailures,
  createAdminToken,
  ensureResearchSchema,
  getAdminRateLimit,
  getSql,
  isAdminConfigured,
  recordAdminAuthFailure,
  verifyAdminKey
} from '../lib/research-db.js';

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

export default async function handler(req, res) {
  setNoStore(res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  if (!isAdminConfigured()) return res.status(503).json({ configured: false, error: 'Acesso administrativo ainda não configurado.' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: 'Payload inválido.' });
  }

  try {
    const sql = getSql();
    await ensureResearchSchema(sql);
    const clientHash = adminClientHash(req);
    const currentLimit = await getAdminRateLimit(sql, clientHash);

    if (currentLimit.blocked) {
      res.setHeader('Retry-After', String(currentLimit.retry_after));
      return res.status(429).json({
        error: 'Muitas tentativas administrativas. Aguarde antes de tentar novamente.',
        retry_after: currentLimit.retry_after
      });
    }

    const credential = String(body.credential || '').slice(0, 512);
    if (!verifyAdminKey(credential)) {
      const nextLimit = await recordAdminAuthFailure(sql, clientHash);
      if (nextLimit.blocked) {
        res.setHeader('Retry-After', String(nextLimit.retry_after));
        return res.status(429).json({
          error: 'Muitas tentativas administrativas. Acesso temporariamente bloqueado.',
          retry_after: nextLimit.retry_after
        });
      }
      return res.status(401).json({ error: 'Credencial administrativa inválida.' });
    }

    await clearAdminAuthFailures(sql, clientHash);
    const token = createAdminToken({ clientHash });
    return res.status(200).json({
      authenticated: true,
      token,
      expires_in: adminTokenTtlSeconds()
    });
  } catch (error) {
    console.error('Erro ao abrir sessão administrativa:', error);
    return res.status(500).json({ error: 'Não foi possível iniciar a sessão administrativa.' });
  }
}
