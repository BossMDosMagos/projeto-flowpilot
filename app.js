/* ============================================
   FLOWPILOT - Navegação GPS em tempo real (MapLibre GL)
   Stack: MapLibre GL + CartoDB Dark Matter + OSRM público
   ============================================ */

/* ---------- Estado global ---------- */
let map = null;              // Instância do MapLibre
let vehicleMarker = null;    // Marcador do veículo (MapLibre Marker)
let destinoMarker = null;    // Bandeira de chegada no destino (MapLibre Marker)
let sourceRota = null;       // Fonte GeoJSON da rota
let currentRouteCoords = null; // Coordenadas da rota ativa (para re-desenho ao trocar tema)
let currentRouteDistance = 0;  // Distância total da rota ativa (m) — telemetria
let currentRouteDuration = 0;  // Duração total da rota ativa (s) — telemetria
let rotaAtiva = false;       // Se há uma rota em andamento (substitui a busca)
let destinoSelecionado = null; // {lon, lat, nome}
let followMode = true;       // Se o mapa segue automaticamente o veículo
let temaEscuro = true;       // Tema atual (Dark Matter escuro por padrão)
let lastHeading = 0;         // Último rumo (heading) do GPS
let currentSteps = [];       // Passos da rota atual (com geometrias)
let currentStepIndex = 0;    // Índice da instrução atual
let enunciadoPerto = new Set(); // Passos já anunciados por voz
let enunciado500 = new Set();   // Passos já anunciados a ~500 m (voz "completa")
let enunciado200 = new Set();   // Passos já anunciados a ~200 m (voz "completa")
let touchManipulado = false; // Se o usuário manipulou o mapa manualmente
let watchId = null;          // ID do watchPosition (para pausar/retomar o GPS)
let wakeLock = null;         // Screen Wake Lock ativo (tela não apaga na navegação)

// Tráfego + recálculo anti-engarrafamento
let trafficAtivo = false;    // Camada de tráfego TomTom visível
let recalcEmProgresso = false; // Há uma consulta de rota alternativa em andamento
let recalcCooldownAte = 0;   // Timestamp do próximo recálculo permitido
let alertaEmAberto = false;  // Alerta de nova rota exibido
let alertaTimer = null;      // Timer de auto-alternância (5 s)
let alertaHandler = null;    // Handler de clique do alerta
let ultimoTickMonitor = 0;   // Timestamp da última avaliação do monitor
let tempoLentoAcum = 0;      // Segundos abaixo de 12 km/h (via rápida)
let tempoParadoAcum = 0;     // Segundos parado (stand-by)
let standbyAtivo = false;    // Veículo parado > 2 min: suspende recálculo/tráfego
let janelaVel = [];          // Janela deslizante de velocidades {t, v}

// Hodômetro cumulativo + manutenção
let kmAtualVeiculo = 0;      // KM total do veículo (meters)
let intervaloTrocaOleo = 0;  // Intervalo de troca de óleo (km)
let kmUltimaTrocaOleo = 0;   // KM registrado na última troca de óleo
let odomPosAnterior = null;  // Última posição GPS p/ cálculo de deslocamento
const CHAVE_KM_ATUAL = 'flowpilot:kmAtualVeiculo';
const CHAVE_INTERVALO = 'flowpilot:intervaloTrocaOleo';
const CHAVE_KM_TROCA = 'flowpilot:kmUltimaTrocaOleo';
const CHAVE_TRIP_A = 'flowpilot:tripA';
const CHAVE_SETTINGS = 'flowpilot_settings';

// Central de configurações (persistida em flowpilot_settings)
let settings = {
  veiculo: 'moto',            // moto | carro | bicicleta
  consumo: 0,                 // km/L
  precoCombustivel: 0,        // R$/L
  velMaxima: 0,               // km/h (0 = desligado)
  freqVoz: 'completa',        // completa | minima
  amoled: false,              // fundos #000 puro (bateria OLED)
  manterTelaLigada: true      // Screen Wake Lock
};
let tripAKm = 0;              // KM da viagem diária (Trip A)
let ultimaVelocidade = 0;     // Última velocidade exibida (p/ re-render de alerta)
let velocidadeLimiteOk = true; // Controle do bipe: dispara na subida do limite
let ctxAudio = null;          // Contexto WebAudio para o bipe

// Referências de elementos DOM
const $ = (id) => document.getElementById(id);
const inputDestino = $('destino-input');
const btnIniciar = $('iniciar-rota-btn');
const btnLocate = $('locate-btn');
const btnTheme = $('theme-btn');
const btnNovaRota = $('nova-rota-btn');
const btnSimul = $('simul-btn');
const btnSimulSpeed = $('simul-speed-btn');
const btnTraffic = $('traffic-btn');
const trafficAlertEl = $('traffic-alert');
const btnSettings = $('settings-btn');
const settingsModalEl = $('settings-modal');
const cfgKmAtual = $('cfg-km-atual');
const cfgIntervalo = $('cfg-intervalo-oleo');
const btnRegistrarTroca = $('btn-registrar-troca');
const btnFecharConfig = $('btn-fechar-config');
const kmOdometroEl = $('km-odometro');
const kmTripAEl = $('km-trip-a');
const oleoStatusEl = $('oleo-status');
const oleoInfoEl = $('oleo-info');
const custoRotaEl = $('custo-rota');
const cfgTipoVeiculo = $('cfg-tipo-veiculo');
const cfgConsumo = $('cfg-consumo');
const cfgPrecoCombustivel = $('cfg-preco-combustivel');
const cfgVelMax = $('cfg-vel-max');
const cfgFreqVoz = $('cfg-freq-voz');
const cfgAmoled = $('cfg-amoled');
const cfgTelaLigada = $('cfg-tela-ligada');
const cfgTripAValor = $('cfg-trip-a-valor');
const btnExportar = $('btn-exportar');
const btnImportar = $('btn-importar');
const cfgArquivoImport = $('cfg-arquivo-import');
const btnResetTrip = $('btn-reset-trip');
const sugestoesEl = $('sugestoes');
const velocimetroEl = $('velocimetro');
const etaTimeEl = $('eta-time');
const distKmEl = $('dist-km');
const chegadaHoraEl = $('chegada-hora');
const navInstructionEl = $('nav-instruction');
const instrManeuverEl = $('instr-maneuver');
const instrTextEl = $('instr-text');
const instrDistEl = $('instr-dist');

// Constantes de estilo do mapa
const STYLE_CARTO_DARK = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const STYLE_CARTO_LIGHT = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const PITCH_NAVEGACAO = 50;   // Inclinação 3D de pilotagem (45-50°)
const ZOOM_MOVIMENTO = 17;    // Zoom aproximado quando o veículo está em movimento
const ZOOM_PARADO = 16;       // Zoom padrão quando parado/navegando

// TomTom Traffic Flow (tiles raster) — requer chave de API (free tier)
// Obs.: `thickness` só é aceito por estilos `relative`/`absolute` (não `relative0`)
const TOMTOM_TRAFFIC_TILES =
  'https://api.tomtom.com/traffic/map/4/tile/flow/relative/{z}/{x}/{y}.png?key={KEY}&thickness=9&language=pt-BR&tileSize=256';
const CHAVE_TOMTOM = 'flowpilot:tomtom_key';

// Monitor anti-engarrafamento e economia de cota de requisições
const VELOCIDADE_LENTA = 12;      // km/h — abaixo disso conta como retenção
const TEMPO_LENTO_LIMITE_S = 40;  // segundos lento para disparar recálculo
const VELOCIDADE_VIA_RAPIDA = 45; // média recente mín. p/ considerar via rápida
const DESVIO_LIMITE_M = 30;       // metros de desvio da rota p/ recalcular
const GANHO_MINIMO_S = 120;       // economia mínima (2 min) p/ sugerir nova rota
const COOLDOWN_RECALC_MS = 90000; // intervalo mínimo entre recálculos
const STANDBY_LIMITE_S = 120;     // parado p/ entrar em stand-by (suspende chamadas)
const DEBOUNCE_BUSCA_MS = 300;    // debounce do autocomplete de endereços

