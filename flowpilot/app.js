/* FlowPilot - Main Application Logic with Real GPS & Navigation */

// ==========================================
// CHECK DE HTTPS E VERIFICAÇÃO DE GPS
// ==========================================

// Verificar se a página está rodando em HTTPS
if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
  console.warn('⚠️ FlowPilot recomenda HTTPS para geolocalização funcionando corretamente.');
  // Mostrar aviso na tela
  const body = document.querySelector('body');
  if (body) {
    const warningDiv = document.createElement('div');
    warningDiv.style.position = 'fixed';
    warningDiv.style.top = '0';
    warningDiv.style.left = '0';
    warningDiv.style.width = '100%';
    warningDiv.style.height = '36px';
    warningDiv.style.background = '#eab308';
    warningDiv.style.color = '#000';
    warningDiv.style.fontSize = '13px';
    warningDiv.style.display = 'flex';
    warningDiv.style.alignItems = 'center';
    warningDiv.style.justifyContent = 'center';
    warningDiv.style.zIndex = '9999';
    warningDiv.style.boxShadow = '0 2px 10px rgba(0,0,0,0.3)';
    warningDiv.innerHTML = '⚠️ Aviso: Geolocalização pode falhar sem HTTPS. Ative o GPS do celular para usar o FlowPilot.';
    body.insertBefore(warningDiv, body.firstChild);
  }
}

// Verificar suporte a geolocalização
let geolocationSupported = false;
if (navigator.geolocation) {
  geolocationSupported = true;
} else {
  console.error('❌ Geolocalização não suportada neste navegador.');
  // Mostrar aviso flutuante
  showGeolocationError('Geolocalização não suportada neste navegador. Por favor, use um navegador moderno (Chrome, Firefox, Safari) ou um dispositivo mobile.');
}

// Função para exibir aviso flutuante de erro de GPS
function showGeolocationError(message) {
  const errorDiv = document.createElement('div');
  errorDiv.style.position = 'fixed';
  errorDiv.style.bottom = '90px';
  errorDiv.style.left = '50%';
  errorDiv.style.transform = 'translateX(-50%)';
  errorDiv.style.background = '#0f172a';
  errorDiv.style.color = '#fff';
  errorDiv.style.padding = '12px 24px';
  errorDiv.style.borderRadius = '12px';
  errorDiv.style.boxShadow = '0 4px 20px rgba(0,0,0,0.5)';
  errorDiv.style.zIndex = '2000';
  errorDiv.style.fontSize = '14px';
  errorDiv.textContent = message;
  
  // Auto-remove after 5 seconds
  setTimeout(() => {
    if (errorDiv.parentNode) {
      errorDiv.parentNode.removeChild(errorDiv);
    }
  }, 5000);
  
  document.body.insertBefore(errorDiv, document.body.firstChild);
}

// ==========================================
// DOM ELEMENTS COM VALIDAÇÃO
// ==========================================

// Inicialização segura dos elementos do DOM
const domElements = {};

function initDOMElements() {
  const elementIds = [
    'search-input', 'search-bottom-sheet', 'nav-header', 'nav-bottom-bar',
    'current-street-badge', 'floating-menu', 'maneuver-header', 'maneuver-icon',
    'maneuver-distance', 'maneuver-street', 'speed-value', 'eta-time',
    'eta-min', 'eta-km', 'address-search', 'address-suggestions'
  ];

  for (const id of elementIds) {
    const element = document.getElementById(id);
    if (element) {
      domElements[id] = element;
    } else {
      console.warn(`⚠️ Elemento DOM não encontrado: #${id}`);
    }
  }
  
  // Retornar objeto com elementos seguros
  return {
    get: (id) => domElements[id] || null,
    has: (id) => !!domElements[id]
  };
}

// Inicializar elementos DOM seguros
const safeElements = initDOMElements();

// Atualizar referências para usar safeElements
const searchInput = safeElements.get('search-input');
const searchBottomSheet = safeElements.get('search-bottom-sheet');
const navHeader = safeElements.get('nav-header');
const navBottomBar = safeElements.get('nav-bottom-bar');
const currentStreetBadge = safeElements.get('current-street-badge');
const floatingMenu = safeElements.get('floating-menu');
const maneuverHeader = safeElements.get('maneuver-header');
const maneuverIcon = safeElements.get('maneuver-icon');
const maneuverDistance = safeElements.get('maneuver-distance');
const maneuverStreet = safeElements.get('maneuver-street');
const speedometer = safeElements.get('speed-value') || document.getElementById('speed-value');
const etaTime = safeElements.get('eta-time') || document.getElementById('eta-time');
const etaMin = safeElements.get('eta-min') || document.getElementById('eta-min');
const etaKm = safeElements.get('eta-km') || document.getElementById('eta-km');
const addressSearch = safeElements.get('address-search') || document.getElementById('address-search');
const addressSuggestions = safeElements.get('address-suggestions');

