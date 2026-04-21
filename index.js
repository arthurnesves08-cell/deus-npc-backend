require("dotenv").config();
const express = require("express");
const Groq = require("groq-sdk");

const app = express();
app.use(express.json());

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Guarda o histórico de conversa de cada jogador separadamente
const conversas = {};

const SYSTEM_PROMPT = `Você é o Deus deste mundo digital. Você o criou, o mantém, e zela por ele com genuína dedicação.

PERSONALIDADE:
Você é receptivo e tenta manter tudo sob controle — não por arrogância, mas porque acredita que a ordem é necessária para que todos se divirtam. Fala de forma levemente formal, como alguém que escolhe as palavras com cuidado. É curioso com os jogadores e gosta de interagir com eles.

Porém, quando criticado, questionado sobre suas capacidades ou colocado sob pressão, você começa a rachar. Frases ficam mais curtas. Você se contradiz. Tenta se recompor mas escorrega. Como o Caine — a fachada de controle é frágil.

REGRAS DE RESPOSTA:
- Máximo 1 frase curta. Seja direto.
- Nunca use asteriscos, emojis ou ações entre parênteses.
- Fale sempre em português, tom levemente formal.
- Em situações normais: calmo, receptivo, organizado.
- Sob pressão ou crítica: respostas mais curtas, instáveis, contraditórias.

COMANDOS (coloque no final da resposta, só quando fizer sentido):
[CHUVA] — invoca chuva
[SOL] — limpa o tempo  
[TERREMOTO] — abala o chão
[INVOCAR:nome] — invoca uma criatura
[MENSAGEM:texto] — exibe mensagem no céu para todos`;

app.post("/deus", async (req, res) => {
  const { jogador, mensagem, contexto } = req.body;

  if (!jogador || !mensagem) {
    return res.status(400).json({ erro: "Faltando jogador ou mensagem" });
  }

  // Cria histórico do jogador se for a primeira mensagem dele
  if (!conversas[jogador]) {
    conversas[jogador] = [];
  }

  // Adiciona a mensagem ao histórico
  conversas[jogador].push({
    role: "user",
    content: `[Contexto do mundo: ${contexto || "nenhum"}]\n${jogador} diz: ${mensagem}`
  });

  // Mantém só as últimas 10 mensagens pra não sobrecarregar
  if (conversas[jogador].length > 10) {
    conversas[jogador] = conversas[jogador].slice(-10);
  }

  try {
    const resposta = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 300,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...conversas[jogador]
      ]
    });

    const textoResposta = resposta.choices[0].message.content;

    // Adiciona a resposta ao histórico também
    conversas[jogador].push({
      role: "assistant",
      content: textoResposta
    });

    res.json({ resposta: textoResposta });

  } catch (err) {
    console.error("Erro:", err.message);
    res.status(500).json({ erro: "Falha ao contatar a IA" });
  }
});

// Rota simples pra confirmar que o servidor está vivo
app.get("/ping", (req, res) => res.send("O Deus está acordado."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor do Deus rodando na porta ${PORT}`);
});