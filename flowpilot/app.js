/* FlowPilot - Main Application Logic with Real GPS & Navigation */

/* ==========================================
   CHECK DE HTTPS E VERIFICAÇÃO INICIAL
   ========================================== */

// Verificar se a página está rodando em HTTPS (recomendado para GPS)
if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
  console.warn('⚠️ FlowPilot: Geolocalização funciona melhor em HTTPS. Na rede celular use dados móveis.');
}

// Verificar suporte a geolocalização cedo
let geolocationSupported = false;
if (navigator.geolocation) {
  geolocationSupported = true;
} else {
  console.error('❌ Geolocalização não suportada. Use Chrome, Firefox ou Safari.');
}

// ==========================================
// INICIALIZAÇÃO SEGURA DOS ELEMENTOS DOM
// ==========================================

function initDOMElements() {
  const elementIds = [
    'search-input', 'search-bottom-sheet', 'nav-header', 'nav-bottom-bar',
    'current-street-badge', 'floating-menu', 'maneuver-header', 'maneuver-icon',
    'maneuver-distance', 'maneuver-street', 'speed-value', 'eta-time',
    'eta-min', 'eta-km', 'address-search', 'address-suggestions'
  ];

  const elements = {};
  for (const id of elementIds) {
    const el = document.getElementById(id);
    if (el) {
      elements[id] = el;
    } else {
      console.warn(`⚠️ Elemento DOM não encontrado: #${id}. O app pode ter comportamento limitado.`);
    }
  }
  return elements;
}

// ==========================================
// INICIALIZAÇÃO DO MAPA
// ==========================================

let map = null;
let vehicleMarker = null;
let currentRouteLayer = null;
let gpsInterval = null;
let routeSteps = [];
let currentStepIndex = 0;
let isNavigating = false;

function initMap() {
  try {
    const mapContainer = document.getElementById('map');
    if (!mapContainer) {
      console.error('❌ Container #map não encontrado');
      return;
    }

    map = new maplibregl.Map({
      container: 'map',
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center: [-43.249, -22.858],
      zoom: 15,
      pitch: 45,
      bearing: 0
    });

    map.on('style.load', () => {
      map.resize();

      // Só desenha marcador APÓS o mapa carregar
      vehicleMarker = new maplibregl.Marker({
        element: createVehicleMarkerElement(),
        anchor: 'center'
      })
        .setLngLat(map.getCenter())
        .addTo(map);

      // Inicia GPS após mapa pronto
      if (geolocationSupported) {
        startRealGPSTracking();
      } else {
        showGeolocationError('Geolocalização não suportada. Use um navegador moderno.');
      }

      // Configura autocomplete SEM depender obrigatoriamente do GPS imediatamente
      setupSearchAutocomplete();
    });

    map.on('error', (e) => {
      console.error('❌ Erro MapLibre:', e);
    });

  } catch (err) {
    console.error('❌ Erro crítico initMap:', err);
  }
}

// ==========================================
// GESTÃO DE ERROS DE GPS
// ==========================================

function showGeolocationError(message) {
  const existing = document.getElementById('flowpilot-gps-error');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.id = 'flowpilot-gps-error';
  div.style.position = 'fixed';
  div.style.bottom = '90px';
  div.style.left = '50%';
  div.style.transform = 'translateX(-50%)';
  div.style.background = '#0f172a';
  div.style.color = '#fff';
  div.style.padding = '12px 24px';
  div.style.borderRadius = '12px';
  div.style.boxShadow = '0 4px 20px rgba(0,0,0,0.5)';
  div.style.zIndex = '2000';
  div.style.fontSize = '14px';
  div.style.maxWidth = '90%';
  div.textContent = message;
  document.body.insertBefore(div, document.body.firstChild);
}

// ==========================================
// GPS EM TEMPO REAL
// ==========================================

