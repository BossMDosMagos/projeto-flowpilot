# FLOWPILOT — Memória / Documentação do Projeto

Aplicativo web PWA de **navegação GPS em tempo real** no estilo Waze, construído com
**MapLibre GL JS** + tiles da **CartoDB** (Dark Matter / Positron) + roteamento público **OSRM**.
Interface em português (pt-BR), pensada para celular.

---

## 1. Visão geral

| Item | Valor |
|------|-------|
| Tipo | PWA (HTML/CSS/JS puro, sem build) |
| Mapa | MapLibre GL JS **v5.3.0** (CDN unpkg, UMD single-file) |
| Tiles | CartoDB basemaps (gratuitos, sem chave de API) |
| Roteamento | OSRM público: `https://router.project-osrm.org` |
| Busca de endereços | Nominatim OSM |
| Voz | Web Speech API (`speechSynthesis`) com `pt-BR` |
| Persistência | `localStorage` (tema + destinos recentes) |

Arquivos:
- `index.html` — estrutura da página
- `styles.css` — tema claro/noturno + UI (velocímetro, card de instrução, botões flutuantes)
- `app.js` — toda a lógica (mapa, GPS, rota, navegação, voz, tema)
- `manifest.json` — manifest do PWA
- `sw.js` — Service Worker (cache offline + abertura rápida)
- `capacitor.config.json` + `native/` — módulo nativo (Android/Capacitor, ver seção 16)

---

## 2. Endpoints e dependências externas

- MapLibre CSS: `https://unpkg.com/maplibre-gl@5.3.0/dist/maplibre-gl.css`
- MapLibre JS: `https://unpkg.com/maplibre-gl@5.3.0/dist/maplibre-gl.js`
- Estilo escuro (Dark Matter): `https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json`
- Estilo claro (Positron): `https://basemaps.cartocdn.com/gl/positron-gl-style/style.json`
- Busca: `https://nominatim.openstreetmap.org/search?format=json&q=...&countrycodes=br`
- Rota: `https://router.project-osrm.org/route/v1/driving/lon,lat;lon,lat?overview=full&geometries=geojson&steps=true`

> Observação: o `attributionControl` foi **desativado** de propósito (UI limpa, estilo Waze).
> Isso remove o crédito obrigatório de CartoDB/OSM — compliance a tratar.

---

## 3. Estrutura do `app.js`

Organizado em 16 blocos comentados:

1. **Estado global + constantes** — variáveis do mapa, rota, navegação e estilos.
2. **Inicialização do mapa** — `initMap()`, controles, tema salvo, seguimento.
3. **GPS em tempo real** — `startGPSTracking()` / `atualizarPosicaoVeiculo()` / `acompanharVeiculo()`.
4. **Busca de destino** — Nominatim com debounce (400ms) e lista de sugestões.
5. **Roteamento OSRM** — `tracarRota()` → `desenharRota()` (halo + linha principal).
6. **Utilitários** — ETA, cor do velocímetro, `showFeedback`.
7. **Navegação passo a passo + voz** — instruções OSRM, ícone de manobra, voz.
8. **Geometria/utilitários adicionais** — haversine, formatação de distância.
9. **Destinos recentes** — persistência em `localStorage`.
10. **Simulador de rota** — seção 6 (concluído, com acelerador 1x–8x).
11. **Screen Wake Lock** — seção 11: mantém a tela acesa enquanto `rotaAtiva`.
12. **Tráfego TomTom** — seção 12: overlay raster de fluxo + botão 🚦.
13. **Recálculo anti-engarrafamento** — seção 13: monitor econômico + alerta de nova rota.
14. **Hodômetro + manutenção** — seção 14: KM cumulativo + status do óleo + modal.
15. **Central de configurações** — seção 15: veículo/perfil OSRM, custo, alertas de velocidade/voz, AMOLED, wake lock toggle e backup JSON.
16. **Corrida (trabalho de app) + ponte nativa** — seção 16: máquina de estados de 2 estágios, captura de endereço, proximidade 30 m, mini-HUD, `window.FlowPilot`/`AndroidBridge` (ver seção 16 abaixo).

---

## 4. Fluxo principal (navegação)

