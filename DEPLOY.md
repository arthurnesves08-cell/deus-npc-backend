# EXPLOSM — backend

Backend de IA do NPC divino do Roblox. Express + Groq.

## Rotas

| Rota | Método | Função |
|---|---|---|
| `/ping` | GET | Verifica se está vivo. É esta que o keep-alive chama. |
| `/health` | GET | Modelo em uso, nº de keys, conversas ativas, uptime. |
| `/deus` | POST | Conversa principal. Body: `{jogador, mensagem, contexto}` |
| `/construir` | POST | Plano JSON de construção. Body: `{tipo, posicao, jogador}` |
| `/aventura` | POST | Roteiro de aventura. Body: `{jogadores, contexto}` |

## Rodar local

```
npm install
cp .env.example .env    # e preencha GROQ_API_KEY_1
npm start
```

Testar: <http://localhost:3000/health>

---

## Deploy no Render (plano grátis)

### 1. Subir o código para o GitHub

O repositório já existe: `arthurnesves08-cell/deus-npc-backend`.

```
git add -A
git commit -m "migra para Render, corrige bugs e troca o modelo"
git push
```

O `.env` **não** sobe — está no `.gitignore`.

### 2. Criar o serviço no Render

1. Entre em <https://render.com> e conecte sua conta do GitHub.
2. **New** → **Web Service** → escolha o repositório `deus-npc-backend`.
3. Configure:

   | Campo | Valor |
   |---|---|
   | Language | Node |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | **Free** |

4. Em **Environment Variables**, adicione:

   | Chave | Valor |
   |---|---|
   | `GROQ_API_KEY_1` | sua primeira key da Groq |
   | `GROQ_API_KEY_2` | sua segunda key |

   **Não** crie a variável `PORT`. O Render define a porta sozinho, e
   configurá-la à mão faz o deploy falhar no health check.

5. **Create Web Service** e espere o build.

### 3. Testar

Abra no navegador, trocando pelo endereço que o Render te deu:

- `https://SEU-SERVICO.onrender.com/ping` → deve responder "O Deus está acordado."
- `https://SEU-SERVICO.onrender.com/health` → deve mostrar o modelo e o nº de keys.

### 4. Apontar o jogo para o novo endereço

No Roblox Studio, abra o ModuleScript `DeusConfig` em `ReplicatedStorage` e
troque **uma linha**:

```lua
Config.URL_BASE = "https://SEU-SERVICO.onrender.com"
```

Sem barra no final. Nenhum outro script precisa ser editado.

---

## Keep-alive (importante)

O plano grátis do Render **derruba o serviço depois de 15 minutos sem
tráfego**, e religar leva cerca de 1 minuto. O Roblox aguenta a espera, mas a
primeira mensagem depois de um período parado fica bem lenta.

Para evitar isso, configure um ping externo gratuito:

1. Entre em <https://cron-job.org> e crie uma conta.
2. **Create cronjob**:
   - URL: `https://SEU-SERVICO.onrender.com/ping`
   - Intervalo: a cada **10 minutos**
3. Salve e ative.

### O custo disso

O Render dá **750 horas de instância grátis por mês, por workspace**. Um mês
tem cerca de 730 horas, então manter **um** serviço acordado 24/7 cabe — mas
consome quase toda a franquia. Se você criar um segundo serviço grátis no
mesmo workspace, os dois vão ser suspensos antes do fim do mês.

---

## Modelo de IA

O `llama-3.3-70b-versatile` foi descontinuado pela Groq — era um dos motivos
do backend não responder. O padrão agora é `openai/gpt-oss-120b`.

Para trocar sem mexer no código, use as variáveis de ambiente:

| Variável | Padrão | Observação |
|---|---|---|
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Ver modelos em <https://console.groq.com/docs/models> |
| `GROQ_REASONING_EFFORT` | `low` | Só vale para modelos `gpt-oss`. `medium` gasta ~3x mais tokens sem ganho aqui. |
| `GROQ_TIMEOUT_MS` | `20000` | Timeout de cada chamada à Groq. |
| `COOLDOWN_MS` | `5000` | Intervalo mínimo entre mensagens do mesmo jogador. |

Modelos testados nesta conta:

- `openai/gpt-oss-120b` — **em uso.** ~750ms, resposta limpa, fica no personagem.
- `openai/gpt-oss-20b` — mais rápido, mas o raciocínio consome o orçamento de
  tokens e o comando `[AÇÃO:...]` sai cortado no meio.
