import { isDatabaseConfigured } from '../lib/research-db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido. Use GET.' });
  return res.status(200).json({ configured: isDatabaseConfigured() });
}
