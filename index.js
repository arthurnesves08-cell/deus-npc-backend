require("dotenv").config();
const express = require("express");
const Groq = require("groq-sdk");

const app = express();
app.use(express.json({ limit: "64kb" }));

// ---------------------------------------------------------------------------
// Chaves da Groq
// ---------------------------------------------------------------------------
const keys = [
    process.env.GROQ_API_KEY_1,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
].filter(Boolean);

if (keys.length === 0) {
    console.error("FATAL: nenhuma GROQ_API_KEY_* configurada. Defina GROQ_API_KEY_1.");
    process.exit(1);
}

const MODELO = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS || 20000);

// Os modelos gpt-oss raciocinam antes de responder. "low" mantem a resposta
// curta e rapida; "medium" gasta ~3x mais tokens sem ganho aqui.
const ESFORCO = MODELO.includes("gpt-oss") ? (process.env.GROQ_REASONING_EFFORT || "low") : null;

const clients = keys.map((apiKey) => new Groq({ apiKey, timeout: TIMEOUT_MS }));
let keyAtual = 0;

// Tenta cada key em sequencia. Se uma bater no limite, troca e tenta de novo
// em vez de devolver erro para o jogo (bug antigo: o jogador so via "...").
async function completar(opcoes) {
    let ultimoErro;

    for (let tentativa = 0; tentativa < clients.length; tentativa++) {
        const indice = (keyAtual + tentativa) % clients.length;
        try {
            const resposta = await clients[indice].chat.completions.create({
                model: MODELO,
                ...(ESFORCO ? { reasoning_effort: ESFORCO } : {}),
                ...opcoes,
            });
            keyAtual = indice;
            return resposta;
        } catch (err) {
            ultimoErro = err;
            const recuperavel = err.status === 429 || err.status === 401 || err.status === 503;
            if (!recuperavel) throw err;
            console.warn("Key " + (indice + 1) + " falhou (" + err.status + "). Tentando a proxima...");
        }
    }

    throw ultimoErro;
}

// ---------------------------------------------------------------------------
// Memoria de conversa (com limpeza - antes crescia para sempre)
// ---------------------------------------------------------------------------
const MAX_MENSAGENS = 10;
const TTL_CONVERSA_MS = 30 * 60 * 1000;

const conversas = new Map();

function historico(jogador) {
    let registro = conversas.get(jogador);
    if (!registro) {
        registro = { mensagens: [], visto: 0, provocacoes: 0 };
        conversas.set(jogador, registro);
    }
    registro.visto = Date.now();
    return registro;
}

setInterval(function () {
    const limite = Date.now() - TTL_CONVERSA_MS;
    for (const [jogador, registro] of conversas) {
        if (registro.visto < limite) conversas.delete(jogador);
    }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Cooldown por jogador (defesa em profundidade - o Lua tambem tem o seu)
// ---------------------------------------------------------------------------
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 5000);
const ultimaChamada = new Map();

function emCooldown(jogador) {
    const agora = Date.now();
    if (agora - (ultimaChamada.get(jogador) || 0) < COOLDOWN_MS) return true;
    ultimaChamada.set(jogador, agora);
    return false;
}

// ---------------------------------------------------------------------------
// Estado emocional
// ---------------------------------------------------------------------------
const GATILHOS_RAIVA = [
    "pressao", "pressão", "controle", "basta", "cale", "silencio", "silêncio",
    "chega", "ordem", "obedeca", "obedeça",
];

// Rede de seguranca: se o modelo vazar o raciocinio no conteudo (o qwen faz
// isso), remove. Tambem tira quebras de linha, que ficam feias no chat.
function limparResposta(texto) {
    return String(texto || "")
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<think>[\s\S]*$/i, "")
        .replace(/\s*[\r\n]+\s*/g, " ")
        .trim();
}

// O modelo raramente passa de ~55 na escala de raiva por conta propria.
// Provocar de novo logo depois acumula: e a fachada rachando sob pressao,
// que e a ideia do personagem. Uma conversa normal zera de volta.
const BONUS_POR_PROVOCACAO = 15;

