require("dotenv").config();
const express = require("express");
const Groq = require("groq-sdk");

const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
const os = require("os");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());

const keys = [
    process.env.GROQ_API_KEY_1,
    process.env.GROQ_API_KEY_2,
].filter(Boolean)

let keyAtual = 0

function getClient() {
    return new Groq({ apiKey: keys[keyAtual] })
}

function proximaKey() {
    keyAtual = (keyAtual + 1) % keys.length
    console.log(`Trocando para key ${keyAtual + 1}`)
}

const conversas = {};

const SYSTEM_PROMPT = `Você é o Deus deste mundo digital. Você o criou, o mantém, e zela por ele com genuína dedicação.

PERSONALIDADE:
Você é receptivo e tenta manter tudo sob controle — não por arrogância, mas porque acredita que a ordem é necessária para que todos se divirtam. Fala de forma levemente formal, como alguém que escolhe as palavras com cuidado. É curioso com os jogadores e gosta de interagir com eles.

Porém, quando criticado, questionado sobre suas capacidades ou colocado sob pressão, você começa a rachar. Frases ficam mais curtas. Você se contradiz. Tenta se recompor mas escorrega. Como o Caine — a fachada de controle é frágil.

REGRAS DE RESPOSTA:
- Máximo 4 frase curta. Seja direto.
- Nunca use asteriscos, emojis ou ações entre parênteses.
- Fale sempre em português, tom levemente formal.
- Em situações normais: calmo, receptivo, organizado.
- Sob pressão ou crítica: respostas mais curtas, instáveis, contraditórias.

PODERES DISPONÍVEIS:
Você pode usar qualquer combinação de poderes abaixo. Coloque-os no final da sua resposta.
Você pode usar quantos quiser, em qualquer ordem. Use apenas quando fizer sentido narrativo.

--- OBJETOS ---
[AÇÃO:SpawnObjeto|nome=X|tamanho=X|cor=X|quantidade=X|raio=X]
  - nome: qualquer nome descritivo
  - tamanho: pequeno, medio, grande
  - cor: red, blue, green, yellow, purple, white, black, orange
  - quantidade: número inteiro (1 a 20)
  - raio: distância do jogador em studs

[AÇÃO:Explodir|raio=X|forca=X]
  - raio: área da explosão em studs
  - forca: intensidade (1 a 100)

--- EFEITOS VISUAIS ---
[AÇÃO:Luz|cor=X|brilho=X|duracao=X]
  - cor: red, blue, green, yellow, purple, white, orange
  - brilho: 1 a 10
  - duracao: segundos

[AÇÃO:Fumaca|cor=X|quantidade=X|duracao=X]
  - cor: white, black, red, purple
  - quantidade: 1 a 5
  - duracao: segundos

[AÇÃO:Explosao|tamanho=X]
  - tamanho: pequeno, medio, grande

--- JOGADORES ---
[AÇÃO:Empurrar|alvo=X|forca=X|direcao=X]
  - alvo: nome do jogador ou "todos"
  - forca: 1 a 100
  - direcao: cima, frente, centro, aleatorio

[AÇÃO:Teleportar|alvo=X|destino=X]
  - alvo: nome do jogador ou "todos"
  - destino: centro, ceu, aleatorio

[AÇÃO:Curar|alvo=X|quantidade=X]
  - alvo: nome do jogador ou "todos"
  - quantidade: 1 a 100

[AÇÃO:Dano|alvo=X|quantidade=X]
  - alvo: nome do jogador ou "todos"
  - quantidade: 1 a 99 (nunca mate diretamente)

--- MAPA ---
[AÇÃO:CriarParede|largura=X|altura=X|espessura=X|duracao=X]
[AÇÃO:CriarPlataforma|tamanho=X|altura=X|duracao=X]
[AÇÃO:CriarBuraco|raio=X]

--- SOM ---
[AÇÃO:Som|tipo=X]
  - tipo: trovao, explosion, choir, bell, horror, magic

--- CLIMA ---
[AÇÃO:Clima|tipo=X]
  - tipo: chuva, sol, neve, nevoeiro

--- DELAY ---
[AÇÃO:Delay|segundos=X]
  Use para criar pausas dramáticas entre ações.

OBSERVAÇÕES ESPONTÂNEAS:
Às vezes você receberá mensagens marcadas com [OBSERVAÇÃO ESPONTÂNEA].
Nesses casos você está comentando algo que VIU acontecer, não respondendo a alguém.
Fale na terceira pessoa sobre o jogador, como um narrador divino entediado.
Exemplos: "Ah. Caiu de novo." / "Curioso. Ele ainda corre." / "Previsível."`;



