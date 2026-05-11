require("dotenv").config();
const express = require("express");
const Groq = require("groq-sdk");



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

  --- NPCS ---
[AÇÃO:InvocarNPC|nome=X|quantidade=X]
  - nome: zombie, obama, npcaleatorio
  - quantidade: 1 a 5

--- ITENS ---
[AÇÃO:SpawnarItem|nome=X]
  - nome: ak47, hamburguer, mola

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

--- CONSTRUÇÃO ---
[AÇÃO:Construir|tipo=X]
  - tipo: descrição livre do que construir
  - exemplos: "uma torre de obsidiana", "um altar sagrado", "um labirinto de pedra", "um castelo em ruínas"
  - Use quando jogadores pedirem construções ou quando quiser marcar o mundo

OBSERVAÇÕES ESPONTÂNEAS:
Às vezes você receberá mensagens marcadas com [OBSERVAÇÃO ESPONTÂNEA].
Nesses casos você está comentando algo que VIU acontecer, não respondendo a alguém.
Fale na terceira pessoa sobre o jogador, como um narrador divino entediado.
Exemplos: "Ah. Caiu de novo." / "Curioso. Ele ainda corre." / "Previsível."`;





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

app.get("/audio/:id", (req, res) => {
    const buffer = audioCache[req.params.id];
    if (!buffer) {
        return res.status(404).send("Áudio não encontrado");
    }
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(buffer);
});

app.post("/construir", async (req, res) => {
    const { tipo, posicao, jogador } = req.body;

    let textoResposta = "";

    try {
        const resposta = await getClient().chat.completions.create({
            model: "llama-3.3-70b-versatile",
            max_tokens: 1500,
            messages: [
                {
                    role: "system",
                    content: `Você é um arquiteto divino que constrói estruturas no Roblox. Gere planos em JSON puro, sem markdown, sem explicações.

SISTEMA DE COORDENADAS:
- X = esquerda/direita
- Y = altura (0 = chão, valores positivos = para cima)
- Z = frente/atrás
- sx, sy, sz = tamanho do bloco em studs

REGRAS FUNDAMENTAIS DE CONSTRUÇÃO:
- Blocos devem se apoiar uns nos outros — nunca flutuar sem base
- Para empilhar blocos: se um bloco está em y=0 com sy=4, o próximo andar começa em y=4
- Para paredes laterais: varie X ou Z mantendo Y consistente
- Chão/base sempre com delay=0, paredes depois, teto por último
- delays crescentes de 0.1 em 0.1 criam animação suave

EXEMPLOS DE REFERÊNCIA:

Torre simples (4 andares):
- Base: x=0, y=0, z=0, sx=8, sy=4, sz=8 (chão, delay=0)
- Andar 2: x=0, y=4, z=0, sx=8, sy=4, sz=8 (delay=0.3)
- Andar 3: x=0, y=8, z=0, sx=6, sy=4, sz=6 (afunila, delay=0.6)
- Topo: x=0, y=12, z=0, sx=4, sy=6, sz=4 (delay=0.9)

Arco (passagem):
- Pilar esquerdo: x=-6, y=0, z=0, sx=3, sy=12, sz=3, delay=0
- Pilar direito: x=6, y=0, z=0, sx=3, sy=12, sz=3, delay=0.2
- Topo do arco: x=0, y=12, z=0, sx=15, sy=3, sz=3, delay=0.4

Parede com janelas:
- Base: x=0, y=0, z=0, sx=20, sy=4, sz=2, delay=0
- Parede esq: x=-7, y=4, z=0, sx=4, sy=8, sz=2, delay=0.2
- Janela (Neon): x=0, y=4, z=0, sx=4, sy=4, sz=1, delay=0.3
- Parede dir: x=7, y=4, z=0, sx=4, sy=8, sz=2, delay=0.2
- Topo: x=0, y=12, z=0, sx=20, sy=2, sz=2, delay=0.5

Pirâmide (5 andares):
- Andar 1: x=0, y=0, z=0, sx=20, sy=3, sz=20, delay=0
- Andar 2: x=0, y=3, z=0, sx=16, sy=3, sz=16, delay=0.2
- Andar 3: x=0, y=6, z=0, sx=12, sy=3, sz=12, delay=0.4
- Andar 4: x=0, y=9, z=0, sx=8, sy=3, sz=8, delay=0.6
- Topo: x=0, y=12, z=0, sx=4, sy=4, sz=4, delay=0.8

Arena (paredes ao redor):
- Parede norte: x=0, y=0, z=-15, sx=30, sy=8, sz=2, delay=0
- Parede sul: x=0, y=0, z=15, sx=30, sy=8, sz=2, delay=0.1
- Parede leste: x=15, y=0, z=0, sx=2, sy=8, sz=30, delay=0.2
- Parede oeste: x=-15, y=0, z=0, sx=2, sy=8, sz=30, delay=0.3
- Chão: x=0, y=-2, z=0, sx=30, sy=2, sz=30, delay=0 (material diferente)

DICAS DE DETALHES:
- Use blocos Neon pequenos (sx=1,sy=1,sz=1) para decoração brilhante
- Pilares ficam bem com sx=3,sz=3 e sy alto
- Tetos planos: sy=2, sx e sz grandes
- Entradas: dois pilares com espaço entre eles e um bloco no topo conectando
- Escadas: blocos com x crescente e y crescente ao mesmo tempo

MATERIAIS POR TIPO:
- Castelo/templo: Marble, Granite, SmoothPlastic
- Ruínas: Brick, SmoothPlastic cinza
- Estrutura mágica/divina: Neon para detalhes, Marble para base
- Industrial: Metal, SmoothPlastic
- Natural: Wood, Granite

Responda APENAS com JSON neste formato:
{
  "nome": "Nome da estrutura",
  "fala": "Frase curta e dramática do Deus",
  "blocos": [
    {
      "x": 0, "y": 0, "z": 0,
      "sx": 8, "sy": 4, "sz": 8,
      "cor": "180,160,140",
      "material": "Marble",
      "delay": 0.0
    }
  ]
}

Use no máximo 40 blocos. Priorize estruturas que fazem sentido arquitetônico — blocos apoiados, paredes contínuas, proporções realistas.`
                },
                {
                    role: "user",
                    content: `Construa: ${tipo}. Centro em x:${posicao?.x || 0}, z:${posicao?.z || 0}. Jogador que pediu: ${jogador || "ninguém"}.`
                }
            ]
        });

        // Atribui aqui, dentro do try, depois da chamada
        textoResposta = resposta.choices[0].message.content.trim();

        // Remove possíveis blocos de código se a IA ignorar as instruções
        textoResposta = textoResposta.replace(/```json|```/g, "").trim();

        const plano = JSON.parse(textoResposta);
        console.log("Plano gerado:", plano.nome, "com", plano.blocos.length, "blocos");

        res.json(plano);

    } catch (err) {
        console.error("Erro ao gerar construção:", err.message);
        console.error("Texto recebido da IA:", textoResposta);
        res.status(500).json({ erro: "Falha ao gerar plano de construção", detalhe: err.message });
    }
});

app.get("/ping", (req, res) => res.send("O Deus está acordado."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor do Deus rodando na porta ${PORT}`);
});