/* ============================================
   FLOWPILOT - Navegação GPS em tempo real (Leaflet)
   Stack: Leaflet.js + OpenStreetMap + OSRM público
   ============================================ */

/* ---------- Estado global ---------- */
let map = null;              // Instância do Leaflet map
let vehicleMarker = null;    // Marcador do veículo do motorista
let routeLayer = null;       // Camada da rota (Polyline)
let routeLayer2 = null;      // Camada de halo/contorno da rota
let watchId = null;          // ID do watchPosition
let destinoSelecionado = null; // {lon, lat, nome}
let followMode = true;       // Se o mapa segue automaticamente o veículo
let lastHeading = 0;         // Último rumo (heading) do GPS
let currentSteps = [];       // Passos da rota atual (com geometrias)
let currentStepIndex = 0;    // Índice da instrução atual
let enunciadoPerto = new Set(); // Passos já anunciados por voz (evita repetição)
let rotaAtiva = false;       // Se há uma rota em andamento (substitui a busca)

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

/* ---------- 1. INICIALIZAÇÃO DO MAPA ---------- */
function initMap() {
  // Coordenada padrão: São Paulo (alternativa: Rio de Janeiro -23.55, -46.63)
  const defaultCoords = [-23.5505, -46.6333];

  map = L.map('map', {
    center: defaultCoords,
    zoom: 15, // Nível adequado para navegação urbana
    zoomControl: false // Interface clean, sem controles poluentes
  });

  // Camada de tiles - OpenStreetMap padrão (100% gratuito, sem API key)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    maxNativeZoom: 19
  }).addTo(map);

  // Criar marcador do veículo (posição inicial padrão)
  vehicleMarker = createVehicleMarker(defaultCoords);

  // Se o usuário arrastar o mapa manualmente, desativa o follow automático
  map.on('dragstart', () => setFollowMode(false));

  // Botão flutuante: centraliza novamente no veículo e reativa o follow
  btnLocate.addEventListener('click', () => {
    const pos = window.currentCoords;
    if (pos) {
      map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), 15), { animate: true });
    }
    setFollowMode(true);
  });

  // Modo noturno: carrega a preferência salva e configura a alternância
  aplicarTemaSalvo();
  btnTheme.addEventListener('click', () => {
    const noturno = !document.body.classList.contains('noturno');
    document.body.classList.toggle('noturno', noturno);
    try { localStorage.setItem('flowpilot:tema', String(noturno)); } catch (e) {}
  });

  // Iniciar rastreamento GPS em tempo real
  startGPSTracking();
}

// Liga/desliga o modo de "seguir o veículo"
function setFollowMode(ativo) {
  followMode = ativo;
  btnLocate.classList.toggle('active', ativo);
}

// Aplica o tema salvo (padrão diurno)
function aplicarTemaSalvo() {
  let noturno = false;
  try { noturno = localStorage.getItem('flowpilot:tema') === 'true'; } catch (e) {}
  document.body.classList.toggle('noturno', noturno);
}

/* ---------- 2. MARCADOR PERSONALIZADO DO VEÍCULO ---------- */
function createVehicleMarker(coords) {
  const icon = L.divIcon({
    className: '',
    html: '<div class="vehicle-marker"><span class="vehicle-arrow"></span></div>',
    iconSize: [46, 46],
    iconAnchor: [23, 23]
  });

  const marker = L.marker(coords, {
    icon: icon,
    zIndexOffset: 1000
  }).addTo(map);

  // Tooltip com o nome do app
  marker.bindTooltip('FlowPilot', {
    className: 'vehicle-label',
    direction: 'top',
    offset: [0, -20]
  });

  return marker;
}

/* ---------- 3. GPS EM TEMPO REAL (watchPosition) ---------- */
function startGPSTracking() {
  if (!navigator.geolocation) {
    console.error('❌ Geolocalização não suportada');
    alert('Geolocalização não suportada no seu navegador.');
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const { latitude, longitude, speed, heading } = position.coords;
      const coords = [latitude, longitude];

      // Move o marcador do veículo para a posição atual
      vehicleMarker.setLatLng(coords);

      // Gira a seta do veículo apontando para o rumo (heading)
      if (typeof heading === 'number' && !isNaN(heading)) {
        lastHeading = heading;
        const arrow = vehicleMarker.getElement()?.querySelector('.vehicle-arrow');
        if (arrow) {
          arrow.style.transform = `rotate(${heading}deg)`;
        }
      }

      // Só centraliza o mapa se o modo follow estiver ativado
      if (followMode) {
        map.setView(coords, map.getZoom(), { animate: true });
      }

      // Atualiza o velocímetro: speed vem em m/s, converter para km/h
      if (typeof speed === 'number' && !isNaN(speed)) {
        const kmh = Math.round(speed * 3.6);
        velocimetroEl.textContent = kmh;
        atualizarCorVelocimetro(kmh);
      } else {
        velocimetroEl.textContent = '0';
        atualizarCorVelocimetro(0);
      }

      // Guarda a posição mais recente para roteamento
      window.currentCoords = { lat: latitude, lon: longitude };

      // Atualiza a instrução de navegação conforme o veículo avança
      atualizarInstrucao(window.currentCoords);
    },
    (error) => {
      console.error('❌ Erro de GPS:', error);
      // Tratamento amigável de cada tipo de erro
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
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000
    }
  );
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

  // Debounce de 400ms para não sobrecarregar a API
  debounceTimer = setTimeout(() => buscarEndereco(query), 400);
});

