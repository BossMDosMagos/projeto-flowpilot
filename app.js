/* ============================================
   FLOWPILOT - Navegação GPS em tempo real (MapLibre GL)
   Stack: MapLibre GL + CartoDB Dark Matter + OSRM público
   ============================================ */

/* ---------- Estado global ---------- */
let map = null;              // Instância do MapLibre
let vehicleMarker = null;    // Marcador do veículo (MapLibre Marker)
let sourceRota = null;       // Fonte GeoJSON da rota
let currentRouteCoords = null; // Coordenadas da rota ativa (para re-desenho ao trocar tema)
let rotaAtiva = false;       // Se há uma rota em andamento (substitui a busca)
let destinoSelecionado = null; // {lon, lat, nome}
let followMode = true;       // Se o mapa segue automaticamente o veículo
let temaEscuro = true;       // Tema atual (Dark Matter escuro por padrão)
let lastHeading = 0;         // Último rumo (heading) do GPS
let currentSteps = [];       // Passos da rota atual (com geometrias)
let currentStepIndex = 0;    // Índice da instrução atual
let enunciadoPerto = new Set(); // Passos já anunciados por voz
let touchManipulado = false; // Se o usuário manipulou o mapa manualmente

// Referências de elementos DOM
const $ = (id) => document.getElementById(id);
const inputDestino = $('destino-input');
const btnIniciar = $('iniciar-rota-btn');
const btnLocate = $('locate-btn');
const btnTheme = $('theme-btn');
const btnNovaRota = $('nova-rota-btn');
const sugestoesEl = $('sugestoes');
const velocimetroEl = $('velocimetro');
const etaTimeEl = $('eta-time');
const distKmEl = $('dist-km');
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

/* ---------- 3. GPS EM TEMPO REAL (watchPosition) ---------- */
function startGPSTracking() {
  if (!navigator.geolocation) {
    console.error('Geolocalização não suportada');
    alert('Geolocalização não suportada no seu navegador.');
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const { latitude, longitude, speed, heading } = position.coords;
      const pos = [longitude, latitude];

      // Move o marcador do veículo
      if (vehicleMarker) vehicleMarker.setLngLat(pos);

      const velocidade = (typeof speed === 'number' && !isNaN(speed)) ? speed * 3.6 : 0;

      // Guarda heading para navegação
      if (typeof heading === 'number' && !isNaN(heading)) lastHeading = heading;

      // Atualiza o velocímetro
      velocimetroEl.textContent = Math.round(velocidade);
      atualizarCorVelocimetro(Math.round(velocidade));

      // Guarda posição para roteamento
      window.currentCoords = { lat: latitude, lon: longitude };

      // Atualiza a instrução de navegação conforme avança
      atualizarInstrucao(window.currentCoords);

      // Segue o veículo (com pitch/bearing no modo rota)
      if (followMode) {
        acompanharVeiculo(pos, velocidade, heading);
      }

      // Zoom automático 17/18 quando em movimento (durante navegação)
      if (rotaAtiva && followMode && velocidade > 5) {
        if (map.getZoom() < 17) {
          map.easeTo({ zoom: Math.min(18, Math.max(map.getZoom(), 17)), duration: 800 });
        }
      }
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

  debounceTimer = setTimeout(() => buscarEndereco(query), 400);
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
    `https://router.project-osrm.org/route/v1/driving/` +
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

      const route = data.routes[0];
      desenharRota(route.geometry.coordinates);

      // Guarda os passos para navegação
      if (route.legs && route.legs[0] && route.legs[0].steps) {
        currentSteps = route.legs[0].steps;
        currentStepIndex = 0;
        enunciadoPerto.clear();
        exibirInstrucao(0);
        falarVoz(instrucaoTexto(currentSteps[0]));
      } else {
        currentSteps = [];
        ocultarInstrucao();
      }

      const minutos = Math.max(1, Math.round(route.duration / 60));
      const km = (route.distance / 1000).toFixed(1);

      registrarDestinoRecente(destinoSelecionado);

      etaTimeEl.textContent = formatarETA(minutos);
      distKmEl.textContent = `${km} km`;

      // Ativa o modo rota (perspectiva 3D + rotação)
      ativarRota();
      destacarRota();
    })
    .catch(err => {
      console.error('Erro no OSRM:', err);
      showFeedback('Não foi possível calcular a rota. Tente novamente.');
    });
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