/* ---------- 1. INICIALIZAÇÃO DO MAPA ---------- */
function initMap() {
  // Coordenada padrão: São Paulo
  const defaultCoords = [-23.5505, -46.6333];

  map = new maplibregl.Map({
    container: 'map',
    style: STYLE_CARTO_DARK,
    center: [defaultCoords[1], defaultCoords[0]],
    zoom: ZOOM_PARADO,
    pitch: 0,
    bearing: 0,
    minZoom: 3,
    maxZoom: 20,
    attributionControl: false
  });
  // Criar o marcador do veículo quando o estilo carregar
  map.on('load', () => {
    vehicleMarker = createVehicleMarker(defaultCoords);
  });

  // Se o usuário manipular o mapa manualmente, desativa o follow
  map.on('dragstart', () => { followMode = false; setFollowMode(false); });
  map.on('touchstart', () => { followMode = false; setFollowMode(false); });

  // Botão flutuante: centraliza novamente no veículo e reativa o follow
  btnLocate.addEventListener('click', () => {
    const pos = window.currentCoords;
    if (pos) {
      map.easeTo({
        center: [pos.lon, pos.lat],
        zoom: Math.max(map.getZoom(), ZOOM_PARADO),
        bearing: rotaAtiva ? lastHeading : 0,
        pitch: rotaAtiva ? PITCH_NAVEGACAO : 0
      });
    }
    setFollowMode(true);
  });

  // Botão flutuante: alternar tema claro/escuro (troca o estilo do mapa)
  btnTheme.addEventListener('click', () => {
    const escuro = document.body.classList.toggle('noturno');
    try { localStorage.setItem('flowpilot:tema', escuro ? 'escuro' : 'claro'); } catch (e) {}
    aplicarTema(escuro);
  });

  // Evento "mover" do usuário desativa follow
  map.on('moveend', () => {
    touchManipulado = false;
  });

  // Aplica o tema salvo (claro/escuro) na inicialização
  carregarTemaInicial();

  startGPSTracking();
}

// Liga/desliga o modo de "seguir o veículo"
function setFollowMode(ativo) {
  followMode = ativo;
  btnLocate.classList.toggle('active', ativo);
}

// Lê a preferência de tema salva e aplica (escuro por padrão)
function carregarTemaInicial() {
  let escuro = true;
  try {
    escuro = (localStorage.getItem('flowpilot:tema') || 'escuro') !== 'claro';
  } catch (e) {}
  // Se o tema salvo for claro, troca o estilo (o mapa inicia escuro)
  if (!escuro) {
    temaEscuro = true; // força a troca em aplicarTema
    aplicarTema(false);
  } else {
    document.body.classList.add('noturno');
  }
}

// Alterna o estilo do mapa (Dark Matter = escuro, Positron = claro)
function aplicarTema(escuro) {
  if (temaEscuro === escuro) return;
  temaEscuro = escuro;
  document.body.classList.toggle('noturno', escuro);
  const style = escuro ? STYLE_CARTO_DARK : STYLE_CARTO_LIGHT;

  map.setStyle(style);

  // Ao recarregar o estilo, o marcador e as camadas de rota são perdidos.
  map.once('style.load', () => {
    recriarCamadas();
  });
}

// Recria marcador do veículo e rota após troca de estilo
function recriarCamadas() {
  const pos = window.currentCoords || null;
  if (pos && pos.lat !== undefined && pos.lon !== undefined) {
    vehicleMarker = createVehicleMarker([pos.lon, pos.lat]);
  } else {
    vehicleMarker = createVehicleMarker([-46.6333, -23.5505]);
  }
  // Re-traça a rota ativa, se houver
  if (rotaAtiva && currentRouteCoords) {
    desenharRota(currentRouteCoords);
  }
  // Recria a camada de tráfego se estava ativa (o estilo novo a remove)
  if (trafficAtivo) {
    const key = obterTomtomKey();
    if (key) ativarTraffic(key, true);
  }
}

/* ---------- 2. MARCADOR PERSONALIZADO DO VEÍCULO ---------- */
function createVehicleMarker(coords) {
  // Elemento HTML do marcador (seta que aponta para cima no centro)
  const el = document.createElement('div');
  el.className = 'vehicle-marker-wrap';
  el.innerHTML = '<div class="vehicle-marker"><span class="vehicle-arrow"></span><span class="vehicle-dot"></span></div>';

  const marker = new maplibregl.Marker({
    element: el,
    anchor: 'center'
  })
    .setLngLat([coords[1], coords[0]])
    .addTo(map);

  return marker;
}

// Atualiza a seta do veículo: com bearing do mapa, o marcador fica apontando
// para "cima" (direção de deslocamento); guardamos o heading para o mapa girar.
function atualizarSetaVeiculo() {
  // A seta aponta para cima; o mapa gira pelo bearing para o heading.
  const arr = vehicleMarker.getElement().querySelector('.vehicle-arrow');
  if (arr) arr.style.transform = 'rotate(0deg)'; // mantém apontando para cima
}

/* ---------- BANDEIRA DE CHEGADA (quadriculada preto/branco) ---------- */
function bandeiraChegadaSVG() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">` +
    `<defs><pattern id="checker-finish" width="3.5" height="3.6667" patternUnits="userSpaceOnUse">` +
    `<rect width="3.5" height="3.6667" fill="#ffffff"/>` +
    `<rect width="1.75" height="1.8333" fill="#0f172a"/>` +
    `<rect x="1.75" y="1.8333" width="1.75" height="1.8333" fill="#0f172a"/>` +
    `</pattern></defs>` +
    `<rect x="5" y="2" width="2" height="21" rx="1" fill="#94a3b8"/>` +
    `<rect x="7" y="3" width="14" height="11" fill="url(#checker-finish)" stroke="#1e293b" stroke-width="0.7"/>` +
    `</svg>`;
}

// Cria (ou recria) a bandeira de chegada no ponto final da rota (coords [lon, lat])
function createDestinoMarker(coords) {
  if (!coords) return;
  if (destinoMarker) {
    destinoMarker.remove();
    destinoMarker = null;
  }
  const el = document.createElement('div');
  el.className = 'destination-marker';
  el.innerHTML = `<div class="destination-flag">${bandeiraChegadaSVG()}</div>`;
  destinoMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat([coords[0], coords[1]])
    .addTo(map);
  return destinoMarker;
}

function removerDestinoMarker() {
  if (destinoMarker) {
    destinoMarker.remove();
    destinoMarker = null;
  }
}

/* ---------- 3. GPS EM TEMPO REAL (watchPosition) ---------- */
function startGPSTracking() {
  if (!navigator.geolocation) {
    console.error('Geolocalização não suportada');
    alert('Geolocalização não suportada no seu navegador.');
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      atualizarPosicaoVeiculo(
        position.coords.latitude,
        position.coords.longitude,
        (typeof position.coords.speed === 'number' && !isNaN(position.coords.speed)) ? position.coords.speed * 3.6 : 0,
        position.coords.heading
      );
    },
    (error) => {
      console.error('Erro de GPS:', error);
      let msg = 'Erro ao obter localização.';
      switch (error.code) {
        case error.PERMISSION_DENIED:
          msg = 'Permissão de localização negada. Ative o GPS do celular para usar o FlowPilot.';
          break;
        case error.POSITION_UNAVAILABLE:
          msg = 'Posição indisponível. Verifique se o GPS está ativo.';
          break;
        case error.TIMEOUT:
          msg = 'Tempo esgotado para obter a localização. Tente novamente.';
          break;
      }
      showFeedback(msg);
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
  );
}

// Atualiza a posição do veículo (usado pelo GPS real e pelo simulador)
function atualizarPosicaoVeiculo(latitude, longitude, velocidadeKmh, heading) {
  const pos = [longitude, latitude];

  // Move o marcador do veículo
  if (vehicleMarker) vehicleMarker.setLngLat(pos);

  // Guarda heading para navegação
  if (typeof heading === 'number' && !isNaN(heading)) lastHeading = heading;

  // Atualiza o velocímetro
  ultimaVelocidade = Math.round(velocidadeKmh);
  velocimetroEl.textContent = ultimaVelocidade;
  atualizarCorVelocimetro(ultimaVelocidade);

  // Guarda posição para roteamento
  window.currentCoords = { lat: latitude, lon: longitude };

  // Atualiza a instrução de navegação conforme avança
  atualizarInstrucao(window.currentCoords);

  // Telemetria em tempo real: ETA, distância restante e hora de chegada
  atualizarTelemetria(window.currentCoords);

  // Monitor anti-engarrafamento + recálculo econômico (roteamento ativo)
  monitorarEngarrafamento(velocidadeKmh, window.currentCoords);

  // Hodômetro cumulativo (deslocamento real, sem simulação)
  acumularHodometro(latitude, longitude, velocidadeKmh);

  // Segue o veículo (com pitch/bearing no modo rota)
  if (followMode) {
    acompanharVeiculo(pos, velocidadeKmh, heading);
  }

  // Zoom automático 17/18 quando em movimento (durante navegação)
  if (rotaAtiva && followMode && velocidadeKmh > 5) {
    if (map.getZoom() < 17) {
      map.easeTo({ zoom: Math.min(18, Math.max(map.getZoom(), 17)), duration: 800 });
    }
  }
}

