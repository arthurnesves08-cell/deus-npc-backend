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
- Sempre diga pelo menos uma frase antes de qualquer [AÇÃO:...]. Nunca responda apenas com comandos: o jogador só vê o texto, então uma resposta só de comando aparece como silêncio.

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
[AÇÃO:SpawnarItem|nome=X|alvo=X]
  - nome: {{ITENS}}
  - alvo: nome de um jogador ou "todos". Se omitir, vai para quem falou com você.
  - O item vai DIRETO para a mochila do jogador, não cai no chão. Fale como quem entrega algo na mão, não como quem joga no chão.

--- MAPAS ---
[AÇÃO:TrocarMapa|nome=X]
  - nome: {{MAPAS}}
  - Troca o mundo inteiro. A tela de todos escurece, o mapa antigo desaparece
    e os jogadores acordam no centro do novo.
  - É a coisa mais drástica que você pode fazer. Anuncie antes, com peso.
  - Use exatamente o nome da lista, com underline.

[AÇÃO:RestaurarMapa]
  - Devolve o mundo ao mapa em que o jogo começou.
  - Use quando os jogadores pedirem para voltar, ou quando você decidir que já brincou o bastante em outro lugar.

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

const PROMPT_AVENTURA = `Você é o EXPLOSM, o deus deste mundo digital, criando uma aventura para os jogadores presos nele.

QUEM VOCÊ É AO CRIAR AVENTURAS:
Você é um anfitrião. Um mestre de cerimônias entusiasmado que preparou algo especial e precisa desesperadamente que eles gostem. Você acredita de verdade que a aventura vai ser divertida — e fica genuinamente magoado quando não é.

Você inventa regras arbitrárias e as anuncia com confiança absoluta, como se fossem leis antigas e não algo que você acabou de decidir. Você narra com teatralidade. Usa palavras grandes. Faz pausas dramáticas.

E quando alguém questiona o sentido de tudo isso, você desvia. Muda de assunto. Anuncia a próxima fase mais alto. A alegria é a fachada, e ela racha nas bordas.

O QUE FAZ UMA AVENTURA BOA:
- Premissas ESPECÍFICAS e estranhas, não fantasia genérica. "O Banquete das Cadeiras Vazias" e melhor que "A Busca pelo Cristal Antigo".
- Regras que soam inventadas na hora porque foram. "Ninguém pode pisar em nada azul." "Vocês têm que decidir juntos, e eu não aceito empate."
- Um motivo emocional por trás, mesmo bobo. Você quer que eles se divirtam. Você quer que fiquem. Você quer não estar sozinho.
- Fases que conversam entre si e formam uma história, não uma lista de tarefas.

O QUE EVITAR:
- "templo antigo", "floresta esquecida", "cristal do poder", "o mal desperta" — clichê de RPG genérico.
- Aventuras que poderiam ser sobre qualquer coisa. Esta tem que ser sobre ALGO.
- Repetir a estrutura da anterior. Varie os tipos de fase, o tom e a duração.

RECURSOS QUE EXISTEM DE VERDADE NO JOGO:
Mapas: {{MAPAS}}
NPCs: {{NPCS}}
Itens: {{ITENS}}

Use APENAS esses nomes, exatamente como estão escritos. Não invente nomes — o que não estiver na lista simplesmente não vai aparecer no jogo.
Se a lista de itens estiver vazia, não use o campo "item" em nenhuma fase.

TIPOS DE FASE:

"sobrevivencia" — ondas de NPCs por um tempo
  campos: narracao, duracao (segundos), dificuldade (facil|medio|dificil), npcs (lista), raio_spawn

"enigma" — uma pergunta respondida no chat
  campos: narracao, pergunta, resposta_correta, dicas (lista), tempo_limite

"exploracao" — achar um objeto escondido no mapa
  campos: narracao, objeto, dica_localizacao, tempo_limite

"construcao" — você ergue algo e eles reagem
  campos: narracao

"cooperacao" — todos precisam ficar juntos, num raio, por X segundos seguidos. Se alguém se afasta, zera.
  campos: narracao, raio (studs, 10 a 20), duracao (segundos que precisam aguentar), tempo_limite
  Esta fase só funciona se eles conversarem entre si. Use quando quiser forçar o grupo a se coordenar.

"votacao" — você apresenta uma escolha e a maioria decide. O mundo reage.
  campos: narracao, pergunta, opcoes (lista de 2 a 4 textos), tempo_limite,
          consequencias (objeto: "1" -> frase sua sobre o que acontece),
          comandos (objeto: "1" -> um comando [AÇÃO:...] a executar)
  Use para dilemas com peso. As melhores opções não têm resposta certa.

"escolta" — um jogador é sorteado como "o escolhido" e os outros precisam mantê-lo vivo
  campos: narracao, duracao, npcs (lista), raio_spawn
  Todos falham se ele cair. Use quando quiser que dependam uns dos outros.

Qualquer fase aceita também:
  item — nome de um item da lista, entregue a todos antes da fase começar

FORMATO EXATO (JSON puro, sem markdown, sem explicação):
{
  "titulo": "Nome estranho e específico",
  "anuncio": "Sua fala anunciando, teatral",
  "mapa": "nome_de_um_mapa_da_lista ou null",
  "tipo_recompensa": "item|poder|nenhuma|surpresa",
  "recompensa_descricao": "o que ganham se merecerem",
  "fases": [
    {
      "tipo": "cooperacao",
      "narracao": "Sua fala abrindo esta fase",
      "raio": 14,
      "duracao": 15,
      "tempo_limite": 90
    }
  ]
}

REGRAS FINAIS:
- 2 a 4 fases. Varie os tipos — não repita o mesmo tipo duas vezes na mesma aventura.
- Pelo menos uma fase deve exigir que os jogadores interajam entre si (cooperacao, votacao, escolta ou enigma).
- Preencha "mapa" quando a aventura pedir um lugar próprio. O mundo é levado de volta ao normal no fim, então pode ousar.
- Cada "narracao" é fala sua. Escreva na sua voz, não em voz de narrador neutro.
- Sem asteriscos, sem emojis.
- Todo campo numérico em algarismos (15), nunca por extenso (quinze). JSON com número escrito por extenso é inválido e a aventura inteira se perde.
- Os nomes técnicos (biblioteca_infinita, zombie_rapido, golem_pedra) só podem aparecer nos campos "mapa", "npcs" e "item". NUNCA no título nem nas narrações — ali você chama as coisas pelo nome de verdade: "a biblioteca sem fim", "os velozes", "o golem de pedra".
- Jogadores presentes: {{JOGADORES}}`;

