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

Organizado em 10 blocos comentados:

1. **Estado global + constantes** — variáveis do mapa, rota, navegação e estilos.
2. **Inicialização do mapa** — `initMap()`, controles, tema salvo, seguimento.
3. **GPS em tempo real** — `startGPSTracking()` / `atualizarPosicaoVeiculo()` / `acompanharVeiculo()`.
4. **Busca de destino** — Nominatim com debounce (400ms) e lista de sugestões.
5. **Roteamento OSRM** — `tracarRota()` → `desenharRota()` (halo + linha principal).
6. **Utilitários** — ETA, cor do velocímetro, `showFeedback`.
7. **Navegação passo a passo + voz** — instruções OSRM, ícone de manobra, voz.
8. **Geometria/utilitários adicionais** — haversine, formatação de distância.
9. **Destinos recentes** — persistência em `localStorage`.
10. **Simulador de rota** — ver seção 6 (estado: **incompleto**).

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
  play→stop e pinta o fundo de verde).

**Comportamento:** ao clicar em play com uma rota traçada, o simulador interpola a posição
ao longo de `currentRouteCoords` (a `10 km/h`), calcula o heading com `calcBearing()` e
dispara o mesmo fluxo de navegação via `atualizarPosicaoVeiculo()` (velocímetro, instruções,
voz, follow 3D). O GPS real é pausado (`clearWatch`) durante a simulação e retomado no stop;
ao chegar ao fim, velocidade zera e mostra "Simulação concluída!".

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

---

## 9. Ponto de atenção / pendências

1. ~~Simulador de rota incompleto (ver seção 6)~~ — **concluído**.
2. Atribuição da CartoDB/OSM desativada (`attributionControl:false`) — sem conformidade.
3. GPS real exige **HTTPS** ou `localhost`; simulador resolve testes sem dirigir.

---

## 10. Como rodar

Sirva a pasta num servidor estático (ex.: `python -m http.server` ou `npx serve`) e abra no
navegador. Para GPS real, use HTTPS (certificado local ou deploy). Para testar manobras sem
dirigir, o simulador (quando concluído) moverá o veículo pela rota.