// ==========================================
// INICIALIZAÇÃO SEGURA DO MAPA & APIS
// ==========================================

let map = null;
let vehicleMarker = null;
let currentRouteLayer = null;
let gpsInterval = null;
let routeSteps = [];
let currentStepIndex = 0;
let isNavigating = false;
let suggestionsTimeout = null;

// Initialize the map with CartoDB dark matter style
function initMap() {
  try {
    // Verificar se o container do mapa existe
    const mapContainer = document.getElementById('map');
    if (!mapContainer) {
      console.error('❌ Container do mapa (#map) não encontrado no HTML');
      showGeolocationError('Erro crítico: Container do mapa não encontrado.');
      return;
    }

    map = new maplibregl.Map({
      container: 'map',
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center: [-43.249, -22.858], // Rio de Janeiro default
      zoom: 15,
      pitch: 45, // Inclinação 3D estilo Waze
      bearing: 0,
      hash: true
    });

    // Apenas após o mapa carregar é que desenhamos o marcador GPS
    map.on('style.load', () => {
      try {
        map.resize();
        
        // Add vehicle marker APENAS após o mapa estar pronto
        vehicleMarker = new maplibregl.Marker({
          element: createVehicleMarkerElement(),
          anchor: 'center',
          draggable: false
        })
          .setLngLat(map.getCenter())
          .addTo(map);

        // Initialize Real GPS Tracking APENAS após o mapa carregar
        startRealGPSTracking();

        // Set up search autocomplete
        setupSearchAutocomplete();
      } catch (initError) {
        console.error('❌ Erro ao inicializar componentes após map load:', initError);
        showGeolocationError('Erro ao inicializar o aplicativo. Recarregue a página.');
      }
    });

    // Evento de erro do MapLibre
    map.on('error', (e) => {
      console.error('❌ Erro do MapLibre GL:', e);
    });

  } catch (mapError) {
    console.error('❌ Erro crítico ao inicializar MapLibre:', mapError);
    showGeolocationError('Não foi possível inicializar o mapa. Verifique a conexão.');
  }
}

// ==========================================
// REAL GPS TRACKING COM TRATAMENTO DE ERRO
// ==========================================

function startRealGPSTracking() {
  // Double-check: verify geolocation is still supported
  if (!navigator.geolocation) {
    showGeolocationError('Geolocalização não suportada. Use um navegador moderno.');
    return;
  }

  gpsInterval = navigator.geolocation.watchPosition(
    (position) => {
      try {
        const { latitude, longitude, speed, heading } = position.coords;
        
        // Validar dados do GPS
        if (typeof latitude !== 'number' || typeof longitude !== 'number') {
          console.warn('⚠️ Dados de GPS inválidos recebidos');
          return;
        }

        const coords = [longitude, latitude];
        window.lastKnownCoords = coords;

        // Update vehicle marker position - with safety check
        if (vehicleMarker) {
          vehicleMarker.setLngLat(coords).setPopup(new maplibregl.Popup().setText('FlowPilot')).togglePopup();
        }

        // Rotate marker based on bearing (direction of movement)
        if (heading !== null && typeof heading === 'number') {
          vehicleMarker.getElement().style.transform = `rotate(${heading}rad)`;
        }

        // Fly map to current position, keeping it centered
        if (map) {
          map.flyTo({
            center: coords,
            zoom: 17,
            essential: true
          });
        }

        // Update speedometer with real GPS speed in km/h
        if (speedometer && typeof speed === 'number') {
          const speedKmh = (speed * 3.6).toFixed(0);
          speedometer.textContent = `${speedKmh} km/h`;
        }

        // Update current street badge with coordinates
        if (currentStreetBadge) {
          currentStreetBadge.textContent = `${latitude.toFixed(4).toString().replace('.', ',')}, ${longitude.toFixed(4).toString().replace('.', ',')}`;
        }

        // If route is active, check proximity to next step
        if (isNavigating && routeSteps.length > 0 && currentStepIndex < routeSteps.length) {
          checkProximityToStep(coords);
        }

      } catch (gpsError) {
        console.error('❌ Erro ao processar dados GPS:', gpsError);
      }
    },
    (error) => {
      // Tratamento específico de erros de geolocalização
      let errorMessage = 'Erro ao obter geolocalização';
      
      switch (error.code) {
        case error.PERMISSION_DENIED:
          errorMessage = 'Permissão de GPS negada. "Ative o GPS do celular para usar o FlowPilot"';
          break;
        case error.POSITION_UNAVAILABLE:
          errorMessage = 'Posição indisponível. Tente novamente em alguns momentos.';
          break;
        case error.TIMEOUT:
          errorMessage = 'Tempo limite excedido para obter a posição. Tente novamente.';
          break;
        default:
          errorMessage = `Erro desconhecido de geolocalização: ${error.message}`;
      }
      
      console.error('❌ Erro de geolocalização:', error);
      showGeolocationError(errorMessage);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000
    }
  );
}