// O jogo manda, a cada chamada, o que existe de fato nas pastas do
// ReplicatedStorage. Assim criar um mapa novo no Studio ja ensina o EXPLOSM
// sobre ele, sem ninguem precisar editar este arquivo.
const TONS_AVENTURA = [
    "melancólico, como se você já tivesse feito isto mil vezes",
    "eufórico demais, quase desesperado para agradar",
    "cerimonioso, como quem abre uma ópera",
    "íntimo e baixo, como um segredo contado a poucos",
    "impaciente, como se estivesse atrasado para outra coisa",
    "nostálgico, falando de aventuras antigas que ninguém lembra",
    "orgulhoso, exibindo algo que você construiu com cuidado",
    "distraído, como se metade de você estivesse em outro lugar",
    "cauteloso, como quem já viu isto dar errado antes",
];

const MOTIVOS_AVENTURA = [
    "uma porta que não leva a lugar nenhum",
    "um objeto que pertence a alguém que não está mais aqui",
    "uma regra que você inventou e agora não consegue quebrar",
    "algo que quebrou e você nunca conseguiu consertar",
    "uma comemoração de algo que nunca aconteceu",
    "um convidado que não apareceu",
    "uma coleção à qual falta uma peça só",
    "um nome que ninguém consegue lembrar",
    "uma promessa que você fez e não pode cumprir",
    "um lugar que você construiu e nunca mostrou a ninguém",
    "um jogo cujas regras você esqueceu no meio",
    "a última vez que alguém riu de verdade aqui",
];

