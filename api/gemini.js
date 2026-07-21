import { GoogleGenerativeAI } from '@google/generative-ai';

// Função recursiva para extrair o texto de entrada sem falhas (Extrator Universal)
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
      return res.status(500).json({ error: 'Chave GEMINI_API_KEY não encontrada nas variáveis de ambiente.' });
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

    let textoGerado = '';

    // TENTATIVA 1: Via SDK Oficial (Evita erros de URL e de versão REST)
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const result = await model.generateContent(String(prompt));
      const response = await result.response;
      textoGerado = response.text();
    } catch (sdkError) {
      console.warn('Falha via SDK Oficial, ativando fallback REST estável [v1]:', sdkError.message);
      
      // TENTATIVA 2: Fallback via REST na API Estável (v1 em vez de v1beta) com variação de modelos
      const modelosParaTestar = ['gemini-1.5-flash', 'gemini-1.5-flash-latest', 'gemini-1.5-flash-001'];
      let erroRest = null;

      for (const nomeModelo of modelosParaTestar) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1/models/${nomeModelo}:generateContent?key=${apiKey}`;
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
            erroRest = null;
            break; 
          } else {
            erroRest = data.error?.message || `Erro no modelo ${nomeModelo}`;
          }
        } catch (e) {
          erroRest = e.message;
        }
      }

      if (erroRest && !textoGerado) {
        throw new Error(`Falha em todos os endpoints de geração: ${erroRest}`);
      }
    }

    if (!textoGerado) {
      throw new Error('O modelo respondeu com sucesso, mas retornou um texto vazio.');
    }

    // Retorno multivariável e estruturado para total compatibilidade com o frontend
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