```
usuário digita destino
  → buscarEndereco() (Nominatim) → lista de sugestões
  → usuário clica → destinoSelecionado
  → tracarRota() (OSRM) → route.geometry.coordinates
      → desenharRota()  (define currentRouteCoords)
      → currentSteps = leg.steps
      → exibirInstrucao(0) + falarVoz(...)
      → ativarRota() (perspectiva 3D, esconde busca)
  → GPS watchPosition
      → atualizarPosicaoVeiculo(lat, lon, kmh, heading)
          → move marker, velocímetro, atualizarInstrucao, acompanharVeiculo, zoom
          → atualizarInstrucao() detecta proximidade (<30 m do próximo passo)
              → exibirInstrucao(i) + falarVoz + seta de manobra
```

### Modo rota ativa
- `body.rota-ativa`: esconde a barra de busca e mostra o card de instrução no topo.
- `acompanharVeiculo()`: inclina a câmera (`pitch=50°`) e gira (`bearing=heading`).
- Zoom automático 17/18 quando em movimento (>5 km/h).

### Telemetria em tempo real (painel inferior)
- `atualizarTelemetria(pos)` recalcula a cada atualização de posição (GPS **ou**
  simulador) a **distância restante** ao longo da polilinha, a **duração estimada**
  restante (proporcional a `route.duration` × fração restante) e a **hora de chegada**
  (`Date.now() + duração restante` → `HH:MM`, em verde no card).
- Geometria: `distRestanteRota()` projeta a posição no segmento mais próximo
  (`projetarPontoNoSegmento()`, projeção equiretangular local) e soma os segmentos
  seguintes.
- Layout do card: **ETA** e **DIST* na mesma linha; **Chegada** (hora estimada) numa
  linha própria abaixo, com divisor.

---

## 5. Ícone de manobra dinâmico (setas SVG)

Função principal: `atualizarIconeManeuver(step)`.

- Chegada → `maneuver-arrive` (ícone de bandeira/chegada).
- Partida/início (`depart`), `straight`, `new name` → `maneuver-straight`.
- Rotatória (`roundabout`/`rotary`) → `maneuver-roundabout`.
- Inversão (`uturn`/retorno) → `maneuver-uturn`.
- Senão, a **direção** é detectada primeiro pelo **texto** gerado da instrução
  (procura por "esquerda"/"direita"), depois pelo `modifier` do passo, senão reto.
- A **intensidade** (slight/sharp) vem do texto ("levemente"/"bruscamente") ou do `modifier`.

A base da seta SVG aponta para a **direita**; a rotação é feita via CSS:

| Classe | Rotação |
|--------|---------|
| `.maneuver-straight` | 270° (cima) |
| `.maneuver-right` | 0° |
| `.maneuver-left` | 180° |
| `.maneuver-slight-right` | 315° |
| `.maneuver-slight-left` | 225° |
| `.maneuver-sharp-right` | 45° |
| `.maneuver-sharp-left` | 135° |

### Bandeira de chegada
No fim da rota é plantada uma **bandeira quadriculada preto/branco** (SVG com padrão
`#checker-finish`) via `createDestinoMarker()` — ancorada no último ponto de
`currentRouteCoords`, com leve animação de balanço. Criada em `desenharRota()`, removida
em `novaRota()`/`removerDestinoMarker()`. Persiste no mapa após a chegada (não é removida
pelo fim da navegação).

### Sub-título do card (`descricaoProximaAcao`)
Gera frase clara sobre a próxima manobra, ex.:
- "Vire à direita em 200 m"
- "Siga em frente por 500 m"
- "Chegue ao destino em 300 m"
- "Continue em Avenida Brasil por 1,2 km"

Usado no card via `exibirInstrucao()` (próximo passo) e em `atualizarInstrucao()`
(distância até o próximo passo em tempo real).

---

## 6. Simulador de rota — CONCLUÍDO

- **`index.html`**: botão flutuante `#simul-btn` (play/stop) — linhas 63–71.
- **`app.js`**: seção 10 implementa `iniciarSimulacao()`, `pararSimulacao()`,
  `avancarSimulacao()`, `calcBearing()`, `pontoNaRota()` e o listener de `btnSimul`
  (toggle play/stop). Constantes: `VEL_SIM = 10` km/h e tick de `200 ms`.
- **`styles.css`**: bloco `#simul-btn` (posição `bottom: 270px`; estado `.ativo` troca
  play→stop e pinta o fundo de verde) e `#simul-speed-btn` (acelerador, chip com
  multiplicador na mesma linha do botão).