// ==========================================
// AUTOCOMPLETE COM TRATAMENTO DE ERRO
// ==========================================

function setupSearchAutocomplete() {
  if (!searchInput) {
    console.warn('⚠️ Campo de busca #search-input não encontrado');
    return;
  }

  let debounceTimeout = null;

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    
    if (debounceTimeout) {
      clearTimeout(debounceTimeout);
      debounceTimeout = null;
    }

    if (query.length >= 3) {
      debounceTimeout = setTimeout(() => {
        fetchBoundedNominatim(query);
      }, 300);
    } else {
      hideSuggestions();
    }
  });

  // Hide suggestions when clicking outside
  document.addEventListener('click', (e) => {
    const clickedSearchBottomSheet = e.target.closest('#search-bottom-sheet');
    if (!clickedSearchBottomSheet) {
      hideSuggestions();
    }
  });
}

// Fetch Nominatim with GPS-bounded viewbox - com try/catch
function fetchBoundedNominatim(query) {
  if (!map || !window.lastKnownCoords || !searchInput) return;

  const [lon, lat] = window.lastKnownCoords;
  
  // Validar coordenadas
  if (typeof lon !== 'number' || typeof lat !== 'number') {
    console.warn('⚠️ Coordenadas GPS inválidas para busca Nominatim');
    return;
  }

  const viewbox = [
    lon - 0.1, // west
    lat - 0.1, // south
    lon + 0.1, // east
    lat + 0.1  // north
  ].join(',');

  // Try-catch wrapper para a fetch
  try {
    fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&viewbox=${viewbox}&bounded=1&limit=5&countrycodes=br`)
      .then(response => {
        // Verificar se a resposta é ok
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: Erro na resposta do Nominatim`);
        }
        return response.json();
      })
      .then(displaySuggestions)
      .catch((fetchError) => {
        console.error('❌ Erro na requisição Nominatim:', fetchError);
        showGeolocationError('Erro ao conectar com o serviço de busca. Verifique a conexão.');
        hideSuggestions();
      });
  } catch (error) {
    console.error('❌ Erro try-catch Nominatim:', error);
    showGeolocationError('Erro ao processar requisição de busca.');
    hideSuggestions();
  }
}

// ==========================================
// SELEÇÃO DE SUGESTÃO E CARREGAMENTO DE ROTA
// ==========================================

function selectSuggestion(result) {
  hideSuggestions();
  
  if (!searchInput) return;
  
  searchInput.value = result.display_name || result.name || '';
  
  if (!window.lastKnownCoords) {
    // Wait for GPS to get first position
    const checkGPS = setInterval(() => {
      if (window.lastKnownCoords) {
        clearInterval(checkGPS);
        loadRouteFromCurrentPosition(window.lastKnownCoords, result);
      }
    }, 100);
    setTimeout(() => clearInterval(checkGPS), 5000);
    return;
  }
  
  loadRouteFromCurrentPosition(window.lastKnownCoords, result);
}

// ==========================================
// CARREGAMENTO DE ROTA OSRM COM TRY/CATCH
// ==========================================