function startRealGPSTracking() {
  if (!navigator.geolocation) {
    showGeolocationError('Geolocalização não suportada.');
    return;
  }

  gpsInterval = navigator.geolocation.watchPosition(
    (position) => {
      try {
        const { latitude, longitude, speed, heading } = position.coords;

        // Validar dados
        if (typeof latitude !== 'number' || typeof longitude !== 'number') {
          console.warn('⚠️ Dados GPS inválidos');
          return;
        }

        window.lastKnownCoords = [longitude, latitude];

        // Atualizar marcador
        if (vehicleMarker) {
          vehicleMarker.setLngLat(window.lastKnownCoords);
        }

        // Rotacionar conforme bearing
        if (heading !== null && typeof heading === 'number') {
          vehicleMarker.getElement().style.transform = `rotate(${heading}rad)`;
        }

        // Centralizar mapa
        if (map) {
          map.flyTo({
            center: window.lastKnownCoords,
            zoom: 17,
            essential: true
          });
        }

        // Velocímetro
        if (speedometer && typeof speed === 'number') {
          speedometer.textContent = `${(speed * 3.6).toFixed(0)} km/h`;
        }

        // Atualizar badge de rua
        if (currentStreetBadge) {
          currentStreetBadge.textContent = 
            `${latitude.toFixed(4).toString().replace('.', ',')}, ${longitude.toFixed(4).toString().replace('.', ',')}`;
        }

        // Verificar proximidade de passo se em rota
        if (isNavigating && routeSteps.length > 0 && currentStepIndex < routeSteps.length) {
          checkProximityToStep(window.lastKnownCoords);
        }

      } catch (e) {
        console.error('❌ Erro processando GPS:', e);
      }
    },
    (error) => {
      let errorMsg = 'Erro de geolocalização';
      switch (error.code) {
        case error.PERMISSION_DENIED:
          errorMsg = 'Permissão de GPS negada. Toque "Permitir" nas configurações do navegador.';
          break;
        case error.POSITION_UNAVAILABLE:
          errorMsg = 'Posição indisponível. Tente novamente em alguns momentos.';
          break;
        case error.TIMEOUT:
          errorMsg = 'Tempo limite excedido. Tente mover-se para um local com melhor sinal.';
          break;
      }
      console.error('❌ GPS Error:', error);
      showGeolocationError(errorMsg);
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
  );
}

// ==========================================
// AUTOCOMPLETE - CORREÇÃO PRINCIPAL
// ==========================================

function setupSearchAutocomplete() {
  const $ = initDOMElements(); // Referências seguras
  searchInput = $.get('search-input');

  if (!searchInput) {
    console.error('❌ #search-input não encontrado no HTML');
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
      // Chama fetch - agora com fallback para map center se GPS ainda não veio
      fetchBoundedNominatim(query);
    } else {
      hideSuggestions();
    }
  });

  // Esconder ao clicar fora
  document.addEventListener('click', (e) => {
    const clickedSheet = e.target.closest('#search-bottom-sheet');
    if (!clickedSheet) {
      hideSuggestions();
    }
  });
}

