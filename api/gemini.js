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

    // 3. Tratamento de segurança: se o Vercel receber o corpo como string, faz o parse para JSON
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }

    // 4. EXTRAÇÃO INTELIGENTE DO TEXTO (Suporta formatos simples e padrão OpenRouter/OpenAI)
    let prompt = body.prompt || body.text || body.mensagem || body.question || body.input;

    // Se não achou nas chaves simples, busca na estrutura de 'messages' (padrão OpenRouter)
    if (!prompt && Array.isArray(body.messages) && body.messages.length > 0) {
      // Pega o conteúdo da última mensagem enviada pelo usuário
      const mensagensUsuario = body.messages.filter(m => m.role === 'user' || !m.role);
      const ultimaMensagem = mensagensUsuario[mensagensUsuario.length - 1] || body.messages[body.messages.length - 1];
      prompt = ultimaMensagem.content || ultimaMensagem.text || typeof ultimaMensagem === 'string' ? ultimaMensagem : JSON.stringify(ultimaMensagem);
    }

    // Se ainda assim estiver vazio, retorna o erro 400 mostrando o que recebeu para facilitar o debug
    if (!prompt) {
      console.error('Payload recebido sem formato reconhecido:', body);
      return res.status(400).json({ 
        error: 'Nenhum texto foi encontrado na requisição.', 
        recebido: body 
      });
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

    // 8. Retorno com múltiplas chaves para garantir leitura perfeita no seu index.html
    return res.status(200).json({
      text: textoGerado,
      result: textoGerado,
      resposta: textoGerado,
      conteudo: textoGerado,
      choices: [{ message: { content: textoGerado } }] // Compatibilidade com leitores estilo OpenRouter
    });

  } catch (error) {
    console.error('Erro no processamento [api/gemini.js]:', error);
    return res.status(500).json({ error: error.message || 'Erro interno no servidor.' });
  }
}
