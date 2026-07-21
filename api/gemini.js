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
      return res.status(500).json({ error: 'Chave GEMINI_API_KEY não encontrada nas variáveis de ambiente da Vercel.' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }

    const prompt = extrairTextoUniversal(body);

    if (!prompt) {
      console.error('Payload recebido sem texto detectável:', JSON.stringify(body, null, 2));
      return res.status(400).json({ error: 'Nenhum texto detectável foi encontrado na requisição.' });
    }

    // --- PASSO A: AUTO-DESCOBERTA DE MODELO VIA API OFICIAL (ListModels) ---
    const listModelsUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const listResponse = await fetch(listModelsUrl);
    
    if (!listResponse.ok) {
      const erroAuth = await listResponse.text();
      throw new Error(`Falha ao validar chave API no Google (HTTP ${listResponse.status}): ${erroAuth}`);
    }

    const listaDados = await listResponse.json();
    const modelosDisponiveis = listaDados.models || [];

    // Filtra apenas modelos que suportam geração de texto (generateContent)
    const modelosGeradores = modelosDisponiveis.filter(m => 
      m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent')
    );

    if (modelosGeradores.length === 0) {
      throw new Error('A chave API fornecida é válida, mas não possui nenhum modelo de geração de texto habilitado no Google AI Studio.');
    }

    // Prioriza modelos da linha "flash" (mais rápidos e gratuitos). Se não achar, pega o primeiro gerador válido.
    const modeloEscolhido = modelosGeradores.find(m => m.name.toLowerCase().includes('flash')) || modelosGeradores[0];
    
    // A propriedade .name já retorna no formato oficial exigido: ex: "models/gemini-1.5-flash"
    const nomeModeloOficial = modeloEscolhido.name;
    console.log(`[Auto-Descoberta] Modelo selecionado para execução: ${nomeModeloOficial}`);

    // --- PASSO B: GERAÇÃO DE CONTEÚDO NO ENDPOINT DESCOBERTO ---
    const generateUrl = `https://generativelanguage.googleapis.com/v1beta/${nomeModeloOficial}:generateContent?key=${apiKey}`;
    
    const googleResponse = await fetch(generateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: String(prompt) }] }]
      })
    });

    const data = await googleResponse.json();

    if (!googleResponse.ok) {
      throw new Error(data.error?.message || `Erro HTTP ${googleResponse.status} na geração de conteúdo.`);
    }

    const textoGerado = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!textoGerado) {
      throw new Error('O modelo do Google processou a requisição, mas retornou uma resposta vazia.');
    }

    // Retorno multivariável para compatibilidade perfeita com qualquer front-end
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