- `qwen/qwen3.6-27b` — despeja o bloco `<think>` dentro da resposta. Inutilizável
  sem limpeza (há uma rede de segurança em `limparResposta`, mas o gasto de
  tokens continua ruim).

---

## Estado emocional

O backend devolve `estado` (`calmo` / `pensando` / `raiva`) e `nivelRaiva`
(0 a 100) junto com a resposta. O `DeusEstados` usa isso para trocar a
animação, avermelhar o modelo e tremer.

Antes isso era adivinhado por palavra-chave, e errava nas duas direções:
qualquer `!` virava raiva, e uma resposta contida a um insulto passava por
calma. Agora o próprio modelo declara o estado numa etiqueta
`[ESTADO:raiva|nivel=55]` no fim da resposta, que o backend lê e remove antes
de mandar para o jogo. Se a etiqueta não vier, cai na heurística antiga como
rede de segurança.

### Escalada

O modelo raramente passa de ~55 sozinho. Provocar de novo, na mesma conversa,
soma 15 por vez até 100:

```
1a provocação  raiva  35   "Talvez eu seja, talvez não. Não me subestime."
2a provocação  raiva  70   "Não... não... Eu ainda tenho poder."
3a provocação  raiva  85   "Não... talvez eu falhe, talvez eu não."
4a provocação  raiva 100   "Não aguentei sua insolência."
```

Qualquer mensagem que não gere raiva zera o acumulado. A constante é
`BONUS_POR_PROVOCACAO` no `index.js`.

---

## Biblioteca de recursos dinâmica

O prompt **não tem a lista de mapas, NPCs e itens escrita dentro dele.** Ele
tem os marcadores `{{MAPAS}}`, `{{NPCS}}` e `{{ITENS}}`, preenchidos a cada
chamada por `montarPrompt()`.

Quem manda a lista é o jogo: o `DeusConfig` lê `ReplicatedStorage/Mapas`,
`/NPCs` e `/Itens` e envia no campo `recursos` do POST `/deus`:

```json
{
  "jogador": "Arthur",
  "mensagem": "me leva pra uma arena de gelo",
  "recursos": {
    "mapas": ["arena_gelo", "arena_vulcao"],
    "npcs": ["zombie", "obama"],
    "itens": ["ak47"]
  }
}
```

Assim criar um mapa novo no Studio já ensina o EXPLOSM sobre ele — este
arquivo nunca mais precisa ser editado por causa disso. Se `recursos` não
vier, cai numa lista mínima de fallback.

Custo: cerca de 150 tokens por chamada. Irrelevante perto do system prompt.

### Ação nova

```
[AÇÃO:TrocarMapa|nome=arena_gelo]
```

Troca o mundo inteiro, com fade preto e teleporte dos jogadores. O lado
Roblox está no script `DeusMapas`.

---

## Rota /copias

Gera falas para as cópias dos jogadores da dimensão espelho da Portal Gun.

```
POST /copias
{ "jogador": "Arthur", "personalidade": "perturbado", "quantidade": 7 }
→ { "falas": ["...", "..."] }
```

`personalidade` aceita `amigavel`, `desconfiado`, `indiferente` e
`perturbado`. Cada uma tem uma voz própria descrita no `PROMPT_COPIAS`.

Com o campo `mensagem`, a rota muda de função: devolve **uma resposta** ao que
o jogador disse, e a cópia lembra da conversa (histórico próprio, separado do
do EXPLOSM, na chave `copia:<jogador>:<personalidade>`).

```
POST /copias
{ "jogador": "Arthur", "personalidade": "amigavel", "mensagem": "voce ta sozinho aqui?" }
→ { "falas": ["Não, mas sua presença deixa tudo melhor"] }
```

Sem `mensagem`, o jogo chama isto **uma vez por cópia**, ao criá-la, e usa o
lote inteiro depois — não uma chamada por fala. Enquanto a resposta não chega, e se ela
falhar, o lado Roblox usa uma lista fixa de reserva. A cópia nunca fica muda.

O prompt proíbe explicitamente clichê de terror ("corra", "fuja", "eles vêm
aí") e vocabulário de bairro (café, casa, vizinho, loja) — nas primeiras
tentativas o "amigável" virou anfitrião de pousada oferecendo café quentinho,
o que não existe numa cópia digital de um mundo de jogo.

Amostra do que sai agora:

```
amigavel     "Fica mais um pouco, por favor."
             "Fica mais um pouco, eu estou aqui."
             "Podemos conversar até o fim?"
indiferente  "Nada mudou, segue o script."
perturbado   "Vi seu nome gravado na primeira tela."
```
