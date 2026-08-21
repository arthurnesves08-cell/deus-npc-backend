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
