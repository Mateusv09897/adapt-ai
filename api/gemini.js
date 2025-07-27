// Este ficheiro deve ser guardado numa pasta chamada "api" no seu projeto.
// Ex: seu-projeto/api/gemini.js

export default async function handler(request, response) {
  // Apenas permite requisições do tipo POST, que é como o nosso site envia os dados.
  if (request.method !== 'POST') {
    return response.status(405).json({ message: 'Method not allowed' });
  }

  // Pega a chave da API do Gemini que armazenamos de forma segura na Vercel/Netlify.
  // O nome 'GEMINI_API_KEY' deve ser exatamente este.
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return response.status(500).json({ error: 'API key not configured on the server.' });
  }

  try {
    // Constrói a URL da API do Google Gemini.
    const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    // Envia o corpo da requisição do nosso site diretamente para a API do Gemini.
    const geminiResponse = await fetch(geminiApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request.body), // request.body contém o payload { contents: [...] }
    });

    const data = await geminiResponse.json();

    // Se a resposta do Gemini não for bem-sucedida, retorna o erro.
    if (!geminiResponse.ok) {
      console.error('API Error:', data);
      throw new Error(data.error.message || 'Failed to fetch from Gemini API');
    }

    // Retorna a resposta bem-sucedida do Gemini para o nosso site.
    return response.status(200).json(data);

  } catch (error) {
    console.error('Internal Server Error:', error);
    return response.status(500).json({ error: error.message });
  }
}
