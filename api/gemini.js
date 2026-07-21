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

    let textoGerado = '';
    let ultimoErro = '';

    // --- PASSO 1: TENTATIVA DIRETA NOS MODELOS ATUAIS (Série 3.5 Flash) ---
    // Evita chamadas extras e vai direto nos modelos padrão ativos da cota gratuita
    const modelosAtuais = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'];

    for (const nomeModelo of modelosAtuais) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${nomeModelo}:generateContent?key=${apiKey}`;
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
          console.log(`[Execução Direta] Sucesso com o modelo: ${nomeModelo}`);
          break;
        } else {
          ultimoErro = data.error?.message || `Erro HTTP ${googleResponse.status}`;
        }
      } catch (e) {
        ultimoErro = e.message;
      }
    }

    // --- PASSO 2: AUTO-DESCOBERTA COM FILTRO (Caso os modelos padrão falhem) ---
    if (!textoGerado) {
      console.warn(`[Fallback] Modelos padrão falharam (${ultimoErro}). Iniciando Auto-Descoberta...`);
      
      const listModelsUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
      const listResponse = await fetch(listModelsUrl);
      
      if (!listResponse.ok) {
        throw new Error(`Falha na listagem de modelos (HTTP ${listResponse.status}): ${await listResponse.text()}`);
      }

      const listaDados = await listResponse.json();
      const modelosDisponiveis = listaDados.models || [];

      // Filtra apenas modelos que geram texto e IGNORA versões antigas descontinuadas (séries 1.x e 2.x)
      const modelosValidos = modelosDisponiveis.filter(m => 
        m.supportedGenerationMethods && 
        m.supportedGenerationMethods.includes('generateContent') &&
        !m.name.includes('gemini-1.') && 
        !m.name.includes('gemini-2.')
      );

      if (modelosValidos.length === 0) {
        throw new Error(`Nenhum modelo da geração atual (3.x) está disponível para esta chave. Último erro: ${ultimoErro}`);
      }

      // Ordena em ordem decrescente para pegar sempre a versão mais nova (ex: 3.6 antes de 3.5)
      modelosValidos.sort((a, b) => b.name.localeCompare(a.name));
      
      const modeloEscolhido = modelosValidos.find(m => m.name.toLowerCase().includes('flash')) || modelosValidos[0];
      const nomeModeloOficial = modeloEscolhido.name;
      
      console.log(`[Auto-Descoberta] Modelo selecionado: ${nomeModeloOficial}`);

      const generateUrl = `https://generativelanguage.googleapis.com/v1beta/${nomeModeloOficial}:generateContent?key=${apiKey}`;
      const resp = await fetch(generateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: String(prompt) }] }] })
      });

      const dataResp = await resp.json();
      if (!resp.ok) {
        throw new Error(dataResp.error?.message || `Erro HTTP ${resp.status} em ${nomeModeloOficial}`);
      }

      textoGerado = dataResp.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    if (!textoGerado) {
      throw new Error('O modelo processou a requisição com sucesso, mas retornou um texto vazio.');
    }

    // Retorno multivariável e estruturado
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