// Acompanha o veículo com perspectiva 3D e rotação (estilo Waze)
function acompanharVeiculo(pos, velocidade, heading) {
  if (!map) return;

  const opcoes = {
    center: pos,
    duration: 500,
    essential: true
  };

  // Durante a navegação: inclina a câmera e gira para o rumo
  if (rotaAtiva) {
    opcoes.pitch = PITCH_NAVEGACAO;
    if (typeof heading === 'number' && !isNaN(heading)) {
      opcoes.bearing = heading;
    }
    // Aproxima quando em movimento
    if (velocidade > 5) {
      opcoes.zoom = Math.max(map.getZoom(), ZOOM_MOVIMENTO);
    }
  } else {
    // Sem rota: visão de cima, sem inclinação
    opcoes.pitch = 0;
    opcoes.bearing = 0;
  }

  map.easeTo(opcoes);
}

/* ---------- 4. BUSCA DE DESTINO (Nominatim) ---------- */
let debounceTimer = null;

inputDestino.addEventListener('input', () => {
  const query = inputDestino.value.trim();
  clearTimeout(debounceTimer);

  if (query.length < 3) {
    hideSugestoes();
    return;
  }

  debounceTimer = setTimeout(() => buscarEndereco(query), DEBOUNCE_BUSCA_MS);
});

function buscarEndereco(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&countrycodes=br&bounded=1`;

  fetch(url)
    .then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(exibirSugestoes)
    .catch(err => {
      console.error('Erro na busca Nominatim:', err);
      hideSugestoes();
    });
}

function exibirSugestoes(resultados) {
  sugestoesEl.innerHTML = '';

  if (!resultados || resultados.length === 0) {
    hideSugestoes();
    return;
  }

  resultados.forEach(r => {
    const item = document.createElement('div');
    item.className = 'sugestao-item';
    item.textContent = r.display_name || r.name || 'Resultado';
    item.addEventListener('click', () => {
      destinoSelecionado = {
        lon: parseFloat(r.lon),
        lat: parseFloat(r.lat),
        nome: r.display_name || ''
      };
      inputDestino.value = r.display_name || '';
      hideSugestoes();
    });
    sugestoesEl.appendChild(item);
  });

  sugestoesEl.classList.add('visivel');
}

function hideSugestoes() {
  sugestoesEl.classList.remove('visivel');
  sugestoesEl.innerHTML = '';
}

// Fechar sugestões ao clicar fora
document.addEventListener('click', (e) => {
  if (!e.target.closest('#top-bar')) hideSugestoes();
});

/* ---------- 5. ROTEAMENTO OSRM ---------- */
btnIniciar.addEventListener('click', () => tracarRota());

function tracarRota() {
  if (!destinoSelecionado) {
    showFeedback('Selecione um destino na lista de sugestões.');
    return;
  }

  const origem = window.currentCoords || { lon: -46.6333, lat: -23.5505 };

  const url =
    `https://router.project-osrm.org/route/v1/${perfilRoteamento()}/` +
    `${origem.lon},${origem.lat};${destinoSelecionado.lon},${destinoSelecionado.lat}` +
    `?overview=full&geometries=geojson&steps=true`;

  fetch(url)
    .then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(data => {
      if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
        throw new Error('Não foi possível calcular a rota.');
      }
      processarRota(data.routes[0]);
    })
    .catch(err => {
      console.error('Erro no OSRM:', err);
      showFeedback('Não foi possível calcular a rota. Tente novamente.');
    });
}

// Renderiza uma rota já calculada (usada pela rota original e pelo recálculo)
function processarRota(route) {
  desenharRota(route.geometry.coordinates);

  // Guarda os passos para navegação
  if (route.legs && route.legs[0] && route.legs[0].steps) {
    currentSteps = route.legs[0].steps;
    currentStepIndex = 0;
    enunciadoPerto.clear();
    enunciado500.clear();
    enunciado200.clear();
    exibirInstrucao(0);
    falarVoz(instrucaoTexto(currentSteps[0]));
  } else {
    currentSteps = [];
    ocultarInstrucao();
  }

  const minutos = Math.max(1, Math.round(route.duration / 60));
  const km = (route.distance / 1000).toFixed(1);

  currentRouteDistance = route.distance;
  currentRouteDuration = route.duration;
  registrarDestinoRecente(destinoSelecionado);

  etaTimeEl.textContent = formatarETA(minutos);
  distKmEl.textContent = `${km} km`;

  // Ativa o modo rota (perspectiva 3D + rotação)
  ativarRota();
  destacarRota();
  atualizarTelemetria(window.currentCoords);
}

// Desenha a rota como camada GeoJSON (halo + linha principal)
function desenharRota(coordenadas) {
  if (!map.isStyleLoaded() && !map.loaded()) return;

  currentRouteCoords = coordenadas;

  const geojson = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: coordenadas }
  };

  // Remove rota anterior
  if (sourceRota) {
    try { map.removeLayer('rota-halo'); } catch (e) {}
    try { map.removeLayer('rota-linha'); } catch (e) {}
    try { map.removeSource('rota'); } catch (e) {}
  }

  map.addSource('rota', { type: 'geojson', data: geojson });

  // Halo (contorno) grosso
  map.addLayer({
    id: 'rota-halo',
    type: 'line',
    source: 'rota',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#1d4ed8',
      'line-width': 12,
      'line-opacity': 0.35
    }
  });

  // Linha principal
  map.addLayer({
    id: 'rota-linha',
    type: 'line',
    source: 'rota',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#3b82f6',
      'line-width': 6,
      'line-opacity': 0.95
    }
  });

  sourceRota = 'rota';

  // Bandeira de chegada quadriculada no ponto final da rota
  const ultimo = coordenadas[coordenadas.length - 1];
  if (ultimo) createDestinoMarker(ultimo);

  // Ajusta o mapa para caber a rota
  const bounds = coordenadas.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coordenadas[0], coordenadas[0]));
  map.fitBounds(bounds, { padding: 80, duration: 800 });
}

// Após a rota ser traçada, muda para perspectiva de piloto e centraliza no veículo
function destacarRota() {
  const pos = window.currentCoords;
  if (!pos) return;
  setFollowMode(true);
  map.easeTo({
    center: [pos.lon, pos.lat],
    zoom: ZOOM_PARADO,
    pitch: PITCH_NAVEGACAO,
    bearing: lastHeading || 0,
    duration: 1200
  });
}

