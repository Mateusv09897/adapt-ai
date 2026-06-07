// Este ficheiro atua agora como um Adaptador entre o seu site e o OpenRouter.
export default async function handler(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ message: 'Method not allowed' });
  }

  // Atenção: Lembre-se de alterar o nome da variável no painel do seu servidor.
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return response.status(500).json({ error: 'API key not configured on the server.' });
  }

  try {
    const parts = request.body.contents[0].parts;
    let openRouterContent = [];
    let hasImage = false;

    // 1. Converte o formato do Gemini para o formato universal OpenRouter/OpenAI
    for (const part of parts) {
      if (part.text) {
        openRouterContent.push({ type: "text", text: part.text });
      } else if (part.inlineData) {
        hasImage = true;
        openRouterContent.push({
          type: "image_url",
          image_url: {
            // Reconstrói o Base64 para o formato Data URL aceite por visão
            url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
          }
        });
      }
    }

   // 2. Roteamento Inteligente: Usa Nemotron para texto e Gemini Free para imagens
    const targetModel = hasImage 
      ? "google/gemini-2.0-flash-exp:free" // ID atualizado para suportar visão gratuitamente
      : "nvidia/nemotron-3-super-120b-a12b:free";

    const openRouterPayload = {
      model: targetModel,
      messages: [{ role: "user", content: openRouterContent }]
    };

    // 3. Efetua a chamada ao servidor gratuito do OpenRouter
    const openRouterResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://adapt-ai.senac", // Opcional para rankings
        "X-Title": "Adapt AI" // Opcional
      },
      body: JSON.stringify(openRouterPayload)
    });

    const data = await openRouterResponse.json();

    if (!openRouterResponse.ok) {
      console.error('OpenRouter API Error:', data);
      throw new Error(data.error?.message || 'Failed to fetch from OpenRouter API');
    }

    const textoResposta = data.choices[0].message.content;

    // 4. Encapsula o retorno no formato exigido pela função callGemini() do index.html
    const fakeGeminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              { text: textoResposta }
            ]
          }
        }
      ]
    };

    return response.status(200).json(fakeGeminiResponse);

  } catch (error) {
    console.error('Internal Server Error:', error);
    return response.status(500).json({ error: error.message });
  }
}