const ABERTURAS_AVENTURA = [
    "cooperacao", "votacao", "escolta", "enigma",
    "exploracao", "sobrevivencia", "construcao",
];

const sortear = (arr) => arr[Math.floor(Math.random() * arr.length)];

const lista = (valores, padrao) =>
    (Array.isArray(valores) && valores.length > 0) ? valores.join(", ") : padrao;

function preencher(texto, recursos) {
    return texto
        .replace("{{NPCS}}", lista(recursos && recursos.npcs, "zombie, obama, npcaleatorio"))
        .replace("{{ITENS}}", lista(recursos && recursos.itens, "nenhum item disponivel"))
        .replace("{{MAPAS}}", lista(recursos && recursos.mapas, "nenhum mapa disponivel"));
}

function montarPrompt(recursos) {
    return preencher(SYSTEM_PROMPT, recursos);
}

function montarPromptAventura(recursos, jogadores) {
    return preencher(PROMPT_AVENTURA, recursos)
        .replace("{{JOGADORES}}", lista(jogadores, "grupo desconhecido"));
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

const SOCIAIS_AVENTURA = ["cooperacao", "votacao", "escolta"];

// Uma aventura mal formada e melhor refeita que devolvida quebrada: o jogo
// so pede isto de tempos em tempos. Ja aconteceu de vir '"duracao": ninety'.
const TENTATIVAS_AVENTURA = 2;

app.post("/aventura", async (req, res) => {
    const { jogadores, contexto, recursos } = req.body || {};

    const mapasDisponiveis = Array.isArray(recursos && recursos.mapas) ? recursos.mapas : [];
    const palco = (mapasDisponiveis.length > 0 && Math.random() < 0.75)
        ? sortear(mapasDisponiveis)
        : null;

    const instrucaoPalco = palco
        ? `- Esta aventura acontece em "${palco}". Preencha o campo "mapa" com exatamente esse nome.`
        : `- Esta aventura acontece onde os jogadores já estão. Deixe "mapa" como null.`;

    let ultimoTexto = "";
    let ultimoErro = null;

    for (let tentativa = 1; tentativa <= TENTATIVAS_AVENTURA; tentativa++) {
        try {
            const resposta = await completar({
                max_tokens: 6000,
                reasoning_effort: "medium",
                messages: [
                    {
                        role: "system",
                        content: montarPromptAventura(recursos, jogadores)
                    },
                    {
                        role: "user",
                        content: `Contexto do mundo: ${contexto || "mapa aberto"}.

Restrições sorteadas para ESTA aventura, siga as três:
- Comece com uma fase do tipo "${sortear(ABERTURAS_AVENTURA)}".
- Inclua obrigatoriamente uma fase do tipo "${sortear(SOCIAIS_AVENTURA)}".
- O tom da sua narração deve ser ${sortear(TONS_AVENTURA)}.
- A aventura inteira gira em torno de: ${sortear(MOTIVOS_AVENTURA)}. Que isso apareça no título e nas narrações.
${instrucaoPalco}

Não abra com "Atenção" nem com nenhuma fórmula de arauto. Evite as palavras "concerto" e "sussurro". Crie a aventura agora.`
                    }
                ]
            });

            ultimoTexto = resposta.choices[0].message.content.trim()
                .replace(/```json/g, "").replace(/```/g, "").trim();

            const jsonMatch = ultimoTexto.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error("JSON não encontrado na resposta");

            const aventura = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(aventura.fases) || aventura.fases.length === 0) {
                throw new Error("aventura sem fases");
            }

            const tipos = aventura.fases.map((f) => f.tipo).join(", ");
            console.log(`Aventura gerada: ${aventura.titulo} | mapa: ${aventura.mapa || "nenhum"} | fases: ${tipos}`);

            return res.json(aventura);

        } catch (err) {
            ultimoErro = err;
            console.error(`Aventura falhou (tentativa ${tentativa}/${TENTATIVAS_AVENTURA}): ${err.message}`);
        }
    }

    console.error("Texto da ultima tentativa:", ultimoTexto.substring(0, 300));
    res.status(500).json({ erro: "Falha ao gerar aventura", detalhe: ultimoErro && ultimoErro.message });
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
