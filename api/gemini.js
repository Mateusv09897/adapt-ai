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

    // 3. Captura o texto enviado pelo frontend (suporta diferentes nomes de propriedades)
    const prompt = req.body.prompt || req.body.text || req.body.mensagem || req.body.question;

    if (!prompt) {
      return res.status(400).json({ error: 'Nenhum texto de entrada foi fornecido para a IA.' });
    }

    // 4. Conexão DIRETA e oficial ao endpoint REST do Google Gemini 1.5 Flash (Camada Gratuita)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    
    const googleResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    const data = await googleResponse.json();

    // 5. Tratamento de erros caso a API do Google recuse a requisição
    if (!googleResponse.ok) {
      throw new Error(data.error?.message || 'Falha na comunicação com o servidor do Google Gemini.');
    }

    // 6. Extração precisa da string de texto retornada pelo modelo
    const textoGerado = data.candidates[0].content.parts[0].text;

    // 7. Retorno multivariável para blindar contra incompatibilidades de leitura no seu index.html
    return res.status(200).json({
      text: textoGerado,
      result: textoGerado,
      resposta: textoGerado,
      conteudo: textoGerado
    });

  } catch (error) {
    console.error('Erro crítico no backend [api/gemini.js]:', error);
    return res.status(500).json({ error: error.message || 'Erro interno de processamento no servidor.' });
  }
}
