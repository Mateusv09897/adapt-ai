import { isDatabaseConfigured } from '../lib/research-db.js';

// Endpoint leve de diagnóstico: expõe apenas se a camada central está configurada.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido. Use GET.' });
  return res.status(200).json({ configured: isDatabaseConfigured() });
}