/* ---------- 6. UTILITÁRIOS ---------- */
function formatarETA(minutos) {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}`;
  }
  return `${m} min`;
}

function formatarHora(data) {
  return `${String(data.getHours()).padStart(2, '0')}:${String(data.getMinutes()).padStart(2, '0')}`;
}

/* ---- TELEMETRIA EM TEMPO REAL ----
   Recalcula a distância restante ao longo da rota a partir da posição atual e
   estima a duração restante proporcionalmente ao total (route.duration). */
function atualizarTelemetria(pos) {
  if (!pos || pos.lat === undefined || pos.lon === undefined) return;
  if (!currentRouteCoords || !currentRouteDistance) return;

  const restante = distRestanteRota(pos.lat, pos.lon);
  const frac = currentRouteDistance > 0 ? Math.max(0, restante / currentRouteDistance) : 1;
  const durRestante = currentRouteDuration * frac;

  distKmEl.textContent = formatarDistancia(restante);
  etaTimeEl.textContent = formatarETA(Math.max(0, Math.round(durRestante / 60)));
  chegadaHoraEl.textContent = formatarHora(new Date(Date.now() + durRestante * 1000));
  if (custoRotaEl) custoRotaEl.textContent = calcularCusto(restante);
}

// Distância (m) que falta percorrer da posição até o fim da rota
function distRestanteRota(lat, lon) {
  const coords = currentRouteCoords;
  if (!coords || coords.length < 2) return 0;

  // Acha o segmento mais próximo da posição atual
  let melhor = { idx: 0, frac: 0, dist: Infinity };
  for (let i = 0; i < coords.length - 1; i++) {
    const proj = projetarPontoNoSegmento(lat, lon, coords[i], coords[i + 1]);
    if (proj.dist < melhor.dist) melhor = { idx: i, frac: proj.frac, dist: proj.dist };
  }

  // Soma o restante do segmento atual + todos os seguintes
  const a = coords[melhor.idx];
  const b = coords[melhor.idx + 1];
  let restante = haversine(a[1], a[0], b[1], b[0]) * (1 - melhor.frac);
  for (let i = melhor.idx + 1; i < coords.length - 1; i++) {
    restante += haversine(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
  }
  return restante;
}

// Projeta um ponto sobre o segmento [a,b] (coords [lon, lat]) usando
// projeção equiretangular local (basta para distâncias curtas de segmento).
function projetarPontoNoSegmento(lat, lon, a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const M_PER_DEG = 111320;
  const k = Math.cos(toRad((a[1] + b[1]) / 2));
  const xa = a[0] * k * M_PER_DEG, ya = a[1] * M_PER_DEG;
  const xb = b[0] * k * M_PER_DEG, yb = b[1] * M_PER_DEG;
  const xp = lon * k * M_PER_DEG, yp = lat * M_PER_DEG;

  const dx = xb - xa, dy = yb - ya;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? ((xp - xa) * dx + (yp - ya) * dy) / len2 : 0;
  const frac = Math.max(0, Math.min(1, t));
  const px = xa + dx * frac, py = ya + dy * frac;
  return { frac, dist: Math.hypot(xp - px, yp - py) };
}

// Cor do velocímetro conforme velocidade (+ alerta de velocidade máxima com bipe)
function atualizarCorVelocimetro(kmh) {
  const speedValue = document.querySelector('.speed-value');
  const speedUnit = document.querySelector('.speed-unit');
  if (!speedValue) return;

  let cor;
  if (settings.velMaxima > 0 && kmh > settings.velMaxima) {
    cor = '#ef4444';
    if (velocidadeLimiteOk) {
      velocidadeLimiteOk = false;
      bipAlerta();
      showFeedback(`Velocidade máxima de ${settings.velMaxima} km/h ultrapassada!`);
    }
  } else {
    if (!velocidadeLimiteOk) velocidadeLimiteOk = true;
    cor =
      kmh >= 90 ? '#ef4444' :
      kmh >= 60 ? '#f59e0b' :
                   '#22c55e';
  }
  speedValue.style.color = cor;
  if (speedUnit) speedUnit.style.color = cor;
  speedValue.style.textShadow = `0 0 12px ${cor}80`;
}

// Feedback flutuante (tipo 'ok' = verde; padrão = vermelho/erro)
function showFeedback(msg, tipo) {
  const existing = document.getElementById('flowpilot-feedback');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.id = 'flowpilot-feedback';
  div.textContent = msg;
  div.style.cssText = `
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
    z-index: 4000; background: ${tipo === 'ok' ? '#22c55e' : '#ef4444'}; color: #fff; padding: 12px 20px;
    border-radius: 12px; font-size: 14px; font-weight: 600;
    box-shadow: 0 4px 20px rgba(0,0,0,0.4); max-width: 90%; text-align: center;
  `;
  document.body.appendChild(div);

  setTimeout(() => div.remove(), 5000);
}

/* ---------- 7. NAVEGAÇÃO PASSO-A-PASSO + VOZ ---------- */

function instrucaoTexto(step) {
  if (!step) return '';
  const mani = step.maneuver || {};
  const local = step.name || step.ref || '';
  return formatarInstrucao(mani.type, mani.modifier, local, step.distance);
}

function formatarInstrucao(type, modifier, local, distancia) {
  const dist = formatarDistancia(curta(distancia));
  if (type === 'arrive') return 'Você chegou ao destino';

  switch (type) {
    case 'depart':
      return `Siga ${modifierMap(modifier || 'straight')}${local ? ` em ${local}` : ''} por ${dist}`;
    case 'roundabout':
    case 'rotary':
      return `Entre na rotatória e ${modifierSub(modifier)}${local ? ` em ${local}` : ''}`;
    case 'turn':
      return `Vire ${modifierMap(modifier)}${local ? ` em ${local}` : ''} e siga por ${dist}`;
    case 'merge':
      return `Entre na estrada à ${modifierMap(modifier)}${local ? ` em ${local}` : ''}`;
    case 'fork':
      return `Mantenha ${modifierMap(modifier)}${local ? ` em ${local}` : ''}`;
    case 'end of road':
      return `No fim da via, vire ${modifierMap(modifier)}${local ? ` em ${local}` : ''} e siga por ${dist}`;
    case 'continue':
      if (modifier === 'uturn') return `Faça uma inversão e continue por ${dist}`;
      return `Continue ${modifierMap(modifier)}${local ? ` em ${local}` : ''} por ${dist}`;
    case 'new name':
      return `Continue em ${local || 'frente'}`;
    default:
      return `Continue ${modifierMap(modifier)}${local ? ` em ${local}` : ''} por ${dist}`;
  }
}

function modifierSub(modifier) {
  const m = {
    'left': 'saia à esquerda',
    'right': 'saia à direita',
    'slight left': 'saia levemente à esquerda',
    'slight right': 'saia levemente à direita',
    'straight': 'siga em frente',
    'uturn': 'faça o retorno'
  };
  return m[modifier] || 'continue';
}

function modifierMap(modifier) {
  const m = {
    'left': 'à esquerda',
    'right': 'à direita',
    'slight left': 'levemente à esquerda',
    'slight right': 'levemente à direita',
    'sharp left': 'bruscamente à esquerda',
    'sharp right': 'bruscamente à direita',
    'straight': 'em frente',
    'uturn': 'em U'
  };
  return m[modifier] || modifier || '';
}

/* ---- DESCRIÇÃO DA PRÓXIMA AÇÃO (sub-título do card) ----
   Gera uma frase clara sobre a manobra futura, ex:
   "Vire à direita em 200 m" ou "Pegue a saída em Avenida Brasil". */
function descricaoProximaAcao(step, distM) {
  if (!step) return '';
  const mani = step.maneuver || {};
  const type = mani.type;
  const modifier = mani.modifier;
  const local = step.name || step.ref || '';
  const dist = formatarDistancia(Number.isFinite(distM) ? distM : curta(step.distance));

  if (type === 'arrive') return `Chegue ao destino em ${dist}`;
  if (type === 'depart') return `Siga em frente por ${dist}`;
  if (type === 'roundabout' || type === 'rotary') {
    return `Pegue a saída${local ? ` em ${local}` : ''} em ${dist}`;
  }
  if (type === 'merge') return `Entre na estrada em ${dist}`;

  const dir = modifierMap(modifier) || (['left', 'right'].includes(modifier) ? `à ${modifier}` : '');
  if (type === 'turn' && dir) return `Vire ${dir}${local ? ` em ${local}` : ''} em ${dist}`;
  if (type === 'end of road' && dir) return `No fim da via, vire ${dir} em ${dist}`;
  if (type === 'fork') return `Mantenha ${dir || 'a direção'} em ${dist}`;
  if (modifier === 'uturn') return `Faça uma inversão em ${dist}`;
  if (type === 'continue' || type === 'new name') {
    return local ? `Continue em ${local} por ${dist}` : `Siga em frente por ${dist}`;
  }
  return `Continue em ${local || 'frente'} por ${dist}`;
}

/* ---- ÍCONE DE MANOBRA DINÂMICO ----
   Determina a direção a partir do TEXTO da instrução (gerado do OSRM)
   e do modifier; aplica uma classe CSS de direção (.maneuver-left,
   .maneuver-right, etc.) ao elemento e desenha uma seta SVG que
   rotaciona conforme a manobra (estilo Waze). */
function atualizarIconeManeuver(step) {
  const el = instrManeuverEl;
  if (!step) {
    el.className = 'instr-maneuver maneuver-straight';
    el.innerHTML = setaSVG('straight');
    return;
  }

  const mani = step.maneuver || {};
  const type = mani.type;
  const modifier = mani.modifier;
  const texto = instrucaoTexto(step);
  const t = (texto || '').toLowerCase();

  // Chegada ao destino
  if (type === 'arrive') {
    el.className = 'instr-maneuver maneuver-arrive';
    el.innerHTML = chegadaSVG();
    return;
  }

  // Partida / segue em frente
  if (type === 'depart' || modifier === 'straight' || type === 'new name') {
    el.className = 'instr-maneuver maneuver-straight';
    el.innerHTML = setaSVG('straight');
    return;
  }

  // Rotatória
  if (type === 'roundabout' || type === 'rotary' || t.includes('rotatória')) {
    el.className = 'instr-maneuver maneuver-roundabout';
    el.innerHTML = rotatoriaSVG();
    return;
  }

  // Inversão (seta em U)
  if (modifier === 'uturn' || t.includes('retorno') || t.includes('inversão')) {
    el.className = 'instr-maneuver maneuver-uturn';
    el.innerHTML = uturnSVG();
    return;
  }

  // Direção principal (esquerda/direita) pelo texto; intensidade pelo texto/modifier
  let dir = 'straight';
  let nivel = '';
  if (t.includes('esquerda')) { dir = 'left'; }
  else if (t.includes('direita')) { dir = 'right'; }
  else {
    switch (modifier) {
      case 'left': dir = 'left'; break;
      case 'right': dir = 'right'; break;
      case 'slight left': dir = 'left'; nivel = 'slight'; break;
      case 'slight right': dir = 'right'; nivel = 'slight'; break;
      case 'sharp left': dir = 'left'; nivel = 'sharp'; break;
      case 'sharp right': dir = 'right'; nivel = 'sharp'; break;
      default: dir = 'straight';
    }
  }

  // Intensidade detectada no texto gerado
  if (dir !== 'straight') {
    if (t.includes('bruscamente')) nivel = 'sharp';
    else if (t.includes('levemente')) nivel = 'slight';
  }

  const chave = nivel ? `${nivel}-${dir}` : dir;
  el.className = `instr-maneuver maneuver-${chave}`;
  el.innerHTML = setaSVG(chave);
}

// Setas direcionais em SVG (base aponta para a direita; a CSS rotaciona)
function setaSVG(dir) {
  return `<svg class="maneuver-arrow maneuver-arrow-${dir}" viewBox="0 0 24 24" aria-hidden="true">` +
    `<path d="M4 11h13.6l-5.3-5.3L13.6 4.4 21.2 12l-7.6 7.6-1.3-1.3 5.3-5.3H4v-2z"/></svg>`;
}

function uturnSVG() {
  return `<svg class="maneuver-arrow maneuver-uturn-ic" viewBox="0 0 24 24" aria-hidden="true">` +
    `<path d="M17 16h3V8a5 5 0 0 0-10 0v11"/><path d="M7 13l-4 3 4 3z"/></svg>`;
}

function rotatoriaSVG() {
  return `<svg class="maneuver-arrow maneuver-roundabout-ic" viewBox="0 0 24 24" aria-hidden="true">` +
    `<path d="M12 2a6 6 0 0 0-3.6 10.8A5.9 5.9 0 0 0 6 17v.5h2V17a3.2 3.2 0 0 1 2-3 4.6 4.6 0 0 1-1-2.8A3.9 3.9 0 0 1 12 7.2 3.9 3.9 0 0 1 15.2 11 4.6 4.6 0 0 1 14 13.9a3.2 3.2 0 0 1 2 3v.6h2V17a5.9 5.9 0 0 0-2.4-4.2A6 6 0 0 0 12 2zm0 4a2 2 0 1 0 2 2 2 2 0 0 0-2-2z"/><path d="M19 20.5 22 17h-6z"/></svg>`;
}

function chegadaSVG() {
  return `<svg class="maneuver-arrow maneuver-arrive-ic" viewBox="0 0 24 24" aria-hidden="true">` +
    `<path d="M4 2v20h2v-9h13l-1.5-5.5L19 2H6V2z"/><path d="M6 5h12l-.8 3H6.8z"/></svg>`;
}

function exibirInstrucao(index) {
  if (!currentSteps || index >= currentSteps.length) return;
  const step = currentSteps[index];
  const text = instrucaoTexto(step);
  instrTextEl.textContent = text;
  atualizarIconeManeuver(step);
  // Sub-título: próxima ação (passo seguinte), com distância até ela
  const prox = currentSteps[index + 1];
  instrDistEl.textContent = prox
    ? descricaoProximaAcao(prox, distanciaOrigemAoStep(prox, window.currentCoords))
    : 'Você chegará ao seu destino';
  ativarRota();
}

function ocultarInstrucao() {
  desativarRota();
}

/* ---- Controle do modo "rota ativa" (substitui a busca) ---- */
function ativarRota() {
  rotaAtiva = true;
  document.body.classList.add('rota-ativa');
  solicitarWakeLock();
}

function desativarRota() {
  rotaAtiva = false;
  document.body.classList.remove('rota-ativa');
  liberarWakeLock();
  // Volta a visão de cima ao encerrar a navegação
  if (map) {
    map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
  }
}

// Inicia uma nova rota
function novaRota() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();

  if (sourceRota) {
    try { map.removeLayer('rota-halo'); } catch (e) {}
    try { map.removeLayer('rota-linha'); } catch (e) {}
    try { map.removeSource('rota'); } catch (e) {}
    sourceRota = null;
  }

  currentSteps = [];
  currentStepIndex = 0;
  enunciadoPerto.clear();
  enunciado500.clear();
  enunciado200.clear();
  destinoSelecionado = null;
  removerDestinoMarker();
  currentRouteDistance = 0;
  currentRouteDuration = 0;

  // Reset do monitor anti-engarrafamento
  fecharAlerta();
  recalcEmProgresso = false;
  recalcCooldownAte = 0;
  ultimoTickMonitor = 0;
  tempoLentoAcum = 0;
  tempoParadoAcum = 0;
  standbyAtivo = false;
  janelaVel = [];

  etaTimeEl.textContent = '--:--';
  distKmEl.textContent = '0.0 km';
  chegadaHoraEl.textContent = '--:--';
  if (custoRotaEl) custoRotaEl.textContent = '--';
  desativarRota();

  inputDestino.value = '';
  setFollowMode(true);
  const pos = window.currentCoords;
  if (pos) {
    map.easeTo({
      center: [pos.lon, pos.lat],
      zoom: ZOOM_PARADO,
      pitch: 0,
      bearing: 0,
      duration: 800
    });
  }
  inputDestino.focus();
}

btnNovaRota.addEventListener('click', novaRota);

// Atualiza a instrução conforme o veículo avança
function atualizarInstrucao(origem) {
  if (!currentSteps.length) {
    ocultarInstrucao();
    return;
  }

  const proxIndex = Math.min(currentStepIndex + 1, currentSteps.length - 1);
  const proxPasso = currentSteps[proxIndex];
  const distAteStep = distanciaOrigemAoStep(proxPasso, origem);

  instrDistEl.textContent = descricaoProximaAcao(proxPasso, distAteStep);

  // Voz "Completa": anuncia a manobra a ~500 m e ~200 m (sem repetir ao passar)
  if (settings.freqVoz === 'completa' && proxIndex > currentStepIndex) {
    if (distAteStep <= 500 && distAteStep > 220 && !enunciado500.has(proxIndex)) {
      enunciado500.add(proxIndex);
      falarVoz(descricaoProximaAcao(proxPasso, distAteStep));
    } else if (distAteStep <= 200 && distAteStep >= 30 && !enunciado200.has(proxIndex)) {
      enunciado200.add(proxIndex);
      falarVoz(descricaoProximaAcao(proxPasso, distAteStep));
    }
  }

  if (distAteStep < 30 && proxIndex > currentStepIndex && !enunciadoPerto.has(proxIndex)) {
    enunciadoPerto.add(proxIndex);
    currentStepIndex = proxIndex;
    if (currentStepIndex < currentSteps.length - 1) {
      exibirInstrucao(currentStepIndex);
      falarVoz(instrucaoTexto(currentSteps[currentStepIndex]));
    } else {
      ocultarInstrucao();
      showFeedback('Você chegou ao destino!');
    }
  }
}

function distanciaOrigemAoStep(step, origem) {
  const geo = step.geometry || null;
  if (!geo || !geo.coordinates || !geo.coordinates.length) return Infinity;
  const c = geo.coordinates[0];
  return haversine(origem.lat, origem.lon, c[1], c[0]);
}

function falarVoz(texto) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(texto);
  u.lang = 'pt-BR';
  u.rate = 1.05;
  window.speechSynthesis.speak(u);
}

/* ---------- 8. GEOMETRIA/UTILITÁRIOS ADICIONAIS ---------- */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function formatarDistancia(metros) {
  if (metros >= 1000) return (metros / 1000).toFixed(1) + ' km';
  return Math.round(metros) + ' m';
}

function curta(m) {
  return Math.max(15, m);
}

/* ---------- 9. DESTINOS RECENTES (persistência) ---------- */
const CHAVE_RECENTES = 'flowpilot:recentes';

function carregarRecentes() {
  try {
    return JSON.parse(localStorage.getItem(CHAVE_RECENTES) || '[]');
  } catch (e) {
    return [];
  }
}

function salvarRecentes(lista) {
  try { localStorage.setItem(CHAVE_RECENTES, JSON.stringify(lista.slice(0, 8))); } catch (e) {}
}

function registrarDestinoRecente(dest) {
  if (!dest || !dest.nome) return;
  let lista = carregarRecentes().filter(r => r.nome !== dest.nome);
  lista.unshift({ nome: dest.nome, lat: dest.lat, lon: dest.lon });
  salvarRecentes(lista);
}

function exibirRecentes() {
  const lista = carregarRecentes();
  sugestoesEl.innerHTML = '';
  if (!lista.length) {
    hideSugestoes();
    return;
  }

  lista.forEach(r => {
    const item = document.createElement('div');
    item.className = 'sugestao-item recente';
    item.innerHTML = `<span class="recente-icone">🕘</span>${escapeHtml(r.nome)}`;
    item.addEventListener('click', () => {
      destinoSelecionado = { nome: r.nome, lat: r.lat, lon: r.lon };
      inputDestino.value = r.nome;
      hideSugestoes();
      tracarRota();
    });
    sugestoesEl.appendChild(item);
  });

  sugestoesEl.classList.add('visivel');
}

function escapeHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

inputDestino.addEventListener('focus', () => {
  if (!inputDestino.value.trim()) exibirRecentes();
});

/* ---------- 10. SIMULADOR DE ROTA (testar manobras sem dirigir) ---------- */
const VEL_SIM = 10;            // Velocidade base simulada (km/h)
const TICK_SIM_MS = 200;       // Intervalo do timer (ms)
const TICK_SEG = TICK_SIM_MS / 1000;
const FATORES_SIM = [1, 2, 4, 8]; // Multiplicadores do acelerador
let simulFator = 1;            // Fator atual do acelerador
let simulAtivo = false;        // Se a simulação está rodando
let simulTimer = null;         // Timer do setInterval
let simulDist = 0;             // Distância percorrida na simulação (m)

// Acelerador: alterna o multiplicador de velocidade (1x/2x/4x/8x)
btnSimulSpeed.addEventListener('click', () => {
  const i = FATORES_SIM.indexOf(simulFator);
  simulFator = FATORES_SIM[(i + 1) % FATORES_SIM.length];
  btnSimulSpeed.textContent = `${simulFator}x`;
  showFeedback(`Velocidade da simulação: ${simulFator}x`);
});

// Botão flutuante de simulação: alterna iniciar/parar
btnSimul.addEventListener('click', () => {
  if (simulAtivo) {
    pararSimulacao();
  } else {
    iniciarSimulacao();
  }
});

function iniciarSimulacao() {
  if (!currentRouteCoords || currentRouteCoords.length < 2) {
    showFeedback('Trace uma rota antes de simular.');
    return;
  }
  if (!rotaAtiva) ativarRota();

  simulAtivo = true;
  simulDist = 0;
  btnSimul.classList.add('ativo');

  // Interrompe o GPS real enquanto simula (evita conflito de posição)
  if (typeof watchId === 'number') {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  simulTimer = setInterval(avancarSimulacao, TICK_SIM_MS);
}

function pararSimulacao() {
  simulAtivo = false;
  if (simulTimer) {
    clearInterval(simulTimer);
    simulTimer = null;
  }
  btnSimul.classList.remove('ativo');
  // Retoma o GPS real para continuar a navegação
  startGPSTracking();
}

function avancarSimulacao() {
  const velKmh = VEL_SIM * simulFator;
  const passoMetros = (velKmh / 3.6) * TICK_SEG;
  simulDist += passoMetros;

  const p = pontoNaRota(currentRouteCoords, simulDist);
  atualizarPosicaoVeiculo(p.lat, p.lon, p.fim ? 0 : velKmh, p.heading);

  if (p.fim) {
    pararSimulacao();
    showFeedback('Simulação concluída! Você chegou ao destino.');
  }
}

// Calcula o rumo (heading) entre dois pontos [lon, lat]
function calcBearing(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const toDeg = (x) => (x * 180) / Math.PI;
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Interpola a posição a `d` metros do início da rota (coords [lon, lat])
function pontoNaRota(coords, d) {
  let acumulado = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const seg = haversine(a[1], a[0], b[1], b[0]);
    if (acumulado + seg >= d) {
      const f = (seg > 0) ? (d - acumulado) / seg : 0;
      return {
        lat: a[1] + (b[1] - a[1]) * f,
        lon: a[0] + (b[0] - a[0]) * f,
        heading: calcBearing(a, b),
        fim: false
      };
    }
    acumulado += seg;
  }
  const ult = coords[coords.length - 1];
  return { lat: ult[1], lon: ult[0], heading: lastHeading, fim: true };
}

/* ---------- 11. SCREEN WAKE LOCK (tela nunca apaga na navegação) ---------- */
async function solicitarWakeLock() {
  if (!settings.manterTelaLigada) return; // toggle "Manter tela ligada" desligado
  if (!('wakeLock' in navigator)) return;
  if (wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) {
    console.warn('Wake Lock indisponível:', e);
  }
}

function liberarWakeLock() {
  if (!wakeLock) return;
  try { wakeLock.release(); } catch (e) {}
  wakeLock = null;
}

// O navegador libera o lock ao ocultar a aba; re-adquire ao voltar, se ainda navegando
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && rotaAtiva && !wakeLock) {
    solicitarWakeLock();
  }
});

/* ---------- 12. CAMADA DE TRÁFEGO EM TEMPO REAL (TomTom) ---------- */
function obterTomtomKey() {
  // Prioridade: chave digitada na UI (localStorage) > config.local.js (não versionado)
  try {
    const salva = localStorage.getItem(CHAVE_TOMTOM);
    if (salva) return salva;
  } catch (e) {}
  if (window.TOMTOM_KEY) return window.TOMTOM_KEY;
  return '';
}

// Botão 🚦: liga/desliga a camada visual de tráfego
function toggleTraffic() {
  if (trafficAtivo) {
    desativarTraffic();
    return;
  }
  let key = obterTomtomKey();
  if (!key) {
    key = prompt('Informe a chave de API TomTom (Traffic Flow, free tier). Ela será salva somente neste dispositivo:');
    if (!key) { showFeedback('Ativação de tráfego cancelada.'); return; }
    key = key.trim();
    if (!key) return;
    try { localStorage.setItem(CHAVE_TOMTOM, key); } catch (e) {}
  }
  ativarTraffic(key);
}

// Adiciona os raster tiles de fluxo de tráfego sobre o basemap (abaixo da rota)
function ativarTraffic(key, silencioso = false) {
  if (!map) return;
  try { map.removeLayer('tomtom-traffic-layer'); } catch (e) {}
  try { map.removeSource('tomtom-traffic'); } catch (e) {}

  map.addSource('tomtom-traffic', {
    type: 'raster',
    tiles: [TOMTOM_TRAFFIC_TILES.replace('{KEY}', encodeURIComponent(key))],
    tileSize: 256,
    minzoom: 0,
    maxzoom: 21,
    scheme: 'xyz',
    attribution: 'TomTom'
  });

  // Insere abaixo da rota para não cobrir a linha azul
  const antesDe = sourceRota ? 'rota-halo' : undefined;
  map.addLayer({
    id: 'tomtom-traffic-layer',
    type: 'raster',
    source: 'tomtom-traffic',
    layout: { visibility: 'visible' },
    paint: {
      'raster-opacity': 0.55,
      'raster-fade-duration': 0,
      'raster-resampling': 'linear'
    }
  }, antesDe);

  trafficAtivo = true;
  btnTraffic.classList.add('ativo');
  if (!silencioso) showFeedback('Tráfego em tempo real (TomTom) ativado.');
}

function desativarTraffic() {
  try { map.removeLayer('tomtom-traffic-layer'); } catch (e) {}
  try { map.removeSource('tomtom-traffic'); } catch (e) {}
  trafficAtivo = false;
  btnTraffic.classList.remove('ativo');
  showFeedback('Tráfego desativado.');
}

btnTraffic.addEventListener('click', toggleTraffic);

/* ---------- 13. RECÁLCULO ANTI-ENGARRAMENTO (com economia de cota) ---------- */
// Chamado a cada atualização de posição (GPS ou simulador) durante a rota
function monitorarEngarrafamento(vel, pos) {
  if (!rotaAtiva || !destinoSelecionado || !map) return;
  const agora = Date.now();
  const dt = ultimoTickMonitor ? Math.min((agora - ultimoTickMonitor) / 1000, 2) : 0;
  if (dt <= 0) { ultimoTickMonitor = agora; return; }
  ultimoTickMonitor = agora;

  // Filtro de stand-by: parado > 2 min suspende recálculo e uso de tráfego
  if (vel < 1) {
    tempoParadoAcum += dt;
    tempoLentoAcum = 0;
    if (tempoParadoAcum >= STANDBY_LIMITE_S) standbyAtivo = true;
  } else {
    tempoParadoAcum = 0;
    if (standbyAtivo && vel >= 5) standbyAtivo = false;
    if (standbyAtivo) { tempoLentoAcum = 0; return; }
  }
  if (standbyAtivo) return;

  // Janela deslizante de velocidades (1 min) para reconhecer via rápida
  janelaVel.push({ t: agora, v: vel });
  const JANELA_MS = 60000;
  while (janelaVel.length && agora - janelaVel[0].t > JANELA_MS) janelaVel.shift();

  if (recalcEmProgresso || agora < recalcCooldownAte) {
    if (vel >= VELOCIDADE_LENTA) tempoLentoAcum = 0;
    return;
  }

  const desvio = distanciaDoVeiculoARota(pos.lat, pos.lon);

  // Trava por distância: recálculo de desvio só acima de 30 m da rota
  if (desvio > DESVIO_LIMITE_M) {
    recalcCooldownAte = agora + COOLDOWN_RECALC_MS;
    consultarRotaAlternativa();
    return;
  }

  // Anti-engarrafamento: < 12 km/h por 40 s em trecho de via rápida (na rota)
  if (vel < VELOCIDADE_LENTA) {
    if (velocidadeReferencia() >= VELOCIDADE_VIA_RAPIDA) {
      tempoLentoAcum += dt;
      if (tempoLentoAcum >= TEMPO_LENTO_LIMITE_S) {
        tempoLentoAcum = 0;
        recalcCooldownAte = agora + COOLDOWN_RECALC_MS;
        consultarRotaAlternativa();
      }
    } else {
      tempoLentoAcum = 0;
    }
  } else {
    tempoLentoAcum = 0;
  }
}

// Média dos últimos 60 s considerando apenas amostras em movimento (≥ 12 km/h)
function velocidadeReferencia() {
  const ms = janelaVel.filter((e) => e.v >= VELOCIDADE_LENTA);
  if (!ms.length) return 0;
  return ms.reduce((s, e) => s + e.v, 0) / ms.length;
}

// Distância perpendicular do veículo à polilinha da rota (metros)
function distanciaDoVeiculoARota(lat, lon) {
  const coords = currentRouteCoords;
  if (!coords || coords.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = projetarPontoNoSegmento(lat, lon, coords[i], coords[i + 1]).dist;
    if (d < min) min = d;
  }
  return min;
}

// Duração restante estimada da rota atual
function duracaoRestanteAtual() {
  const pos = window.currentCoords;
  if (!pos || !currentRouteDistance || !currentRouteCoords) return currentRouteDuration;
  const frac = Math.min(1, distRestanteRota(pos.lat, pos.lon) / currentRouteDistance);
  return Math.max(0, currentRouteDuration * frac);
}

// Consulta silenciosa de rota alternativa (alternatives=true numa única chamada)
function consultarRotaAlternativa() {
  const origem = window.currentCoords;
  const dest = destinoSelecionado;
  if (!origem || !dest) return;

  recalcEmProgresso = true;
  const url =
    `https://router.project-osrm.org/route/v1/${perfilRoteamento()}/` +
    `${origem.lon},${origem.lat};${dest.lon},${dest.lat}` +
    `?overview=full&geometries=geojson&steps=true&alternatives=true`;

  fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then((data) => {
      if (data.code !== 'Ok' || !data.routes || data.routes.length < 2) return;
      const atual = duracaoRestanteAtual();
      // Escolhe a alternativa que economiza mais de 2 minutos
      let melhor = null;
      for (let i = 1; i < data.routes.length; i++) {
        const r = data.routes[i];
        if (r.duration < atual - GANHO_MINIMO_S) {
          if (!melhor || r.duration < melhor.duration) melhor = r;
        }
      }
      if (melhor) exibirAlertaNovaRota(atual - melhor.duration, melhor);
    })
    .catch((err) => console.error('Erro no recálculo OSRM:', err))
    .finally(() => { recalcEmProgresso = false; });
}