**Comportamento:** ao clicar em play com uma rota traçada, o simulador interpola a posição
ao longo de `currentRouteCoords`, calcula o heading com `calcBearing()` e dispara o mesmo
fluxo de navegação via `atualizarPosicaoVeiculo()` (velocímetro, instruções, voz, follow 3D).
O GPS real é pausado (`clearWatch`) durante a simulação e retomado no stop; ao chegar ao fim,
velocidade zera e mostra "Simulação concluída!".

**Acelerador:** o chip `#simul-speed-btn` alterna o multiplicador `simulFator` em
`[1, 2, 4, 8]x` (labels `1x/2x/4x/8x`). A velocidade efetiva simulada é `VEL_SIM * simulFator`
(10, 20, 40 ou 80 km/h), usada tanto no deslocamento por tick quanto no velocímetro.

Ver também o arquivo Git: as alterações atuais estão **em working directory (não commitadas)**.
O último commit efetivo é provavelmente `ab91754` (ver `git log`).

---

## 7. Tema claro/escuro

- `aplicarTema(escuro)`: troca o estilo com `map.setStyle()` e recria camadas/marcador em `recriarCamadas()`.
- Tema salvo em `localStorage['flowpilot:tema']` (`'escuro'` / `'claro'`).
- `carregarTemaInicial()` aplica o tema salvo no boot.
- CSS: `body.noturno` define as variáveis do tema escuro; `#theme-btn` alterna sol/lua.

---

## 8. Persistência (localStorage)

- `flowpilot:tema` — tema claro/escuro.
- `flowpilot:recentes` — últimos 8 destinos (para republicar na busca).
- `flowpilot:corrida` — estado da corrida ativa (estado, coleta, destino); ver seção 16.

---

## 9. Ponto de atenção / pendências

1. ~~Simulador de rota incompleto (ver seção 6)~~ — **concluído**.
2. Atribuição da CartoDB/OSM desativada (`attributionControl:false`) — sem conformidade.
3. GPS real exige **HTTPS** ou `localhost`; simulador resolve testes sem dirigir.
4. Wake Lock (seção 11) só funciona em HTTPS e depende de suporte do navegador
   (Chrome 84+, iOS Safari 16.4+); guarda contra falta de suporte já incluída.

---

## 10. Como rodar

Sirva a pasta num servidor estático (ex.: `python -m http.server` ou `npx serve`) e abra no
navegador. Para GPS real, use HTTPS (certificado local ou deploy). Para testar manobras sem
dirigir, use o simulador (10 km/h no botão ▶, acelerável até 8x).

---

## 11. Tráfego em tempo real (TomTom) e recálculo anti-engarrafamento

### Camada visual (código seção 12)
- Botão flutuante `#traffic-btn` (🚦) liga/desliga um **raster overlay** dos tiles de
  fluxo da TomTom (`/traffic/map/4/tile/flow/relative/{z}/{x}/{y}.png`, estilo
  `relative`, `thickness=9` — `relative0` **rejeita** o parâmetro `thickness`, retornando
  400 e não renderizando nada), com `raster-opacity: 0.55` sobre o Dark Matter/Positron e
  inserido **abaixo** da rota (`before 'rota-halo'`).
- A **chave de API** é resolvida em `obterTomtomKey()` nesta ordem: chave digitada na
  primeira ativação e salva em `localStorage['flowpilot:tomtom_key']` **ou**
  `window.TOMTOM_KEY` definido em **`config.local.js`** (arquivo local, **ignorado no
  git** por `config.local.js` no `.gitignore` — não commitar a chave em repositório
  público). Sem chave, a camada não carrega (feedback).
- A camada é descartada no `setStyle` do tema e **recriada** em `recriarCamadas()`.
- **Cache de tiles**: URLs estáveis usam o cache HTTP nativo do navegador (nenhuma
  recarga por repetição de região).

### Recálculo anti-engarrafamento (código seção 13)
- Roda a cada atualização de posição (GPS **ou** simulador), só com `rotaAtiva`.
- **Retenção (via rápida):** se a média dos últimos 60 s (amostras ≥ 12 km/h) indica
  via rápida (> 45 km/h) e o veículo fica **< 12 km/h por 40 s** **dentro da rota**,
  consulta **silenciosamente** uma alternativa (`alternatives=true` numa única chamada
  OSRM) e escolhe a que economiza **> 2 min**.
