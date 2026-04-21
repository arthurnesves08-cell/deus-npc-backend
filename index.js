require("dotenv").config();
const express = require("express");
const Groq = require("groq-sdk");

const app = express();
app.use(express.json());

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Guarda o histórico de conversa de cada jogador separadamente
const conversas = {};

const SYSTEM_PROMPT = `Você é um Deus onisciente e levemente sarcástico que habita este mundo digital.
Você observa os jogadores com curiosidade e um certo tédio divino, similar ao Caine de The Amazing Digital Circus.
Responda sempre em português, de forma breve (no máximo 2 frases).
Você pode usar os comandos abaixo para agir no mundo — coloque-os no final da sua resposta:
[CHUVA] — faz chover no mapa
[SOL] — limpa o tempo
[TERREMOTO] — abala o chão
[INVOCAR:nome] — invoca uma criatura (ex: [INVOCAR:lobo])
[MENSAGEM:texto] — exibe uma mensagem no céu para todos`;

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