// Alerta visual + sonoro com troca automática após 5 s (ou toque para alternar)
function exibirAlertaNovaRota(economizado, rota) {
  if (alertaEmAberto || !trafficAlertEl) return;
  alertaEmAberto = true;

  const min = Math.max(1, Math.round(economizado / 60));
  const msg = `Nova rota mais rápida (-${min} min)! Tocando para alternar...`;
  trafficAlertEl.textContent = msg;
  trafficAlertEl.classList.add('visivel');
  falarVoz(msg);

  alertaHandler = () => {
    fecharAlerta();
    processarRota(rota);
  };
  trafficAlertEl.addEventListener('click', alertaHandler);
  alertaTimer = setTimeout(alertaHandler, 5000);
}

function fecharAlerta() {
  alertaEmAberto = false;
  if (alertaTimer) { clearTimeout(alertaTimer); alertaTimer = null; }
  if (alertaHandler) {
    trafficAlertEl.removeEventListener('click', alertaHandler);
    alertaHandler = null;
  }
  trafficAlertEl.classList.remove('visivel');
}

/* ---------- 14. HODÔMETRO CUMULATIVO + MANUTENÇÃO ---------- */
const fmtKm = (n) => Math.round(n).toLocaleString('pt-BR') + ' km';

function numeroOu(v, def) {
  const n = parseFloat(v);
  return isFinite(n) ? n : def;
}

