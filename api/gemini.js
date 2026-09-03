const PEDAGOGICAL_GUARDRAIL = `Você é o motor do Adapt, uma ferramenta de mediação pedagógica para estudantes da Educação Profissional e Tecnológica. Sua finalidade é ajudar o estudante a superar uma barreira de compreensão sem executar a atividade por ele. Nunca entregue respostas finais de exercícios, provas ou trabalhos; nunca escreva um trabalho pronto para entrega; nunca substitua o raciocínio do estudante. Prefira linguagem acessível, pistas graduais, exemplos análogos, decomposição de dificuldades e perguntas orientadoras. A resposta deve ser curta e adequada a um totem compartilhado em sala de aula. Quando possível, finalize devolvendo o estudante à própria atividade.`;

function extractContents(body) {
  if (!body || typeof body !== 'object') return null;
  if (Array.isArray(body.contents) && body.contents.length) return body.contents;
  return null;
}

function extractText(obj) {
  if (!obj) return null;
  if (typeof obj === 'string' && obj.trim()) return obj;
  if (Array.isArray(obj)) {
    for (let i = obj.length - 1; i >= 0; i--) {
      const found = extractText(obj[i]);
      if (found) return found;
    }
  }
  if (typeof obj === 'object') {
    const priority = ['text','content','prompt','mensagem','message','question','query','input','parts','contents','data','payload'];
    for (const key of priority) {
      if (obj[key] !== undefined) {
        const found = extractText(obj[key]);
        if (found) return found;
      }
    }
    for (const key of Object.keys(obj)) {
      const found = extractText(obj[key]);
      if (found) return found;
    }
  }
  return null;
}

function withGuardrail(contents) {
  const normalized = JSON.parse(JSON.stringify(contents));
  const firstUser = normalized.find(item => item.role === 'user') || normalized[0];
  if (!firstUser.parts) firstUser.parts = [];
  firstUser.parts.unshift({ text: PEDAGOGICAL_GUARDRAIL });
  return normalized;
}

async function generate(apiKey, modelName, contents) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Erro HTTP ${response.status}`);
  const text = data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\n').trim();
  if (!text) throw new Error('O modelo não retornou texto.');
  return text;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido. Use POST.' });

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY não configurada.' });

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = { text: body }; }
    }

    let contents = extractContents(body);
    if (!contents) {
      const text = extractText(body);
      if (!text) return res.status(400).json({ error: 'Nenhum conteúdo detectável foi encontrado.' });
      contents = [{ role: 'user', parts: [{ text }] }];
    }

    contents = withGuardrail(contents);

    const preferredModels = ['gemini-3.5-flash','gemini-3.5-flash-lite','gemini-3.6-flash'];
    let generatedText = '';
    let lastError = null;

    for (const model of preferredModels) {
      try {
        generatedText = await generate(apiKey, model, contents);
        if (generatedText) break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!generatedText) {
      const listResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (!listResponse.ok) throw lastError || new Error('Não foi possível localizar um modelo disponível.');
      const listData = await listResponse.json();
      const available = (listData.models || [])
        .filter(model => model.supportedGenerationMethods?.includes('generateContent'))
        .filter(model => !model.name.includes('gemini-1.') && !model.name.includes('gemini-2.'))
        .sort((a,b) => b.name.localeCompare(a.name));
      const selected = available.find(model => model.name.toLowerCase().includes('flash')) || available[0];
      if (!selected) throw lastError || new Error('Nenhum modelo compatível está disponível.');
      generatedText = await generate(apiKey, selected.name.replace('models/',''), contents);
    }

    return res.status(200).json({
      text: generatedText,
      result: generatedText,
      candidates: [{ content: { parts: [{ text: generatedText }], role: 'model' } }]
    });
  } catch (error) {
    console.error('Erro no Adapt API:', error);
    return res.status(500).json({ error: error.message || 'Erro interno no servidor.' });
  }
}