export default async function handler(req, res) {
  // 1. Garante que apenas requisições POST sejam aceitas
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  try {
    // 2. Busca a chave gratuita configurada no painel da Vercel
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Chave GEMINI_API_KEY não encontrada nas variáveis de ambiente.' });
    }

    // 3. Tratamento de segurança para conversão de corpo da requisição
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }

    let prompt = null;

    // 4. EXTRAÇÃO EXATA DO FORMATO GOOGLE SDK (Confirmado pelo seu log)
    if (body.contents && Array.isArray(body.contents) && body.contents.length > 0) {
      const ultimaMensagem = body.contents[body.contents.length - 1];
      if (ultimaMensagem.parts && Array.isArray(ultimaMensagem.parts) && ultimaMensagem.parts.length > 0) {
        // Pega o texto de dentro do array 'parts'
        prompt = ultimaMensagem.parts.map(p => p.text || '').join(' ').trim();
      }
    }

    // Fallback de segurança: caso o texto venha em formatos simples (text, prompt, input)
    if (!prompt) {
      prompt = body.prompt || body.text || body.mensagem || body.question || body.input;
    }

    // Se realmente não encontrar texto, interrompe a execução
    if (!prompt) {
      console.error('Falha ao extrair texto do payload:', JSON.stringify(body, null, 2));
      return res.status(400).json({ error: 'Nenhum texto detectável foi encontrado na requisição.' });
    }

    // 5. Conexão DIRETA ao endpoint REST oficial do Google Gemini 1.5 Flash (Camada Gratuita)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    
    const googleResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: String(prompt) }] }]
      })
    });

    const data = await googleResponse.json();

    // 6. Tratamento de erro vindo diretamente dos servidores do Google
    if (!googleResponse.ok) {
      throw new Error(data.error?.message || 'Falha na comunicação com o servidor do Google Gemini.');
    }

    // 7. Extração do texto gerado pela IA
    const textoGerado = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // 8. RETORNO COMPLETO: Garante compatibilidade total na leitura do seu front-end
    return res.status(200).json({
      text: textoGerado,
      result: textoGerado,
      resposta: textoGerado,
      conteudo: textoGerado,
      // Estrutura nativa do Google SDK:
      candidates: [
        {
          content: {
            parts: [{ text: textoGerado }],
            role: "model"
          }
        }
      ]
    });

  } catch (error) {
    console.error('Erro no processamento [api/gemini.js]:', error);
    return res.status(500).json({ error: error.message || 'Erro interno no servidor.' });
  }
}
