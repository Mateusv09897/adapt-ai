// 1. Extrator Universal: Vasculha qualquer payload JSON em busca do texto da pergunta
function extrairTextoUniversal(obj) {
  if (!obj) return null;
  if (typeof obj === 'string' && obj.trim().length > 0) return obj;
  if (typeof obj === 'number') return String(obj);
  
  if (Array.isArray(obj)) {
    for (let i = obj.length - 1; i >= 0; i--) {
      const res = extrairTextoUniversal(obj[i]);
      if (res) return res;
    }
  }
  
  if (typeof obj === 'object') {
    const chavesPrioritarias = ['text', 'content', 'prompt', 'mensagem', 'message', 'question', 'query', 'input', 'parts', 'contents', 'data', 'payload'];
    for (const chave of chavesPrioritarias) {
      if (obj[chave] !== undefined) {
        const res = extrairTextoUniversal(obj[chave]);
        if (res) return res;
      }
    }
    for (const chave in obj) {
      const res = extrairTextoUniversal(obj[chave]);
      if (res && typeof res === 'string' && res.length > 1) return res;
    }
  }
  return null;
}

export default async function handler(req, res) {
  // Apenas aceita requisições POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Chave GEMINI_API_KEY não encontrada na Vercel.' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }

    const prompt = extrairTextoUniversal(body);

    if (!prompt) {
      console.error('Payload sem texto detectável:', JSON.stringify(body, null, 2));
      return res.status(400).json({ error: 'Nenhum texto detectável foi encontrado na requisição.' });
    }

    // 2. Lista de endpoints REST oficiais da cota gratuita para verificação sequencial
    // Testa variações entre /v1/ e /v1beta/ e sufixos de modelo para evitar falha de roteamento
    const endpointsParaTestar = [
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`,
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash-001:generateContent?key=${apiKey}`
    ];

    let textoGerado = '';
    let ultimoErro = '';

    // 3. Loop de Resiliência: Tenta conectar diretamente via fetch nativo
    for (const url of endpointsParaTestar) {
      try {
        const googleResponse = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: String(prompt) }] }]
          })
        });

        const data = await googleResponse.json();

        if (googleResponse.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
          textoGerado = data.candidates[0].content.parts[0].text;
          ultimoErro = '';
          break; // Sucesso: interrompe o loop
        } else {
          ultimoErro = data.error?.message || `Status HTTP ${googleResponse.status}`;
        }
      } catch (e) {
        ultimoErro = e.message;
      }
    }

    // Se todos os endpoints falharem, retorna o erro exato do Google
    if (!textoGerado) {
      throw new Error(`Falha na comunicação REST com o Google Gemini: ${ultimoErro}`);
    }

    // 4. Retorno estruturado para compatibilidade com qualquer front-end
    return res.status(200).json({
      text: textoGerado,
      result: textoGerado,
      resposta: textoGerado,
      conteudo: textoGerado,
      candidates: [
        {
          content: {
            parts: [{ text: textoGerado }],
            role: 'model'
          }
        }
      ],
      choices: [{ message: { content: textoGerado } }]
    });

  } catch (error) {
    console.error('Erro crítico no processamento [api/gemini.js]:', error);
    return res.status(500).json({ error: error.message || 'Erro interno no servidor.' });
  }
}