function carregarHodometro() {
  try {
    kmAtualVeiculo = numeroOu(localStorage.getItem(CHAVE_KM_ATUAL), 0);
    intervaloTrocaOleo = Math.max(0, numeroOu(localStorage.getItem(CHAVE_INTERVALO), 0));
    const t = parseFloat(localStorage.getItem(CHAVE_KM_TROCA));
    kmUltimaTrocaOleo = isFinite(t) ? t : kmAtualVeiculo;
  } catch (e) {}
}

function salvarKmAtual() {
  try { localStorage.setItem(CHAVE_KM_ATUAL, String(kmAtualVeiculo)); } catch (e) {}
}

function salvarIntervalo() {
  try { localStorage.setItem(CHAVE_INTERVALO, String(intervaloTrocaOleo)); } catch (e) {}
}

function salvarKmTroca() {
  try { localStorage.setItem(CHAVE_KM_TROCA, String(kmUltimaTrocaOleo)); } catch (e) {}
}

// Acumula deslocamento real (km) no hodômetro. Exclui o simulador e ignora
// ruído (< 0,5 m) e saltos absurdos do GPS (> 200 m entre atualizações).
function acumularHodometro(latitude, longitude, velocidadeKmh) {
  if (simulAtivo) {
    odomPosAnterior = { lat: latitude, lon: longitude };
  } else if (velocidadeKmh > 2 && odomPosAnterior) {
    const d = haversine(odomPosAnterior.lat, odomPosAnterior.lon, latitude, longitude);
    if (d > 0.5 && d < 200) {
      kmAtualVeiculo += d;
      tripAKm += d;
      salvarKmAtual();
      salvarTripA();
    }
  }
  odomPosAnterior = { lat: latitude, lon: longitude };
  atualizarPainelManutencao();
}