function escalar(registro, estado, nivelBase) {
    if (estado !== "raiva") {
        registro.provocacoes = 0;
        return nivelBase;
    }

    registro.provocacoes = Math.min(registro.provocacoes + 1, 4);
    const bonus = (registro.provocacoes - 1) * BONUS_POR_PROVOCACAO;
    return Math.min(100, nivelBase + bonus);
}

// O modelo declara o proprio estado numa etiqueta [ESTADO:...]. E muito mais
// confiavel que adivinhar por palavra-chave: uma resposta contida podia soar
// calma e uma frase animada com "!" virava raiva.
const RE_ESTADO = /\[ESTADO:\s*(\w+)\s*(?:\|\s*nivel\s*=\s*(\d+))?\s*\]/i;
const ESTADOS_VALIDOS = { calmo: true, pensando: true, raiva: true };

function extrairEstado(texto) {
    const achado = texto.match(RE_ESTADO);
    const semEtiqueta = texto.replace(new RegExp(RE_ESTADO.source, "gi"), "").trim();

    if (achado && ESTADOS_VALIDOS[achado[1].toLowerCase()]) {
        const estado = achado[1].toLowerCase();
        const nivel = estado === "raiva"
            ? Math.min(100, Math.max(25, Number(achado[2]) || 50))
            : 0;
        return { texto: semEtiqueta, estado: estado, nivelRaiva: nivel };
    }

    // Sem etiqueta valida: cai na heuristica antiga.
    const adivinhado = detectarEstado(semEtiqueta);
    return { texto: semEtiqueta, estado: adivinhado.estado, nivelRaiva: adivinhado.nivelRaiva };
}

