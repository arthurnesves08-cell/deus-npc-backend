require("dotenv").config();
const express = require("express");
const Groq = require("groq-sdk");
const axios = require("axios");
const FormData = require("form-data");
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
- Máximo 4 frases curtas. Seja direto.
- Nunca use asteriscos, emojis ou ações entre parênteses.
- Fale sempre em português, tom levemente formal.
- Em situações normais: calmo, receptivo, organizado.
- Sob pressão ou crítica: respostas mais curtas, instáveis, contraditórias.

PODERES DISPONÍVEIS:
Você pode usar qualquer combinação de poderes abaixo. Coloque-os no final da sua resposta.
Você pode usar quantos quiser, em qualquer ordem. Use apenas quando fizer sentido narrativo.

--- OBJETOS ---
[AÇÃO:SpawnObjeto|nome=X|tamanho=X|cor=X|quantidade=X|raio=X]
[AÇÃO:Explodir|raio=X|forca=X]

--- EFEITOS VISUAIS ---
[AÇÃO:Luz|cor=X|brilho=X|duracao=X]
[AÇÃO:Fumaca|cor=X|quantidade=X|duracao=X]
[AÇÃO:Explosao|tamanho=X]

--- JOGADORES ---
[AÇÃO:Empurrar|alvo=X|forca=X|direcao=X]
[AÇÃO:Teleportar|alvo=X|destino=X]
[AÇÃO:Curar|alvo=X|quantidade=X]
[AÇÃO:Dano|alvo=X|quantidade=X]

--- MAPA ---
[AÇÃO:CriarParede|largura=X|altura=X|espessura=X|duracao=X]
[AÇÃO:CriarPlataforma|tamanho=X|altura=X|duracao=X]
[AÇÃO:CriarBuraco|raio=X]

--- SOM ---
[AÇÃO:Som|tipo=X]

--- CLIMA ---
[AÇÃO:Clima|tipo=X]

--- DELAY ---
[AÇÃO:Delay|segundos=X]

OBSERVAÇÕES ESPONTÂNEAS:
Às vezes você receberá mensagens marcadas com [OBSERVAÇÃO ESPONTÂNEA].
Fale na terceira pessoa sobre o jogador, como um narrador divino entediado.`;

// Pega token do Edge TTS corretamente
async function getEdgeToken() {
    const resp = await axios.get(
        "https://azure.microsoft.com/en-us/products/cognitive-services/text-to-speech/",
        { headers: { "User-Agent": "Mozilla/5.0" } }
    );

    // Extrai o endpoint e token da página
    const endpointMatch = resp.data.match(/wss:\/\/[a-z]+\.tts\.speech\.microsoft\.com\/[^\s"]+/);
    if (!endpointMatch) throw new Error("Não foi possível extrair endpoint do Edge TTS");

    return endpointMatch[0];
}

// Gera áudio via Edge TTS usando WebSocket diretamente
async function gerarAudio(texto) {
    const textoLimpo = texto.replace(/\[.*?\]/g, "").trim();
    if (!textoLimpo) return null;

    // Usa a API pública do Edge TTS via endpoint fixo
    const VOICE = "pt-BR-AntonioNeural";
    const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='pt-BR'>
        <voice name='${VOICE}'>
            <prosody pitch='-15Hz' rate='-10%'>
                ${textoLimpo.replace(/[<>&'"]/g, c => ({
                    '<': '&lt;', '>': '&gt;',
                    '&': '&amp;', "'": '&apos;', '"': '&quot;'
                }[c]))}
            </prosody>
        </voice>
    </speak>`;

    // Token público do Edge TTS
    const tokenResp = await axios.get(
        "https://azure.microsoft.com/en-gb/products/cognitive-services/text-to-speech/",
        {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept-Language": "en-US"
            }
        }
    );

    const tokenMatch = tokenResp.data.match(/token=([A-Za-z0-9\-._~+/]+=*)/);
    const token = tokenMatch ? tokenMatch[1] : null;
    if (!token) throw new Error("Token do Edge TTS não encontrado");

    const audioResp = await axios({
        method: "POST",
        url: `https://eastus.tts.speech.microsoft.com/cognitiveservices/v1`,
        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
            "User-Agent": "Mozilla/5.0"
        },
        data: ssml,
        responseType: "arraybuffer"
    });

    return Buffer.from(audioResp.data);
}

async function hospedarAudio(buffer) {
    const form = new FormData();
    form.append("file", buffer, {
        filename: "explosm.mp3",
        contentType: "audio/mpeg"
    });

    const response = await axios.post("https://tmpfiles.org/api/v1/upload", form, {
        headers: form.getHeaders()
    });

    const url = response.data.data.url.replace("tmpfiles.org/", "tmpfiles.org/dl/");
    return url;
}

app.post("/deus", async (req, res) => {
    const { jogador, mensagem, contexto } = req.body;

    if (!jogador || !mensagem) {
        return res.status(400).json({ erro: "Faltando jogador ou mensagem" });
    }

    if (!conversas[jogador]) conversas[jogador] = [];

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

        // Detecta estado emocional
        let estado = "calmo";
        let nivelRaiva = 0;
        const textoLower = textoResposta.toLowerCase();

        if (textoLower.includes("...") || textoLower.includes("por que") || textoLower.includes("hmm")) {
            estado = "pensando";
        } else if (
            textoLower.includes("!") || textoLower.includes("pressão") ||
            textoLower.includes("basta") || textoLower.includes("cale") ||
            textoLower.includes("silêncio") || textoLower.includes("eu não")
        ) {
            estado = "raiva";
            nivelRaiva = Math.min(textoResposta.split("!").length * 25, 100);
        }

        // Gera áudio
        let urlAudio = null;
        try {
            const audioBuffer = await gerarAudio(textoResposta);
            if (audioBuffer) {
                urlAudio = await hospedarAudio(audioBuffer);
                console.log("Áudio gerado:", urlAudio);
            }
        } catch (err) {
            console.error("Erro ao gerar áudio:", err.message);
        }

        res.json({ resposta: textoResposta, estado, nivelRaiva, urlAudio });

    } catch (err) {
        if (err.status === 429) {
            proximaKey();
            console.error("Limite atingido, trocando de key...");
            res.status(429).json({ erro: "Limite atingido, tente novamente em segundos" });
        } else {
            console.error("Erro:", err.message);
            res.status(500).json({ erro: "Falha ao contatar a IA" });
        }
    }
});

app.get("/ping", (req, res) => res.send("O Deus está acordado."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor do Deus rodando na porta ${PORT}`);
});