// Busca no Nominatim com fallback inteligente
function fetchBoundedNominatim(query) {
  // 1. Tentar usar GPS se disponível
  if (window.lastKnownCoords) {
    try {
      const [lon, lat] = window.lastKnownCoords;
      const viewbox = [lon - 0.1, lat - 0.1, lon + 0.1, lat + 0.1].join(',');
      
      return fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&viewbox=${viewbox}&bounded=1&limit=5&countrycodes=br`)
        .then(response => {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(displaySuggestions)
        .catch((err) => {
          console.error('❌ GPS-bounded fetch error:', err);
          // Fallback para map center se GPS falhar
          useMapCenterFallback(query);
        });
    } catch (e) {
      console.error('❌ Error in GPS-bounded search:', e);
      useMapCenterFallback(query);
    }
  } else {
    // 2. Sem GPS ainda: usar center do mapa
    useMapCenterFallback(query);
  }
}

// Fallback: busca usando center do mapa (funciona sem GPS)
function useMapCenterFallback(query) {
  if (!map) {
    console.warn('⚠️ Map not loaded yet, cannot search');
    return;
  }

  const center = map.getCenter();
  const viewbox = [center.lng - 0.2, center.lat - 0.2, center.lng + 0.2, center.lat + 0.2].join(',');
  
  fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&viewbox=${viewbox}&bounded=1&limit=5&countrycodes=br`)
    .then(response => {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(displaySuggestions)
    .catch((err) => {
      console.error('❌ Map center search error:', err);
      hideSuggestions();
    });
}

// ==========================================
// SELEÇÃO DE SUGESTÃO E ROTA
// ==========================================

function selectSuggestion(result) {
  hideSuggestions();
  
  if (!searchInput) return;
  searchInput.value = result.display_name || result.name || '';

  // Carregar rota - dar tempo suficiente para GPS
  if (window.lastKnownCoords) {
    loadRouteFromCurrentPosition(window.lastKnownCoords, result);
  } else {
    // Esperar GPS com timeout
    const checkGPS = setInterval(() => {
      if (window.lastKnownCoords) {
        clearInterval(checkGPS);
        loadRouteFromCurrentPosition(window.lastKnownCoords, result);
      }
    }, 200);
    setTimeout(() => clearInterval(checkGPS), 8000); // 8 segundos de espera
  }
}

// ==========================================
// CARREGAMENTO DE ROTA OSRM
// ==========================================

function loadRouteFromCurrentPosition(originCoords, result) {
  if (!map) return;

  hideSuggestions();
  
  if (typeof ativarModoNavegacao === 'function') {
    ativarModoNavegacao(true);
  }

  const destinationCoords = [result.lon, result.lat];
  const url = `https://router.project-osrm.org/route/v1/driving/${originCoords[0]},${originCoords[1]};${destinationCoords[0]},${destinationCoords[1]}?overview=full&geometries=geojson&steps=true`;

  fetch(url)
    .then(response => {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then((data) => {
      if (!data || data.code !== 'Ok') {
        throw new Error(data?.code === 'Ok' ? 'Resposta inválida' : 'Não foi possível calcular a rota. Tente outro endereço.');
      }

      routeSteps = data.routes[0].legs[0].steps;
      currentStepIndex = 0;
      isNavigating = true;

      // Desenhar rota
      if (currentRouteLayer) {
        map.removeLayer(currentRouteLayer);
        map.removeSource('route-source');
      }
      map.addSource('route-source', {
        type: 'geojson',
        data: { type: 'Feature', geometry: data.routes[0].geometry }
      });
      currentRouteLayer = map.addLayer({
        id: 'route-layer',
        type: 'line',
        source: 'route-source',
        paint: { 'line-color': '#a855f7', 'line-width': 8, 'line-opacity': 0.9 }
      });

      // Primeira manobra
      if (routeSteps.length > 0) {
        updateManeuverInstruction(routeSteps[0]);
        navHeader.style.display = 'flex';
        navBottomBar.style.display = 'flex';
        searchBottomSheet.style.display = 'none';
      }

      updateTelemetry();

      // Centralizar mapa na rota
      const routeCoords = data.routes[0].geometry.coordinates;
      if (routeCoords && routeCoords.length > 0) {
        const bounds = new maplibregl.LngLatBounds(
          [routeCoords[0][0], routeCoords[0][1]],
          [routeCoords[routeCoords.length - 1][0], routeCoords[routeCoords.length - 1][1]]
        );
        map.fitBounds(bounds, { padding: 50 });
      }
    })
    .catch((err) => {
      console.error('❌ OSRM Error:', err);
      showGeolocationError('Erro ao calcular rota. Verifique o endereço e tente novamente.');
      isNavigating = false;
      if (navHeader) navHeader.style.display = 'none';
      if (navBottomBar) navBottomBar.style.display = 'none';
      if (searchBottomSheet) searchBottomSheet.style.display = 'block';
    });
}

// ==========================================
// OUTRAS FUNÇÕES (simplificadas e robustas)
// ==========================================

function checkProximityToStep(coords) {
  if (!routeSteps?.[currentStepIndex]?.geometry?.coordinates) return;
  
  const stepCoords = routeSteps[currentStepIndex].geometry.coordinates;
  const distance = calculateDistance(
    coords[1], coords[0], stepCoords[1], stepCoords[0]
  );
  
  if (distance <= 25) advanceToNextStep();
}

function advanceToNextStep() {
  currentStepIndex++;
  if (currentStepIndex >= routeSteps.length) {
    endRoute();
    return;
  }
  const nextStep = routeSteps[currentStepIndex];
  if (nextStep) updateManeuverInstruction(nextStep);
}

function updateManeuverInstruction(step) {
  if (!maneuverDistance || !maneuverStreet || !maneuverIcon) return;
  
  const instruction = mapInstructionToPortuguese(step.text_description || '');
  maneuverDistance.textContent = `${step.distance} m`;
  maneuverStreet.textContent = step.name || instruction;
  
  const icon = createManeuverIcon(step.type);
  if (icon) {
    maneuverIcon.innerHTML = '';
    maneuverIcon.appendChild(icon);
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
  if (!instruction) return 'Entre na próxima rua';
  
  for (const [key, value] of Object.entries(mappings)) {
    if (instruction.includes(key)) {
      return `${value} na ${extractStreetName(instruction)}`;
    }
  }
  return `Entre na ${extractStreetName(instruction)}`;
}

function extractStreetName(instruction) {
  const match = instruction?.match(/[Rr]ua\s+[\w\s]+|[A-a]venida\s+[\w\s]+|[T-t]ravessa[\w\s]+/);
  return match ? match[0] : 'próxima rua';
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function endRoute() {
  isNavigating = false;
  if (maneuverDistance) maneuverDistance.textContent = '0 m';
  if (maneuverStreet) maneuverStreet.textContent = 'Destino alcançado';
  if (navHeader) navHeader.style.display = 'none';
  if (navBottomBar) navBottomBar.style.display = 'none';
  if (searchBottomSheet) searchBottomSheet.style.display = 'block';
  
  if (currentRouteLayer && map) {
    try {
      map.removeLayer(currentRouteLayer);
      map.removeSource('route-source');
    } catch (e) {}
    currentRouteLayer = null;
  }
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
  
  const remainingDistance = routeSteps.slice(currentStepIndex).reduce((s, step) => s + (step.distance || 0), 0);
  const remainingDuration = routeSteps.slice(currentStepIndex).reduce((s, step) => s + (step.duration || 0), 0);
  
  const etaMinutes = Math.floor((remainingDuration / 60) || 0);
  const remainingKm = (remainingDistance / 1000).toFixed(1);
  
  if (etaTime) etaTime.textContent = `${etaMinutes}:${String(etaMinutes % 10).padStart(2, '0')}`;
  if (etaMin) etaMin.textContent = `${etaMinutes} min`;
  if (etaKm) etaKm.textContent = `${remainingKm} km`;
}

function ativarModoNavegacao(ativo = true) {
  isNavigating = ativo;
  if (navHeader) navHeader.style.display = ativo ? 'flex' : 'none';
  if (navBottomBar) navBottomBar.style.display = ativo ? 'flex' : 'none';
  if (searchBottomSheet) searchBottomSheet.style.display = ativo ? 'none' : 'block';
  if (floatingMenu) ativo ? floatingMenu.classList.add('visible') : floatingMenu.classList.remove('visible');
}

// Inicialização retrasada para garantir DOM pronto
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    initMap();
  }, 100);
});

window.ativarModoNavegacao = ativarModoNavegacao;