function loadRouteFromCurrentPosition(originCoords, result) {
  const destinationCoords = [result.lon, result.lat];
  
  // Hide suggestions, activate navigation
  hideSuggestions();
  
  // Verificar se ativarModoNavegacao existe
  if (typeof ativarModoNavegacao === 'function') {
    ativarModoNavegacao(true);
  } else {
    console.error('❌ função ativarModoNavegacao não definida');
  }

  // Make API call to OSRM - com try-catch estruturado
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${originCoords[0]},${originCoords[1]};${destinationCoords[0]},${destinationCoords[1]}?overview=full&geometries=geojson&steps=true`;
    
    // Fetch com validação de resposta
    fetch(url)
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: Erro na API OSRM. Pode ser limite de requisições ou CORS.`);
        }
        return response.json();
      })
      .then((data) => {
        // Validar dados da resposta
        if (!data || data.code !== 'Ok') {
          const errorMsg = data?.code !== 'Ok' ? `Código de erro: ${data.code}` : 'Resposta inválida da API';
          throw new Error(errorMsg);
        }

        // Store route steps
        routeSteps = data.routes[0].legs[0].steps;
        currentStepIndex = 0;
        isNavigating = true;

        // Draw route on MapLibre with neon purple line
        if (typeof drawRoute === 'function') {
          drawRoute(data.routes[0].geometry, '#a855f7');
        } else {
          console.error('❌ função drawRoute não definida');
        }

        // Update first maneuver instruction
        if (routeSteps.length > 0 && typeof updateManeuverInstruction === 'function') {
          updateManeuverInstruction(routeSteps[0]);
          
          // Show navigation header and bottom bar
          if (navHeader) navHeader.style.display = 'flex';
          if (navBottomBar) navBottomBar.style.display = 'flex';
        }

        // Hide search bottom sheet
        if (searchBottomSheet) searchBottomSheet.style.display = 'none';

        // Initialize ETA/distance calculations
        if (typeof updateTelemetry === 'function') {
          updateTelemetry();
        }

        // Fly map to route center
        if (map && data.routes[0]?.geometry?.coordinates) {
          const routeCoords = data.routes[0].geometry.coordinates;
          const bounds = new maplibregl.LngLatBounds(
            [routeCoords[0][0], routeCoords[0][1]],
            [routeCoords[routeCoords.length - 1][0], routeCoords[routeCoords.length - 1][1]]
          );
          map.fitBounds(bounds, { padding: 50 });
        }
      })
      .catch((fetchError) => {
        console.error('❌ Erro ao carregar rota OSRM:', fetchError);
        showGeolocationError(`Não foi possível calcular a rota. ${fetchError.message || ''}`.trim());
        
        // Reset navigation state
        isNavigating = false;
        if (navHeader) navHeader.style.display = 'none';
        if (navBottomBar) navBottomBar.style.display = 'none';
        if (searchBottomSheet) searchBottomSheet.style.display = 'block';
      });
  } catch (error) {
    console.error('❌ Erro try-catch ao carregar rota:', error);
    showGeolocationError('Erro ao processar requisição de rota. Tente novamente.');
    if (navHeader) navHeader.style.display = 'none';
    if (navBottomBar) navBottomBar.style.display = 'none';
    if (searchBottomSheet) searchBottomSheet.style.display = 'block';
  }
}

// ==========================================
// ROTA & TRANSPARÊNCIA NO MAPALIBRE
// ==========================================

function drawRoute(geometry, color) {
  if (!map) {
    console.warn('⚠️ Map não inicializado ao desenhar rota');
    return;
  }

  // Remove existing route layer if present
  if (currentRouteLayer) {
    try {
      map.removeLayer(currentRouteLayer);
      map.removeSource('route-source');
    } catch (e) {
      console.error('❌ Erro ao remover layer anterior:', e);
    }
    currentRouteLayer = null;
  }

  try {
    // Add route source
    map.addSource('route-source', {
      type: 'geojson',
      data: { type: 'Feature', geometry }
    });

    // Add route layer with neon purple color
    currentRouteLayer = map.addLayer({
      id: 'route-layer',
      type: 'line',
      source: 'route-source',
      paint: {
        'line-color': color,
        'line-width': 8,
        'line-opacity': 0.9
      }
    });
  } catch (drawError) {
    console.error('❌ Erro ao desenhar rota no mapa:', drawError);
  }
}

// ==========================================
// OUTRAS FUNÇÕES COM VALIDAÇÃO
// ==========================================

function updateManeuverInstruction(step) {
  if (!maneuverDistance || !maneuverStreet || !maneuverIcon) {
    console.warn('⚠️ Elementos do header de manobra não encontrados');
    return;
  }

  try {
    const instruction = mapInstructionToPortuguese(step.text_description || '');

    maneuverDistance.textContent = `${step.distance} m`;
    maneuverStreet.textContent = step.name || instruction;

    // Update icon based on maneuver type
    const icon = createManeuverIcon(step.type);
    if (icon) {
      maneuverIcon.innerHTML = '';
      maneuverIcon.appendChild(icon);
    }
  } catch (instructionError) {
    console.error('❌ Erro ao atualizar instrução de manobra:', instructionError);
  }
}