// Consulta ao Nominatim, regionalizada ao Brasil (rápida e gratuita)
function buscarEndereco(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&countrycodes=br&bounded=1`;

  fetch(url)
    .then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(exibirSugestoes)
    .catch(err => {
      console.error('❌ Erro na busca Nominatim:', err);
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
  // Precisa de um destino selecionado (via sugestão)
  if (!destinoSelecionado) {
    showFeedback('Selecione um destino na lista de sugestões.');
    return;
  }

  // Precisa da posição atual do motorista (ou usa default)
  const origem = window.currentCoords || { lon: -46.6333, lat: -23.5505 };

  // Monta a URL do OSRM público (endpoint de direção)
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

      // Guarda os passos (instruções) para navegação passo-a-passo
      if (route.legs && route.legs[0] && route.legs[0].steps) {
        currentSteps = route.legs[0].steps;
        currentStepIndex = 0;
        enunciadoPerto.clear();
        exibirInstrucao(0);
        // Anuncia a primeira instrução em voz alta
        falarVoz(instrucaoTexto(currentSteps[0]));
      } else {
        currentSteps = [];
        ocultarInstrucao();
      }

      // Extrai duração (segundos -> minutos) e distância (metros -> km)
      const minutos = Math.max(1, Math.round(route.duration / 60));
      const km = (route.distance / 1000).toFixed(1);

      // Registra o destino usado nos recentes
      registrarDestinoRecente(destinoSelecionado);

      // Formata ETA como HH:MM ou MM:SS
      const eta = formatarETA(minutos);

      // Atualiza o painel inferior em tempo real
      etaTimeEl.textContent = eta;
      distKmEl.textContent = `${km} km`;
    })
    .catch(err => {
      console.error('❌ Erro no OSRM:', err);
      showFeedback('Não foi possível calcular a rota. Tente novamente.');
    });
}

// Desenha a Polyline da rota em azul destacado e espesso
function desenharRota(coordenadas) {
  // Converte [lng, lat] -> [lat, lng] para o Leaflet
  const latlngs = coordenadas.map(c => [c[1], c[0]]);

  // Remove rota anterior, se existir
  if (routeLayer) {
    map.removeLayer(routeLayer);
    map.removeLayer(routeLayer2);
  }

  // Halo (contorno) grosso e semi-transparente para destaque
  routeLayer2 = L.polyline(latlngs, {
    color: '#1d4ed8',
    weight: 10,
    opacity: 0.4
  }).addTo(map);

  // Linha principal azul brilhante
  routeLayer = L.polyline(latlngs, {
    color: '#2563eb',
    weight: 6,
    opacity: 0.95,
    className: 'route-line'
  }).addTo(map);

  // Ajusta o mapa para caber toda a rota
  map.fitBounds(routeLayer.getBounds(), { padding: [50, 60] });
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

// Cor do velocímetro muda conforme a velocidade (leitura de relance)
// Verde (< 60), Amarelo (60-89), Vermelho (>= 90)
function atualizarCorVelocimetro(kmh) {
  const speedValue = document.querySelector('.speed-value');
  const speedUnit = document.querySelector('.speed-unit');
  if (!speedValue) return;

  const cor =
    kmh >= 90 ? '#ef4444' :   // vermelho
    kmh >= 60 ? '#f59e0b' :   // amarelo
                 '#22c55e';   // verde
  speedValue.style.color = cor;
  if (speedUnit) speedUnit.style.color = cor;
  speedValue.style.textShadow = `0 0 12px ${cor}80`;
}

// Feedback discreto flutuante para erros de GPS/rota
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

// Converte a instrução do OSRM em texto amigável em PT-BR
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

// Para "entre na rotatória e ..." usa conjugação específica
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

// Ícone (seta) para a manobra atual
function iconeManeuver(type, modifier) {
  if (type === 'arrive') return '🏁';
  if (type === 'depart') return '⬆️';
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

function exibirInstrucao(index) {
  if (!currentSteps || index >= currentSteps.length) return;
  const step = currentSteps[index];
  const text = instrucaoTexto(step);
  instrTextEl.textContent = text;
  instrManeuverEl.textContent = iconeManeuver(step.maneuver.type, step.maneuver.modifier);
  instrDistEl.textContent = 'Próxima manobra: ' + formatarDistancia(curta(step.distance));
  ativarRota();
}

function ocultarInstrucao() {
  desativarRota();
}

// Liga o modo "rota ativa": esconde a busca e mostra a instrução no topo
function ativarRota() {
  rotaAtiva = true;
  document.body.classList.add('rota-ativa');
}

// Desliga o modo "rota ativa": volta a mostrar a busca
function desativarRota() {
  rotaAtiva = false;
  document.body.classList.remove('rota-ativa');
}

// Inicia uma nova rota: limpa a atual, volta à busca e recentraliza no veículo
function novaRota() {
  // Para qualquer fala pendente
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();

  // Limpa a rota do mapa
  if (routeLayer) {
    map.removeLayer(routeLayer);
    map.removeLayer(routeLayer2);
    routeLayer = null;
    routeLayer2 = null;
  }

  // Reseta estado de navegação
  currentSteps = [];
  currentStepIndex = 0;
  enunciadoPerto.clear();
  destinoSelecionado = null;

  // Volta ETA/distância ao padrão e desativa o modo rota
  etaTimeEl.textContent = '--:--';
  distKmEl.textContent = '0.0 km';
  desativarRota();
  ocultarInstrucao();

  // Limpa o campo de busca e foca/recentra no veículo
  inputDestino.value = '';
  setFollowMode(true);
  const pos = window.currentCoords;
  if (pos) {
    map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), 15), { animate: true });
  }
  inputDestino.focus();
}

// Botão "nova rota" do card de instrução
btnNovaRota.addEventListener('click', novaRota);

// Atualiza continuamente qual instrução mostrar conforme o veículo avança
function atualizarInstrucao(origem) {
  if (!currentSteps.length) {
    ocultarInstrucao();
    return;
  }

  // A manobra que queremos anunciar é a do passo seguinte (índice+1)
  // Enquanto não chegamos nela, mostramos a instrução atual.
  const proxIndex = Math.min(currentStepIndex + 1, currentSteps.length - 1);
  const proxPasso = currentSteps[proxIndex];
  const distAteStep = distanciaOrigemAoStep(proxPasso, origem);

  // Atualiza a distância até a próxima manobra
  instrDistEl.textContent = 'Próxima manobra: ' + formatarDistancia(distAteStep);

  // Quando o veículo chega perto da manobra, avança uma instrução
  if (distAteStep < 30 && proxIndex > currentStepIndex && !enunciadoPerto.has(proxIndex)) {
    enunciadoPerto.add(proxIndex);
    currentStepIndex = proxIndex;
    if (currentStepIndex < currentSteps.length - 1) {
      exibirInstrucao(currentStepIndex);
      falarVoz(instrucaoTexto(currentSteps[currentStepIndex]));
    } else {
      // Último passo = chegada ao destino
      ocultarInstrucao();
      showFeedback('Você chegou ao destino!');
    }
  }
}

// Distância (em metros) da origem ao ponto de manobra de um step
function distanciaOrigemAoStep(step, origem) {
  const geo = step.geometry || null;
  if (!geo || !geo.coordinates || !geo.coordinates.length) return Infinity;
  const c = geo.coordinates[0]; // [lng, lat]
  return haversine(origem.lat, origem.lon, c[1], c[0]);
}

// Anuncia uma instrução em voz alta (síntese de fala em pt-BR)
function falarVoz(texto) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(texto);
  u.lang = 'pt-BR';
  u.rate = 1.05;
  window.speechSynthesis.speak(u);
}

/* ---------- 8. GEOMETRIA/UTILITÁRIOS ADICIONAIS ---------- */

// Distância de Haversine entre dois pontos (metros)
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

// Formata distância em metros -> "300 m" ou "1.2 km"
function formatarDistancia(metros) {
  if (metros >= 1000) return (metros / 1000).toFixed(1) + ' km';
  return Math.round(metros) + ' m';
}

// Distância "limpa" para evitar ruído de GPS (mínimo de 15m)
function curta(m) {
  return Math.max(15, m);
}

/* ---------- 9. DESTINOS RECENTES (persistência) ---------- */
const CHAVE_RECENTES = 'flowpilot:recentes';

// Lista de recentes: [{nome, lat, lon}] mais recentes primeiro
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

// Registra um destino usado, deduplicando pelo nome
function registrarDestinoRecente(dest) {
  if (!dest || !dest.nome) return;
  let lista = carregarRecentes().filter(r => r.nome !== dest.nome);
  lista.unshift({ nome: dest.nome, lat: dest.lat, lon: dest.lon });
  salvarRecentes(lista);
}

// Exibe os recentes quando o campo de busca está vazio e focado
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

// Escape simples para evitar quebra do HTML
function escapeHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

// Mostra recentes quando o campo está vazio e o usuário foca/clica
inputDestino.addEventListener('focus', () => {
  if (!inputDestino.value.trim()) exibirRecentes();
});

/* ---------- Inicialização ---------- */
document.addEventListener('DOMContentLoaded', initMap);