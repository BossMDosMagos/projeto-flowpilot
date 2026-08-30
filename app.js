/* ============================================
   FLOWPILOT - Navegação GPS em tempo real (Leaflet)
   Stack: Leaflet.js + CartoDB Positron + OSRM público
   ============================================ */

/* ---------- Estado global ---------- */
let map = null;              // Instância do Leaflet map
let vehicleMarker = null;    // Marcador do veículo do motorista
let routeLayer = null;       // Camada da rota (Polyline)
let routeLayer2 = null;      // Camada de halo/contorno da rota
let watchId = null;          // ID do watchPosition
let destinoSelecionado = null; // {lon, lat, nome}

// Referências de elementos DOM
const $ = (id) => document.getElementById(id);
const inputDestino = $('destino-input');
const btnIniciar = $('iniciar-rota-btn');
const sugestoesEl = $('sugestoes');
const velocimetroEl = $('velocimetro');
const etaTimeEl = $('eta-time');
const distKmEl = $('dist-km');

/* ---------- 1. INICIALIZAÇÃO DO MAPA ---------- */
function initMap() {
  // Coordenada padrão: São Paulo (alternativa: Rio de Janeiro -23.55, -46.63)
  const defaultCoords = [-23.5505, -46.6333];

  map = L.map('map', {
    center: defaultCoords,
    zoom: 15, // Nível adequado para navegação urbana
    zoomControl: false // Interface clean, sem controles poluentes
  });

  // Camada de tiles - CartoDB Positron (muted/limpo)
  // endereço estável e sem API key, compatível com desktop e mobile
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19,
    maxNativeZoom: 19,
    detectRetina: false
  }).addTo(map);

  // Criar marcador do veículo (posição inicial padrão)
  vehicleMarker = createVehicleMarker(defaultCoords);

  // Iniciar rastreamento GPS em tempo real
  startGPSTracking();
}

/* ---------- 2. MARCADOR PERSONALIZADO DO VEÍCULO ---------- */
function createVehicleMarker(coords) {
  const icon = L.divIcon({
    className: '',
    html: '<div class="vehicle-marker"></div>',
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
      map.setView(coords, map.getZoom(), { animate: true });

      // Atualiza o velocímetro: speed vem em m/s, converter para km/h
      if (typeof speed === 'number' && !isNaN(speed)) {
        const kmh = Math.round(speed * 3.6);
        velocimetroEl.textContent = kmh;
      } else {
        velocimetroEl.textContent = '0';
      }

      // Guarda a posição mais recente para roteamento
      window.currentCoords = { lat: latitude, lon: longitude };
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
    `?overview=full&geometries=geojson`;

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

      // Extrai duração (segundos -> minutos) e distância (metros -> km)
      const minutos = Math.max(1, Math.round(route.duration / 60));
      const km = (route.distance / 1000).toFixed(1);

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

/* ---------- Inicialização ---------- */
document.addEventListener('DOMContentLoaded', initMap);