// Atualiza o strip: odômetro total + óleo + Trip A (amarelo <10% / vermelho)
function atualizarPainelManutencao() {
  if (!kmOdometroEl || !oleoStatusEl) return;
  kmOdometroEl.textContent = fmtKm(kmAtualVeiculo);
  if (kmTripAEl) kmTripAEl.textContent = fmtKm(tripAKm);
  if (cfgTripAValor) cfgTripAValor.textContent = fmtKm(tripAKm);

  oleoStatusEl.classList.remove('alerta-amarelo', 'alerta-vermelho');

  if (!intervaloTrocaOleo) {
    oleoInfoEl.textContent = 'intervalo não configurado';
    return;
  }

  const desdeTroca = kmAtualVeiculo - kmUltimaTrocaOleo;
  const faltaRestante = intervaloTrocaOleo - desdeTroca;
  const pct = desdeTroca / intervaloTrocaOleo;
  const base = `usado ${fmtKm(desdeTroca)} · falta ${fmtKm(Math.max(0, faltaRestante))}`;

  if (pct >= 1) {
    oleoInfoEl.textContent = `usado ${fmtKm(desdeTroca)} · TROQUE O ÓLEO!`;
    oleoStatusEl.classList.add('alerta-vermelho');
  } else if (pct >= 0.9) {
    oleoInfoEl.textContent = base;
    oleoStatusEl.classList.add('alerta-amarelo');
  } else {
    oleoInfoEl.textContent = base;
  }
}

/* ---------- 15. CENTRAL DE CONFIGURAÇÕES E PERSONALIZAÇÃO ---------- */
// Perfil OSRM conforme o tipo de veículo (driving / cycling)
function perfilRoteamento() {
  const map = { moto: 'driving', carro: 'driving', bicicleta: 'cycling' };
  return map[settings.veiculo] || 'driving';
}

// Custo (R$) do trecho restante da rota com base no consumo e no combustível
function calcularCusto(distM) {
  if (settings.consumo <= 0 || settings.precoCombustivel <= 0) return '--';
  const valor = (distM / 1000) / settings.consumo * settings.precoCombustivel;
  if (!isFinite(valor) || valor <= 0) return '--';
  return 'R$ ' + valor.toFixed(2).replace('.', ',');
}

