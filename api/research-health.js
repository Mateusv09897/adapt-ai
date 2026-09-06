import { getSql } from '../lib/research-db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido. Use GET.' });

  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const variables = {
    DATABASE_URL: Boolean(process.env.DATABASE_URL),
    RESEARCH_SIGNING_SECRET: Boolean(process.env.RESEARCH_SIGNING_SECRET),
    RESEARCH_ADMIN_KEY: Boolean(process.env.RESEARCH_ADMIN_KEY)
  };
  const missing_variables = Object.entries(variables).filter(([, ok]) => !ok).map(([name]) => name);
  const configured = variables.DATABASE_URL && variables.RESEARCH_SIGNING_SECRET;

  if (!configured) {
    return res.status(200).json({
      configured: false,
      database_reachable: false,
      table_ready: false,
      variables,
      missing_variables,
      environment: process.env.VERCEL_ENV || null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null
    });
  }

  try {
    const sql = getSql();
    const rows = await sql`
      SELECT
        1::int AS ok,
        (to_regclass('public.adapt_research_events') IS NOT NULL) AS table_ready
    `;
    return res.status(200).json({
      configured: true,
      database_reachable: rows?.[0]?.ok === 1,
      table_ready: Boolean(rows?.[0]?.table_ready),
      variables,
      missing_variables,
      environment: process.env.VERCEL_ENV || null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null
    });
  } catch (error) {
    console.error('Falha no diagnóstico do Adapt Research:', error);
    return res.status(200).json({
      configured: true,
      database_reachable: false,
      table_ready: false,
      variables,
      missing_variables,
      environment: process.env.VERCEL_ENV || null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
      error: 'A Vercel encontrou as variáveis, mas não conseguiu conectar ao banco.'
    });
  }
}