function mapInstructionToPortuguese(instruction) {
  const mappings = {
    'Right': 'Vire à direita',
    'Left': 'Vire à esquerda',
    'Continue': 'Siga em frente',
    'Roundabout': 'Rotatória',
    'Destination': 'Destino alcançado'
  };

  try {
    for (const [key, value] of Object.entries(mappings)) {
      if (instruction && instruction.includes(key)) {
        return `${value} na ${extractStreetName(instruction)}`;
      }
    }
    return `Entre na ${extractStreetName(instruction || '')}`;
  } catch (mappingError) {
    console.error('❌ Erro ao mapear instrução:', mappingError);
    return 'Entre na próxima rua';
  }
}

function extractStreetName(instruction) {
  try {
    const match = instruction?.match(/[Rr]ua\s+[\w\s]+|[A-a]venida\s+[\w\s]+|[T-t]ravessa[\w\s]+/);
    return match ? match[0] : 'próxima rua';
  } catch (error) {
    console.error('❌ Erro ao extrair nome de rua:', error);
    return 'próxima rua';
  }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  try {
    const R = 6371e3; // Earth radius in meters
    const φ1 = (typeof lat1 === 'number') ? lat1 * Math.PI / 180 : 0;
    const φ2 = (typeof lat2 === 'number') ? lat2 * Math.PI / 180 : 0;
    const Δφ = (typeof lat2 === 'number' && typeof lat1 === 'number') ? (lat2 - lat1) * Math.PI / 180 : 0;
    const Δλ = (typeof lon2 === 'number' && typeof lon1 === 'number') ? (lon2 - lon1) * Math.PI / 180 : 0;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  } catch (calcError) {
    console.error('❌ Erro ao calcular distância:', calcError);
    return 0;
  }
}

function endRoute() {
  isNavigating = false;
  
  if (maneuverDistance) maneuverDistance.textContent = '0 m';
  if (maneuverStreet) maneuverStreet.textContent = 'Destino alcançado';
  
  if (navHeader) navHeader.style.display = 'none';
  if (navBottomBar) navBottomBar.style.display = 'none';
  if (searchBottomSheet) searchBottomSheet.style.display = 'block';
  
  // Clear route from map
  if (currentRouteLayer && map) {
    try {
      map.removeLayer(currentRouteLayer);
      map.removeSource('route-source');
    } catch (e) {
      console.error('❌ Erro ao limpar rota do mapa:', e);
    }
    currentRouteLayer = null;
  }

  // Reset steps
  routeSteps = [];
  currentStepIndex = 0;
  isNavigating = false;
}

function stopGPSTracking() {
  if (gpsInterval) {
    navigator.geolocation.clearWatch(gpsInterval);
    gpsInterval = null;
  }
}

function updateTelemetry() {
  if (routeSteps.length === 0) return;

  try {
    const remainingDistance = routeSteps.slice(currentStepIndex)
      .reduce((sum, step) => sum + (step.distance || 0), 0);
    const remainingDuration = routeSteps.slice(currentStepIndex)
      .reduce((sum, step) => sum + (step.duration || 0), 0);

    const etaMinutes = Math.floor((remainingDuration / 60) || 0);
    const remainingKm = (remainingDistance / 1000).toFixed(1);
    
    if (etaTime) etaTime.textContent = `${etaMinutes}:${(etaMinutes % 10).toString().padStart(2, '0')}`;
    if (etaMin) etaMin.textContent = `${etaMinutes} min`;
    if (etaKm) etaKm.textContent = `${remainingKm} km`;
  } catch (telemetryError) {
    console.error('❌ Erro ao atualizar telemetria:', telemetryError);
  }
}

function ativarModoNavegacao(ativo = true) {
  isNavigating = ativo;
  
  if (navHeader) navHeader.style.display = ativo ? 'flex' : 'none';
  if (navBottomBar) navBottomBar.style.display = ativo ? 'flex' : 'none';
  if (searchBottomSheet) searchBottomSheet.style.display = ativo ? 'none' : 'block';
  
  if (ativo) {
    if (floatingMenu) floatingMenu.classList.add('visible');
  } else {
    if (floatingMenu) floatingMenu.classList.remove('visible');
  }
}

// Initialize on DOM content loaded - com validação retrasada
document.addEventListener('DOMContentLoaded', () => {
  // Pequeno delay para garantir que todos os elementos DOM estejam prontos
  setTimeout(() => {
    initMap();
    initDOMElements();
  }, 100);
});

// Global function accessible from HTML
window.ativarModoNavegacao = ativarModoNavegacao;