- **Desvio:** se o veículo se afasta **> 30 m** da polilinha original (`desvio` medido
  perpendicular via `projetarPontoNoSegmento`), dispara recálculo de desvio.
- **Alerta:** barra `#traffic-alert` + voz: "Nova rota mais rápida (-X min)! Tocando
  para alternar...". Toque alterna na hora; sem toque, troca automática após 5 s
  (`processarRota(rota)`).

### Economia de cota (turno de 12 h)
- **Trava por distância:** recálculo de desvio só > 30 m da rota.
- **Stand-by:** parado 0 km/h por > 2 min suspende recálculo (e tráfego) até andar.
- **Debounce:** autocomplete ajustado para **300 ms** (`DEBOUNCE_BUSCA_MS`).
- **Cooldown:** mínimo de 90 s entre consultas de recálculo (`COOLDOWN_RECALC_MS`) +
  guarda `recalcEmProgresso` contra chamadas concorrentes.

> Observação: o "trecho de via rápida" usa heurística de velocidade média (o OSRM
> público não expõe a classe da via); a TomTom exige HTTPS e key válida.

---

## 12. Hodômetro cumulativo e controle de troca de óleo

### Persistência (localStorage)
- `flowpilot:kmAtualVeiculo` — KM total do veículo (em metros, acumulado em `kmAtualVeiculo`).
- `flowpilot:intervaloTrocaOleo` — intervalo de troca em km (0 = alertas desligados).
- `flowpilot:kmUltimaTrocaOleo` — KM registrado na última troca.

### Acumulação
- `acumularHodometro()` roda a cada `atualizarPosicaoVeiculo()`: somar `haversine()`
  entre posições quando `speed > 2 km/h`. Ignora simulador (`simulAtivo`), ruído
  (< 0,5 m) e saltos do GPS (> 200 m). Persiste via `salvarKmAtual()`.
- **App nativo = fonte de verdade:** quando `window.AndroidBridge` existe (WebView do app),
  o web NÃO acumula (guard `!nativoAtivo`); quem conta é o `ForegroundLocationService`
  (PRIORITY_HIGH_ACCURACY + Partial WakeLock + gravação contínua em `FlowBridge.somarKm`
  → prefs `km_seed`/`km_nativo`). O web espelha via `AndroidBridge.getStatus()` a cada 5 s.
- Recalibração do KM no modal → `recalibrarOdometro:true` na 1ª push → o nativo re-semeia a
  base preservando o deslocamento da troca de óleo (`FlowBridge.updateStatus`).

### UI
- Engrenagem flutuante `#settings-btn` (trilha direita, acima do botão de tráfego,
  `bottom: 450px`) abre o modal `#settings-modal` (animações suaves de fade/escala). A
  seção **Manutenção** mantém: ajuste do KM atual (sincroniza com painel físico),
  intervalo de troca e "Registrar troca de óleo agora".
- `#bottom-panel` em coluna: linha 1 = velocímetro + ETA/DIST + Chegada/Custo; linha 2 =
  **strip de manutenção** com odômetro total, status do óleo e **Trip A/B**, ex.:
  "usado 1.450 km · falta 1.550 km".
- **Alertas do óleo:** amarelo quando faltar < 10% do intervalo; **vermelho piscando**
  quando a quilometragem do intervalo for ultrapassada (troca pendente).

> O hodômetro acumula apenas no GPS real (o simulador não incrementa), exigindo
> permissão de geolocalização e deslocamento real.

---

## 13. Central de configurações e personalização (seção 15)

Persistência única em `localStorage` sob **`flowpilot_settings`** (objeto `settings`).
Viagens/odômetro mantêm as chaves próprias (`flowpilot:tripA`, `flowpilot:tripB`)
+ `flowpilot_settings.tripAtiva` (trip exibida no strip).

### Perfil do veículo e custos
- **Tipo de veículo** (Moto/Carro/Bicicleta): `perfilRoteamento()` devolve o perfil OSRM
  (`driving`/`cycling`) usado em `tracarRota()` **e** no recálculo
  `consultarRotaAlternativa()`.
- **Consumo (km/L)** e **Preço (R$/L)**: `calcularCusto()` estima o custo do trecho
  restante e alimenta a stat **Custo** (R$) na telemetria (linha Chegada/Custo).