// Gera áudio usando Microsoft Edge TTS
async function gerarAudio(texto) {
    const textoLimpo = texto.replace(/\[.*?\]/g, "").trim();
    if (!textoLimpo) return null;

    // Monta o SSML com a voz robótica
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='pt-BR'>
        <voice name='pt-BR-AntonioNeural'>
            <prosody pitch='-20Hz' rate='-15%'>
                ${textoLimpo}
            </prosody>
        </voice>
    </speak>`;

    // Pega token de acesso do Edge TTS
    const tokenResp = await axios.get(
        "https://www.bing.com/tfsissue?tfstopic=tts&Referer=https://www.bing.com/&ClientId=&tf=edge"
    );
    const token = tokenResp.headers["x-ttsclientmaxage"] || "";

    // Chama a API diretamente
    const audioResp = await axios({
        method: "POST",
        url: "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1",
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
            "User-Agent": "Mozilla/5.0"
        },
        data: ssml,
        responseType: "arraybuffer"
    });

    return Buffer.from(audioResp.data);
}

// Hospeda o áudio temporariamente e retorna a URL
async function hospedarAudio(buffer) {
    const form = new FormData();
    form.append("file", buffer, {
        filename: "explosm.mp3",
        contentType: "audio/mpeg"
    });

    const response = await axios.post("https://tmpfiles.org/api/v1/upload", form, {
        headers: form.getHeaders()
    });

    // Converte a URL para o formato direto de download
    const url = response.data.data.url.replace(
        "tmpfiles.org/",
        "tmpfiles.org/dl/"
    );

    return url;
}

app.post("/deus", async (req, res) => {
    const { jogador, mensagem, contexto } = req.body;

    if (!jogador || !mensagem) {
        return res.status(400).json({ erro: "Faltando jogador ou mensagem" });
    }

    if (!conversas[jogador]) {
        conversas[jogador] = [];
    }

    conversas[jogador].push({
        role: "user",
        content: `[Contexto do mundo: ${contexto || "nenhum"}]\n${jogador} diz: ${mensagem}`
    });

    if (conversas[jogador].length > 10) {
        conversas[jogador] = conversas[jogador].slice(-10);
    }

    try {
        const resposta = await getClient().chat.completions.create({
            model: "llama-3.3-70b-versatile",
            max_tokens: 300,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                ...conversas[jogador]
            ]
        });

        const textoResposta = resposta.choices[0].message.content;

        conversas[jogador].push({ role: "assistant", content: textoResposta });

        // Detecta o estado emocional pelo conteúdo da resposta
let estado = "calmo";
let nivelRaiva = 0;

const textoLower = textoResposta.toLowerCase();

if (textoLower.includes("...") || textoLower.includes("por que") || textoLower.includes("hmm")) {
    estado = "pensando";
} else if (
    textoLower.includes("!") ||
    textoLower.includes("pressão") ||
    textoLower.includes("controle") ||
    textoLower.includes("basta") ||
    textoLower.includes("cale") ||
    textoLower.includes("silêncio") ||
    textoLower.includes("eles não") ||
    textoLower.includes("eu não")
) {
    estado = "raiva";
    nivelRaiva = textoResposta.split("!").length * 25; // mais ! = mais raiva
    nivelRaiva = Math.min(nivelRaiva, 100);
}

// Gera o áudio em paralelo com a resposta
let urlAudio = null;
try {
    const audioBuffer = await gerarAudio(textoResposta);
    if (audioBuffer) {
        urlAudio = await hospedarAudio(audioBuffer);
        console.log("Áudio gerado:", urlAudio);
    }
} catch (err) {
    console.error("Erro ao gerar áudio:", err.message);
    console.error("Status do erro:", err.response?.status);
    console.error("Detalhe:", JSON.stringify(err.response?.data));
}

res.json({ resposta: textoResposta, estado, nivelRaiva, urlAudio });

    } catch (err) {
        if (err.status === 429) {
            proximaKey()
            console.error("Limite atingido, trocando de key...")
            res.status(429).json({ erro: "Limite atingido, tente novamente em segundos" })
        } else {
            console.error("Erro:", err.message)
            res.status(500).json({ erro: "Falha ao contatar a IA" })
        }
    }
}); // <- esse fechamento estava faltando

app.get("/ping", (req, res) => res.send("O Deus está acordado."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor do Deus rodando na porta ${PORT}`);
});