// Cor do velocímetro conforme velocidade
function atualizarCorVelocimetro(kmh) {
  const speedValue = document.querySelector('.speed-value');
  const speedUnit = document.querySelector('.speed-unit');
  if (!speedValue) return;

  const cor =
    kmh >= 90 ? '#ef4444' :
    kmh >= 60 ? '#f59e0b' :
                 '#22c55e';
  speedValue.style.color = cor;
  if (speedUnit) speedUnit.style.color = cor;
  speedValue.style.textShadow = `0 0 12px ${cor}80`;
}

// Feedback flutuante
function showFeedback(msg) {
  const existing = document.getElementById('flowpilot-feedback');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.id = 'flowpilot-feedback';
  div.textContent = msg;
  div.style.cssText = `
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
    z-index: 2000; background: #ef4444; color: #fff; padding: 12px 20px;
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

/* ---- ÍCONE DE MANOBRA DINÂMICO ----
   Se a instrução/texto contiver "esquerda", mostra seta para a esquerda;
   se contiver "direita", mostra seta para a direita. Usa o texto gerado
   para decidir, e recorre ao modifier do OSRM quando não houver texto. */
function iconeManeuver(type, modifier, texto) {
  // Fim de rota
  if (type === 'arrive') return '🏁';
  if (type === 'depart') return '⬆️';

  // Prioridade: analisa o texto gerado (mais robusto)
  const t = (texto || '').toLowerCase();
  if (t.includes('esquerda:') || t.includes(' à esquerda') || t.includes('esquerda')) {
    return direcaoDaSeta(t, 'esquerda');
  }
  if (t.includes('direita') || t.includes(' à direita')) {
    return direcaoDaSeta(t, 'direita');
  }
  if (t.includes('retorno') || t.includes('inversão') || modifier === 'uturn') return '↩️';
  if (t.includes('rotatória') || type === 'roundabout' || type === 'rotary') return '🔄';

  // Fallback pelo modifier
  switch (modifier) {
    case 'left': return '⬅️';
    case 'right': return '➡️';
    case 'slight left': return '↖️';
    case 'slight right': return '↗️';
    case 'sharp left': return '↙️';
    case 'sharp right': return '↘️';
    case 'uturn': return '↩️';
    case 'straight': return '⬆️';
    default: return '⬆️';
  }
}

// Escolhe a seta mais específica com base na intensidade da manobra
function direcaoDaSeta(texto, lado) {
  const levemente =
    (lado === 'esquerda' && texto.includes('levemente')) ||
    (lado === 'direita' && texto.includes('levemente'));
  const brusco =
    (lado === 'esquerda' && texto.includes('bruscamente')) ||
    (lado === 'direita' && texto.includes('bruscamente'));

  if (levemente) return lado === 'esquerda' ? '↖️' : '↗️';
  if (brusco) return lado === 'esquerda' ? '↙️' : '↘️';
  return lado === 'esquerda' ? '⬅️' : '➡️';
}

function exibirInstrucao(index) {
  if (!currentSteps || index >= currentSteps.length) return;
  const step = currentSteps[index];
  const text = instrucaoTexto(step);
  instrTextEl.textContent = text;
  instrManeuverEl.textContent = iconeManeuver(
    step.maneuver.type,
    step.maneuver.modifier,
    text
  );
  instrDistEl.textContent = 'Próxima manobra: ' + formatarDistancia(curta(step.distance));
  ativarRota();
}

function ocultarInstrucao() {
  desativarRota();
}

/* ---- Controle do modo "rota ativa" (substitui a busca) ---- */
function ativarRota() {
  rotaAtiva = true;
  document.body.classList.add('rota-ativa');
}

function desativarRota() {
  rotaAtiva = false;
  document.body.classList.remove('rota-ativa');
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
  destinoSelecionado = null;

  etaTimeEl.textContent = '--:--';
  distKmEl.textContent = '0.0 km';
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

  instrDistEl.textContent = 'Próxima manobra: ' + formatarDistancia(distAteStep);

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

/* ---------- Inicialização ---------- */
document.addEventListener('DOMContentLoaded', initMap);