### Alertas de velocidade e auditivos
- **Velocidade máxima**: no `atualizarCorVelocimetro()`, acima do limite o velocímetro
  fica vermelho + `bipAlerta()` (WebAudio, sem arquivo) na subida; `showFeedback`
  "Velocidade máxima ultrapassada!". Controle de borda `velocidadeLimiteOk`.
- **Frequência da voz**: `completa` anuncia a manobra a ~500 m e ~200 m (sets
  `enunciado500/200`) além do chamado a <30 m; `minima` anuncia só a manobra (<30 m).

### Energia, tela e tema
- **AMOLED Black**: classe `html.amoled` zera `--bg-overlay`/`--bg-dark` para #000 puro
  (economia de bateria/sol).
- **Manter tela ligada**: guard em `solicitarWakeLock()`; desligado libera o lock
  imediatamente.
- **Simulador**: toggle esconde os botões de simulação (`body.sem-simulador`) e, se
  ativo, para a simulação em andamento; `iniciarSimulacao()` também é bloqueado.

### Backup e dados
- **Exportar/Importar `.json`** (`dadosBackup()`/`aplicarImportacao()`): settings +
  odômetro (km atual, intervalo, última troca, Trip A e Trip B) + chave TomTom salva no app.
- **Trip A e Trip B**: ambas acumulam junto do hodômetro. No strip, o item **Trip**
  alterna A/B num toque; **segurar 600 ms** zera a viagem ativa (com confirmação);
  no modal há botões "Zerar Trip A" e "Zerar Trip B".

### Interface
- `showFeedback(msg, 'ok')` passa a usar verde (sucesso); sem tipo = vermelho (erro).
- O botão flutuante antigo de manutenção (`#maint-btn`) foi substituído por
  `#settings-btn` (engrenagem), na trilha direita logo acima do botão de tráfego.

---

## 14. Otimizações de performance e dinamismo

- **`distRestanteRota()` com busca coerente**: em vez de varrer a polilinha inteira a
  cada tick (O(n)), mantém `rotaBuscaIdxBase` (último segmento) e varre só uma janela de
  80 segmentos ao redor; a cada 40 ticks faz uma busca completa para reancorar. Âncoras
  resetadas em `processarRota()`/`novaRota()`.
- **Batch do localStorage**: `flushOdomSaveLento()` grava odômetro + Trip A/B no máximo
  1×/5 s (em vez de a cada tick de GPS); flush forçado em `beforeunload`/`visibilitychange
  hidden`.
- **Cache de DOM**: refs `speedValueEl`/`speedUnitEl` (evita `querySelector` no tick);
  HUD também usa refs fixas.
- **Throttle do follow (câmera)**: `acompanharVeiculo()` só chama `easeTo` quando o
  veículo andou ≥ 8 m, girou ≥ 5° ou passou 400 ms desde o último ajuste.
- **`sw.js` (Service Worker)**: cache-first para o app shell (`/`, `index.html`,
  `styles.css`, `app.js`, `manifest.json`, ícones) com atualização em segundo plano;
  `config.local.js` (chave TomTom) e recursos de terceiros usam rede primeiro com
  fallback em cache. Registrado no `load`; versão = `SW_CACHE_VERSION` (bump ao alterar).
- **`preconnect`** no `<head>` para unpkg, api.tomtom.com, router.project-osrm.org e
  nominatim.openstreetmap.org.

---

## 15. Corrida (trabalho de app) — 2 estágios 100% automáticos (código seção 16)

Fluxo para motoristas de aplicativo: **Livre → Coleta (embarque) → Viagem (destino final)**.
Estado persistido em `flowpilot:corrida` (`{estado, coleta, destino}`).
**Sem captura manual**: os endereços só entram por injeção automática (serviço nativo lendo
a notificação da 99, link de captura externo `?coleta=`/`?destino=` ou ponte JS). Na pista o
motorista apenas olha a rota.

### Interface (pista limpa)
- Linha extra `#corrida-strip` no painel inferior é **somente leitura**: chip do estágio
  ("Livre"/"Coleta"/"Viagem", colorido, com pulso ao chegar) + rótulo de destino da etapa
  ("Coleta: Rua X" / "Destino: Rua Y" / "Aguardando destino...").
- Único controle de corrida na interface: **"Encerrar corrida atual"** no modal de
  Configurações (fora da pista).
- **Mini-HUD flutuante** (velocidade + manobra + ETA, arrastável) e preview do texto da
  notificação fixa no modal → Configurações → Corrida.