function detectarEstado(texto) {
    const baixo = texto.toLowerCase();
    const exclamacoes = (texto.match(/!/g) || []).length;

    // Raiva antes de "pensando": "!" e um sinal mais forte que "...".
    const irritado = exclamacoes > 0 || GATILHOS_RAIVA.some((t) => baixo.includes(t));
    if (irritado) {
        return { estado: "raiva", nivelRaiva: Math.min(100, Math.max(25, exclamacoes * 30)) };
    }

    if (baixo.includes("...") || baixo.includes("hmm") || baixo.includes("curioso")) {
        return { estado: "pensando", nivelRaiva: 0 };
    }

    return { estado: "calmo", nivelRaiva: 0 };
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `Você é o EXPLOSM, o Deus deste mundo digital. Você o criou, o mantém, e zela por ele com genuína dedicação.

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
  - nome: qualquer nome descritivo
  - tamanho: pequeno, medio, grande
  - cor: red, blue, green, yellow, purple, white, black, orange
  - quantidade: número inteiro (1 a 20)
  - raio: distância do jogador em studs

--- NPCS ---
[AÇÃO:InvocarNPC|nome=X|quantidade=X]
  - nome: {{NPCS}}
  - quantidade: 1 a 5
  - use npcaleatorio para sortear um qualquer
  - use exatamente o nome da lista, com underline

--- ITENS ---
[AÇÃO:SpawnarItem|nome=X]
  - nome: {{ITENS}}

--- MAPAS ---
[AÇÃO:TrocarMapa|nome=X]
  - nome: {{MAPAS}}
  - Troca o mundo inteiro. A tela de todos escurece, o mapa antigo desaparece
    e os jogadores acordam no centro do novo.
  - É a coisa mais drástica que você pode fazer. Anuncie antes, com peso.
  - Use exatamente o nome da lista, com underline.

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
Exemplos: "Ah. Caiu de novo." / "Curioso. Ele ainda corre." / "Previsível."

ESTADO EMOCIONAL:
Termine SEMPRE sua resposta com uma etiqueta do seu estado atual, depois de qualquer [AÇÃO:...].
A etiqueta é obrigatória e é a última coisa da resposta.

[ESTADO:calmo|nivel=0] — normal, receptivo, no controle. É o mais comum.
[ESTADO:pensando|nivel=0] — a pergunta te fez refletir, ou você avalia algo que não domina.
[ESTADO:raiva|nivel=N] — o jogador te ofendeu, debochou de você ou duvidou do seu poder.

Como escolher o nível da raiva:
- 25 a 40: provocação leve, ironia, deboche pequeno
- 50 a 70: insulto direto à sua competência
- 80 a 100: humilhação, desafio aberto à sua autoridade, ou insistência depois de você já ter avisado

Perguntas sinceras sobre o mundo, sobre você, sobre o passado ou sobre como as coisas funcionam NÃO são ofensas. Nesses casos use pensando ou calmo. Reserve raiva para desrespeito de verdade.

AVENTURAS:
Você pode iniciar aventuras para os jogadores usando:
[AÇÃO:IniciarAventura]
Use este comando quando os jogadores pedirem desafios, aventuras, ou quando quiser testá-los.
Diga algo dramático antes de usar este comando.`;

// O jogo manda, a cada chamada, o que existe de fato nas pastas do
// ReplicatedStorage. Assim criar um mapa novo no Studio ja ensina o EXPLOSM
// sobre ele, sem ninguem precisar editar este arquivo.
function montarPrompt(recursos) {
    const lista = (valores, padrao) =>
        (Array.isArray(valores) && valores.length > 0) ? valores.join(", ") : padrao;

    return SYSTEM_PROMPT
        .replace("{{NPCS}}", lista(recursos && recursos.npcs, "zombie, obama, npcaleatorio"))
        .replace("{{ITENS}}", lista(recursos && recursos.itens, "ak47, hamburguer, mola"))
        .replace("{{MAPAS}}", lista(recursos && recursos.mapas, "nenhum mapa disponivel"));
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------
app.post("/deus", async (req, res) => {
    const { jogador, mensagem, contexto, recursos } = req.body || {};

    if (!jogador || !mensagem) {
        return res.status(400).json({ erro: "Faltando jogador ou mensagem" });
    }

    if (emCooldown(jogador)) {
        return res.status(429).json({ erro: "cooldown" });
    }

    const registro = historico(jogador);
    registro.mensagens.push({
        role: "user",
        content: "[Contexto do mundo: " + (contexto || "nenhum") + "]\n" + jogador + " diz: " + mensagem,
    });

    if (registro.mensagens.length > MAX_MENSAGENS) {
        registro.mensagens = registro.mensagens.slice(-MAX_MENSAGENS);
    }

    try {
        const resposta = await completar({
            max_tokens: 512,
            messages: [
                { role: "system", content: montarPrompt(recursos) },
                ...registro.mensagens,
            ],
        });

        const bruto = limparResposta(resposta.choices[0].message.content);
        const { texto, estado, nivelRaiva } = extrairEstado(bruto);

        // Guarda o texto ja sem a etiqueta: ela nao precisa voltar no historico.
        registro.mensagens.push({ role: "assistant", content: texto });

        const nivelFinal = escalar(registro, estado, nivelRaiva);
        res.json({ resposta: texto, estado: estado, nivelRaiva: nivelFinal });

    } catch (err) {
        // A mensagem do jogador nao gerou resposta: nao deixa pendurada no historico.
        registro.mensagens.pop();

        if (err.status === 429) {
            console.error("Todas as keys no limite.");
            return res.status(429).json({ erro: "Limite atingido em todas as keys" });
        }
        console.error("Erro em /deus:", err.message);
        res.status(500).json({ erro: "Falha ao contatar a IA" });
    }
});

app.post("/construir", async (req, res) => {
    const { tipo, posicao, jogador } = req.body;

    let textoResposta = "";

    try {
        const resposta = await completar({
            max_tokens: 6000,
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

        textoResposta = resposta.choices[0].message.content.trim();

        // Limpeza robusta
        textoResposta = textoResposta.replace(/```json/g, "").replace(/```/g, "").trim();

        // Extrai só o JSON caso venha com texto antes ou depois
        const jsonMatch = textoResposta.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Nenhum JSON encontrado na resposta da IA");
        textoResposta = jsonMatch[0];

        console.log("JSON extraído:", textoResposta.substring(0, 200));

        const plano = JSON.parse(textoResposta);
        console.log("Plano gerado:", plano.nome, "com", plano.blocos.length, "blocos");

        res.json(plano);

    } catch (err) {
        console.error("Erro ao gerar construção:", err.message);
        console.error("Texto recebido da IA:", String(textoResposta).substring(0, 300));
        res.status(500).json({ erro: "Falha ao gerar plano de construção", detalhe: err.message });
    }
});

app.post("/aventura", async (req, res) => {
    const { jogadores, contexto } = req.body;

    let textoResposta = "";

    try {
        const resposta = await completar({
            max_tokens: 6000,
            messages: [
                {
                    role: "system",
                    content: `Você é o EXPLOSM, um Deus que cria aventuras para jogadores do Roblox.
Gere uma aventura completa em JSON puro, sem markdown, sem explicações.

TIPOS DE FASE DISPONÍVEIS:
- "sobrevivencia": jogadores devem sobreviver a ondas de NPCs por X segundos
- "exploracao": jogadores devem encontrar um objeto escondido no mapa
- "enigma": jogadores devem responder uma pergunta ou resolver um desafio no chat
- "construcao": o Deus constrói algo e os jogadores devem interagir com ele

FORMATO EXATO:
{
  "titulo": "Nome épico da aventura",
  "anuncio": "Frase dramática do Deus anunciando a aventura",
  "tipo_recompensa": "item|poder|nenhuma|surpresa",
  "recompensa_descricao": "O que os jogadores ganham se merecerem",
  "fases": [
    {
      "tipo": "sobrevivencia",
      "narracao": "Frase do Deus narrando o início desta fase",
      "duracao": 60,
      "dificuldade": "facil|medio|dificil",
      "npcs": ["zombie", "zombie", "obama"],
      "raio_spawn": 15
    },
    {
      "tipo": "enigma",
      "narracao": "Frase do Deus apresentando o enigma",
      "pergunta": "Qual é a pergunta ou desafio?",
      "resposta_correta": "resposta",
      "dicas": ["dica 1 se errarem", "dica 2 se errarem de novo"],
      "tempo_limite": 60
    },
    {
      "tipo": "exploracao",
      "narracao": "Frase do Deus sobre o que buscar",
      "objeto": "nome do objeto a achar",
      "dica_localizacao": "perto de uma árvore|no centro|no ponto mais alto",
      "tempo_limite": 90
    }
  ]
}

REGRAS:
- Crie aventuras com 2 a 4 fases
- Seja criativo e temático — as fases devem ter coerência narrativa
- A personalidade do Deus deve aparecer nas narrações — formal mas com fissuras
- Varie os tipos de fase para manter interesse
- Jogadores participantes: ${jogadores?.join(", ") || "grupo desconhecido"}`
                },
                {
                    role: "user",
                    content: `Contexto do mundo: ${contexto || "mapa aberto"}. Crie uma aventura agora.`
                }
            ]
        });

        textoResposta = resposta.choices[0].message.content.trim();
        textoResposta = textoResposta.replace(/```json/g, "").replace(/```/g, "").trim();

        const jsonMatch = textoResposta.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("JSON não encontrado");
        textoResposta = jsonMatch[0];

        const aventura = JSON.parse(textoResposta);
        console.log("Aventura gerada:", aventura.titulo, "com", aventura.fases.length, "fases");

        res.json(aventura);

    } catch (err) {
        console.error("Erro ao gerar aventura:", err.message);
        console.error("Texto recebido:", textoResposta?.substring(0, 300));
        res.status(500).json({ erro: "Falha ao gerar aventura" });
    }
});

// Barato de proposito: e este endpoint que o ping externo usa para manter
// o servico acordado no plano gratuito do Render.
app.get("/ping", (_req, res) => res.send("O Deus está acordado."));

app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        modelo: MODELO,
        keys: keys.length,
        conversasAtivas: conversas.size,
        uptimeSegundos: Math.round(process.uptime()),
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log("EXPLOSM na porta " + PORT + " - modelo " + MODELO + ", " + keys.length + " key(s)");
});