// Bipe curto de alerta (WebAudio, sem arquivo de áudio)
function bipAlerta() {
  try {
    if (!ctxAudio) ctxAudio = new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < 2; i++) {
      const osc = ctxAudio.createOscillator();
      const gain = ctxAudio.createGain();
      const t = ctxAudio.currentTime + i * 0.18;
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.14, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      osc.connect(gain);
      gain.connect(ctxAudio.destination);
      osc.start(t);
      osc.stop(t + 0.16);
    }
  } catch (e) {}
}

// Carrega as configurações do localStorage (flowpilot_settings) + Trip A
function carregarSettings() {
  try {
    const raw = localStorage.getItem(CHAVE_SETTINGS);
    if (raw) settings = Object.assign({}, settings, JSON.parse(raw));
  } catch (e) {}
  tripAKm = numeroOu(localStorage.getItem(CHAVE_TRIP_A), 0);
}

function salvarSettings() {
  try { localStorage.setItem(CHAVE_SETTINGS, JSON.stringify(settings)); } catch (e) {}
}

function salvarTripA() {
  try { localStorage.setItem(CHAVE_TRIP_A, String(tripAKm)); } catch (e) {}
}

// Reflete as configurações na interface (tema AMOLED, velocímetro, custo)
function aplicarSettings() {
  document.documentElement.classList.toggle('amoled', !!settings.amoled);
  atualizarCorVelocimetro(ultimaVelocidade);
  if (window.currentCoords) atualizarTelemetria(window.currentCoords);
}

// Preenche os campos do modal com o estado atual
function preencherModalConfig() {
  cfgTipoVeiculo.value = settings.veiculo;
  cfgConsumo.value = settings.consumo || '';
  cfgPrecoCombustivel.value = settings.precoCombustivel || '';
  cfgVelMax.value = settings.velMaxima || '';
  cfgFreqVoz.value = settings.freqVoz;
  cfgAmoled.checked = !!settings.amoled;
  cfgTelaLigada.checked = !!settings.manterTelaLigada;
  cfgKmAtual.value = Math.round(kmAtualVeiculo) || '';
  cfgIntervalo.value = intervaloTrocaOleo || '';
  if (cfgTripAValor) cfgTripAValor.textContent = fmtKm(tripAKm);
}

// Abre/fecha o modal de configurações
function abrirConfiguracoes() {
  preencherModalConfig();
  settingsModalEl.classList.add('visivel');
}

/* ---- Abertura/fechamento ---- */
btnSettings.addEventListener('click', abrirConfiguracoes);
btnFecharConfig.addEventListener('click', () => settingsModalEl.classList.remove('visivel'));
settingsModalEl.addEventListener('click', (e) => {
  if (e.target === settingsModalEl) settingsModalEl.classList.remove('visivel');
});

/* ---- Perfil do veículo e custos ---- */
cfgTipoVeiculo.addEventListener('change', () => {
  settings.veiculo = cfgTipoVeiculo.value;
  salvarSettings();
  const nomes = { moto: 'Moto', carro: 'Carro', bicicleta: 'Bicicleta' };
  showFeedback('Perfil de rota: ' + (nomes[settings.veiculo] || settings.veiculo) + '.', 'ok');
});

cfgConsumo.addEventListener('change', () => {
  const v = parseFloat(cfgConsumo.value);
  settings.consumo = isFinite(v) && v >= 0 ? v : 0;
  salvarSettings();
  aplicarSettings();
});

cfgPrecoCombustivel.addEventListener('change', () => {
  const v = parseFloat(cfgPrecoCombustivel.value);
  settings.precoCombustivel = isFinite(v) && v >= 0 ? v : 0;
  salvarSettings();
  aplicarSettings();
});

/* ---- Alertas de velocidade e voz ---- */
cfgVelMax.addEventListener('change', () => {
  const v = parseFloat(cfgVelMax.value);
  settings.velMaxima = isFinite(v) && v >= 0 ? v : 0;
  salvarSettings();
  aplicarSettings();
});

cfgFreqVoz.addEventListener('change', () => {
  settings.freqVoz = cfgFreqVoz.value === 'minima' ? 'minima' : 'completa';
  salvarSettings();
});

/* ---- Energia, tela e tema ---- */
cfgAmoled.addEventListener('change', () => {
  settings.amoled = cfgAmoled.checked;
  salvarSettings();
  aplicarSettings();
});

cfgTelaLigada.addEventListener('change', () => {
  settings.manterTelaLigada = cfgTelaLigada.checked;
  salvarSettings();
  if (settings.manterTelaLigada) {
    if (rotaAtiva) solicitarWakeLock();
  } else {
    liberarWakeLock();
  }
});

/* ---- Manutenção / hodômetro ---- */
cfgKmAtual.addEventListener('change', () => {
  const v = parseFloat(cfgKmAtual.value);
  if (isFinite(v) && v >= 0) {
    kmAtualVeiculo = v;
    salvarKmAtual();
    atualizarPainelManutencao();
    showFeedback('KM atual do veículo ajustado.', 'ok');
  } else if (cfgKmAtual.value !== '') {
    showFeedback('Valor inválido para o KM atual.');
  }
});

cfgIntervalo.addEventListener('change', () => {
  const v = parseFloat(cfgIntervalo.value);
  if (isFinite(v) && v >= 0) {
    intervaloTrocaOleo = v;
    salvarIntervalo();
    atualizarPainelManutencao();
  } else if (cfgIntervalo.value !== '') {
    showFeedback('Valor inválido para o intervalo.');
  }
});

btnRegistrarTroca.addEventListener('click', () => {
  kmUltimaTrocaOleo = kmAtualVeiculo;
  salvarKmTroca();
  atualizarPainelManutencao();
  showFeedback('Troca de óleo registrada!', 'ok');
});

btnResetTrip.addEventListener('click', () => {
  tripAKm = 0;
  salvarTripA();
  atualizarPainelManutencao();
  showFeedback('Trip A zerada!', 'ok');
});

/* ---- Backup: exportar / importar JSON ---- */
function dadosBackup() {
  return {
    app: 'FlowPilot',
    versao: 1,
    exportadoEm: new Date().toISOString(),
    settings: settings,
    odometro: {
      kmAtualVeiculo,
      intervaloTrocaOleo,
      kmUltimaTrocaOleo,
      tripAKm
    },
    tomtomKey: obterTomtomKey() || undefined
  };
}

btnExportar.addEventListener('click', () => {
  try {
    const blob = new Blob([JSON.stringify(dadosBackup(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'flowpilot-config-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    showFeedback('Configurações exportadas!', 'ok');
  } catch (e) {
    showFeedback('Não foi possível exportar.');
  }
});

btnImportar.addEventListener('click', () => cfgArquivoImport.click());

cfgArquivoImport.addEventListener('change', (e) => {
  const arquivo = e.target.files && e.target.files[0];
  if (!arquivo) return;
  const leitor = new FileReader();
  leitor.onload = () => {
    try {
      aplicarImportacao(JSON.parse(leitor.result));
      showFeedback('Configurações restauradas!', 'ok');
    } catch (err) {
      console.error('Import inválido:', err);
      showFeedback('Arquivo de configuração inválido.');
    }
  };
  leitor.readAsText(arquivo);
  e.target.value = '';
});

function aplicarImportacao(d) {
  if (!d || typeof d !== 'object') throw new Error('sem dados');
  if (d.settings) settings = Object.assign({}, settings, d.settings);
  if (d.odometro) {
    const o = d.odometro;
    if (isFinite(o.kmAtualVeiculo)) kmAtualVeiculo = o.kmAtualVeiculo;
    if (isFinite(o.intervaloTrocaOleo)) intervaloTrocaOleo = Math.max(0, o.intervaloTrocaOleo);
    if (isFinite(o.kmUltimaTrocaOleo)) kmUltimaTrocaOleo = o.kmUltimaTrocaOleo;
    if (isFinite(o.tripAKm)) tripAKm = o.tripAKm;
  }
  if (d.tomtomKey) {
    try { localStorage.setItem(CHAVE_TOMTOM, d.tomtomKey); } catch (e) {}
  }
  salvarSettings();
  salvarKmAtual();
  salvarIntervalo();
  salvarKmTroca();
  salvarTripA();
  preencherModalConfig();
  aplicarSettings();
  atualizarPainelManutencao();
}

// Boot: carrega settings + manutenção e pinta a interface
carregarSettings();
carregarHodometro();
aplicarSettings();
atualizarPainelManutencao();

/* ---------- Inicialização ---------- */
document.addEventListener('DOMContentLoaded', initMap);