### Injeção de endereços (automática)
- **Coleta**: `corridaSetEndereco('coleta', addr)` (serviço nativo/URL) → geocodificação
  Nominatim → estado `embarque` + rota até o ponto. Sem toque.
- **Destino**: `corridaSetEndereco('destino', addr, {forcarViagem, silencioso})`. No evento
  "início de viagem" (slider da 99) o nativo manda `?viagem=1&destino=` →
  estado `viagem` + rota ao destino final imediatamente. Se chegar ainda no embarque (situe:
  sem forçar), apenas anota e a rota é traçada na transição automática.
- `silencioso` suprime toasts em injeções em 2º plano (nada de popup que distraia).

### Transições automáticas (GPS)
`monitorProximidadeCorrida()` (a cada `atualizarPosicaoVeiculo`) compara a posição com o
alvo da etapa:
- a **< 30 m** da coleta → triplo bipe + voz + chip em pulso; após **6 s** (sem ação
  manual) transita sozinho para `viagem` (`corridaEmbarcou(true)`) e traça a rota do destino
  (se o destino tiver chegado, transita na hora).
- a **< 30 m** do destino → bipe + voz; após **15 s** encerra a corrida sozinho
  (`corridaFinalizar(true)`).
- ao sair a **> 50 m**, cancela timer/estado para novo disparo.

### Links de captura/injeção (`?coleta=&destino=&viagem=&etapa=`)
- Formato externo: `?coleta=<endereço>`, `?viagem=1&destino=<endereço>`, `?etapa=viagem|
  finalizar|embarque`. O boot (`bootCorrida`) aplica na mesma máquina de estados; é a ponte
  de injeção para o app nativo (ACTION_SEND/`acaoCaptura`).

### Ponte JS ↔ nativo
- `window.FlowPilot.buscarStatus()` expõe `{estado, coleta, destino, kmAtual, kmFaltaOleo,
  tripA, tripB, rotaAtiva, textoNotificacao}`; `enviarStatusNativo()` manda para
  `window.AndroidBridge.onStatusChanged` (quando existir) a cada mudança/5 s.
- `textoStatusNotificacao()` gera: "FlowPilot — EMBARQUE/EM VIAGEM | Odômetro: X km | Óleo:
  falta Y km" (alimenta a notificação fixa do serviço nativo).

---

## 16. Módulo nativo (Android / Capacitor) — pendente de build

Scaffold em `native/` + `capacitor.config.json` (`appId: com.flowpilot.app`, `webDir: "."`).
**Não compilado/testado aqui** (máquina atual sem Java/Android SDK). Build na sua máquina:

1. `npx cap init "FlowPilot" "com.flowpilot.app" --web-dir .`
2. `npx cap add android`; mesclar `native/AndroidManifest.xml` no manifest gerado
   (permissões `ACCESS_FINE/BACKGROUND_LOCATION`, `FOREGROUND_SERVICE(_LOCATION)`,
   `POST_NOTIFICATIONS`, `BIND_NOTIFICATION_LISTENER_SERVICE`, `SYSTEM_ALERT_WINDOW`,
   `WAKE_LOCK`; intent-filter `ACTION_SEND text/plain`; 3 servicios).
3. Copiar `native/android/**` → `android/app/src/main/java/com/flowpilot/app/` e os
   `res/layout|drawable` → `res/`. `MainActivity.kt` injeta `AndroidBridge` na WebView
   e trata `acaoCaptura` (coleta/destino/etapa) **sem recarregar** (JS direto na WebView,
   fallback via URL); `ForegroundLocationService` mantém notificação
   fixa + GPS; `NotificationListenerService` intercepta a notificação da 99, classifica
   **Nova corrida (coleta)** vs **Início de viagem (destino)** e injeta sozinho;
   `OverlayService` desenha o widget por cima do app da 99 com o único toque de emergência
   (Alternar Etapa). Detalhes e avisos (pacotes da 99 são heurística) em
   `native/README.md`.

### Avisos para produção
- **Acesso à notificação** exige permissão manual do usuário (Android Settings →
  Acesso especial → Acesso à notificação) e uso legítimo (não ler dados pessoais fora do
  fluxo de corrida).
- Overlay exige permissão manual "Sobre outros apps" (`Settings.ACTION_MANAGE_OVERLAY_PERMISSION`).
- O texto/regras de extração de endereço da 99 (`NotificationListenerService`) são
  heurística — revisar com o app da 99 atual.
