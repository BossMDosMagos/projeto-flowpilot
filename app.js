/* FlowPilot - Main Application Logic */
maplibregl.accessToken = '';

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// Core state
let map = null;
let vehicleMarker = null;
let currentRouteLayer = null;
let gpsInterval = null;
let isNavigating = false;

// DOM Elements - matching the mobile simulator HTML structure
const searchInput = document.getElementById('search-input');
const searchBottomSheet = document.getElementById('search-bottom-sheet');
const navHeader = document.getElementById('nav-header');
const navBottomBar = document.getElementById('nav-bottom-bar');
const currentStreetBadge = document.getElementById('current-street-badge');
const floatingMenu = document.getElementById('floating-menu');
const maneuverHeader = document.getElementById('maneuver-header');
const maneuverIcon = document.getElementById('maneuver-icon');
const maneuverDistance = document.getElementById('maneuver-distance');
const maneuverStreet = document.getElementById('maneuver-street');
const speedometer = document.getElementById('speed-value');
const etaTime = document.getElementById('eta-time');
const etaMin = document.getElementById('eta-min');
const etaKm = document.getElementById('eta-km');

// Initialize the map with CartoDB dark matter style
function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: [-43.249, -22.858], // Rio de Janeiro default
    zoom: 15,
    pitch: 45, // Inclinação 3D estilo Waze
    bearing: 0,
    hash: true
  });

  // Set up GPS tracking after map loads
  map.on('style.load', () => {
    map.resize();
    
    // Add vehicle marker - set initial position
    vehicleMarker = new maplibregl.Marker({
      element: createVehicleMarkerElement(),
      anchor: 'center',
      draggable: false
    })
      .setLngLat(map.getCenter())
      .addTo(map);

    // Initialize GPS tracking
    startGPSTracking();

    // Set up search autocomplete
    setupSearchAutocomplete();
  });
}

// Create vehicle marker element (arrow pointing direction)
function createVehicleMarkerElement() {
  const el = document.createElement('div');
  el.width = 30;
  el.height = 30;
  el.style.backgroundColor = '#00d4ff';
  el.style.borderRadius = '8px';
  el.style.boxShadow = '0 0 20px #00d4ff, 0 2px 10px rgba(0,0,0,0.5)';
  el.style.position = 'relative';
  
  // Arrow inside the marker
  const arrow = document.createElement('div');
  arrow.style.width = '0';
  arrow.style.height = '0';
  arrow.style.borderLeft = '12px solid #050505';
  arrow.style.borderTop = '8px solid transparent';
  arrow.style.borderBottom = '8px solid transparent';
  arrow.style.position = 'absolute';
  arrow.style.top = '50%';
  arrow.style.left = '50%';
  arrow.style.transform = 'translate(-50%, -50%)';
  arrow.style.marginTop = '-8px';
  
  // Add a white circle behind the arrow
  const circle = document.createElement('div');
  circle.style.width = '20px';
  circle.style.height = '20px';
  circle.style.backgroundColor = '#050505';
  circle.style.borderRadius = '50%';
  circle.style.boxShadow = '0 0 10px #00d4ff';
  circle.style.margin = '4px';
  circle.style.display = 'flex';
  circle.style.alignItems = 'center';
  circle.style.justifyContent = 'center';
  
  const circleIcon = document.createElement('span');
  circleIcon.style.width = '8px';
  circleIcon.style.height = '8px';
  circleIcon.style.backgroundColor = '#ffffff';
  circleIcon.style.borderRadius = '50%';
  
  circle.appendChild(circleIcon);
  el.appendChild(arrow);
  el.appendChild(circle);
  
  return el;
}

// Set up search autocomplete with GPS-bounded Nominatim
function setupSearchAutocomplete() {
  let autocompleteTimeout = null;

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    
    // Clear previous timeout
    if (autocompleteTimeout) {
      clearTimeout(autocompleteTimeout);
      autocompleteTimeout = null;
    }

    // Show suggestions only when ≥3 characters
    if (query.length >= 3) {
      autocompleteTimeout = setTimeout(() => {
        fetchBoundedNominatim(query);
      }, 300);
    } else {
      // Hide suggestions when less than 3 characters
      hideSuggestions();
    }
  });

  // Hide suggestions when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-bottom-sheet')) {
      hideSuggestions();
    }
  });

  // Initialize suggestions container reference
  let suggestionsContainer = null;

// Fetch Nominatim with GPS-bounded viewbox
function fetchBoundedNominatim(query) {
  if (!map) return;

  // Get current GPS position from last known position
  // We'll use the map's current center as the bounding box center
  const center = map.getCenter();
  const viewbox = [
    center.lng - 0.1, // west
    center.lat - 0.1, // south
    center.lng + 0.1, // east
    center.lat + 0.1  // north
  ].join(',');

  fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&viewbox=${viewbox}&bounded=1&limit=5&countrycodes=br`)
    .then(response => response.json())
    .then(displaySuggestions)
    .catch(() => hideSuggestions);
}

// Display search suggestions in the search-bottom-sheet
function displaySuggestions(results) {
  // Get or create suggestions container inside search-bottom-sheet
  if (!suggestionsContainer) {
    suggestionsContainer = document.createElement('div');
    suggestionsContainer.className = 'address-suggestions';
    suggestionsContainer.style.position = 'absolute';
    suggestionsContainer.style.bottom = '56px'; // above the search bar, below drag handle
    suggestionsContainer.style.left = '0';
    suggestionsContainer.style.right = '0';
    suggestionsContainer.style.background = '#121a26';
    suggestionsContainer.style.borderRadius = '20px 20px 0 0';
    suggestionsContainer.style.maxHeight = '150px';
    suggestionsContainer.style.overflowY = 'auto';
    suggestionsContainer.style.zIndex = '20';
    suggestionsContainer.style.padding = '8px 12px';
    suggestionsContainer.style.fontSize = '14px';
    suggestionsContainer.style.color = '#cbd5e1';
    // Insert after the drag handle
    const dragHandle = searchBottomSheet.querySelector('.sheet-drag-handle');
    if (dragHandle && dragHandle.parentNode === searchBottomSheet) {
      searchBottomSheet.insertBefore(suggestionsContainer, dragHandle.nextSibling);
    } else {
      searchBottomSheet.appendChild(suggestionsContainer);
    }
  }

  // Clear existing suggestions
  suggestionsContainer.innerHTML = '';

  if (results.length === 0) {
    suggestionsContainer.style.display = 'none';
    return;
  }

  suggestionsContainer.style.display = 'block';

  results.forEach(result => {
    const div = document.createElement('div');
    div.style.padding = '8px 12px';
    div.style.cursor = 'pointer';
    div.style.borderRadius = '8px';
    div.style.margin = '4px 0';
    div.style.transition = 'background 0.2s';
    div.style.background = 'rgba(255,255,255,0.05)';
    
    div.addEventListener('mouseover', () => {
      div.style.background = 'rgba(168, 85, 247, 0.2)';
    });
    
    div.addEventListener('mouseout', () => {
      div.style.background = 'rgba(255,255,255,0.05)';
    });
    
    div.addEventListener('click', () => {
      selectSuggestion(result);
    });

    // Display name and address
    const displayName = result.display_name || result.name || '';
    div.textContent = displayName;
    suggestionsContainer.appendChild(div);
  });
}

// Hide suggestions list
function hideSuggestions() {
  if (suggestionsContainer) {
    suggestionsContainer.style.display = 'none';
  }
}

// Select a suggestion and load route
function selectSuggestion(result) {
  hideSuggestions();
  
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.value = result.display_name || result.name || '';
  }
  
  // Get current position from GPS (will be available after tracking starts)
  if (window.lastKnownCoords) {
    loadRouteFromCurrentPosition(window.lastKnownCoords, result);
  } else {
    // Wait for GPS to get first position
    const checkGPS = setInterval(() => {
      if (window.lastKnownCoords) {
        clearInterval(checkGPS);
        loadRouteFromCurrentPosition(window.lastKnownCoords, result);
      }
    }, 100);
    setTimeout(() => clearInterval(checkGPS), 5000);
  }
}

// Load route from current GPS position to selected address
function loadRouteFromCurrentPosition(originCoords, result) {
  const destinationCoords = [result.lon, result.lat];
  
  // Show search sheet is hidden, activate navigation
  hideSuggestions();
  ativarModoNavegacao(true);

  // Make API call to OSRM
  const url = `https://router.project-osrm.org/route/v1/driving/${originCoords[0]},${originCoords[1]};${destinationCoords[0]},${destinationCoords[1]}?overview=full&geometries=geojson`;

  fetch(url)
    .then(response => response.json())
    .then((data) => {
      if (data.code !== 'Ok') {
        alert('Não foi possível calcular a rota.');
        return;
      }

      // Store route steps
      routeSteps = data.routes[0].legs[0].steps;
      currentStepIndex = 0;
      isNavigating = true;

      // Draw route on MapLibre with neon purple line
      drawRoute(data.routes[0].geometry, '#a855f7');

      // Update first maneuver instruction
      if (routeSteps.length > 0) {
        updateManeuverInstruction(routeSteps[0]);
        // Show navigation header and bottom bar
        navHeader.style.display = 'flex';
        navBottomBar.style.display = 'flex';
        // Hide search bottom sheet
        searchBottomSheet.style.display = 'none';
      }

      // Initialize ETA/distance calculations
      updateTelemetry();

      // Fly map to route center
      const routeCoords = data.routes[0].geometry.coordinates;
      const bounds = new maplibregl.LngLatBounds(
        [routeCoords[0][0], routeCoords[0][1]],
        [routeCoords[routeCoords.length - 1][0], routeCoords[routeCoords.length - 1][1]]
      );
      map.fitBounds(bounds, { padding: 50 });
    })
    .catch(() => alert('Erro ao carregar rota.'));
}

// Draw route on MapLibre with neon color
function drawRoute(geometry, color) {
  // Remove existing route layer if present
  if (currentRouteLayer) {
    map.removeLayer(currentRouteLayer);
    map.removeSource('route-source');
    currentRouteLayer = null;
  }

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
}

// Update maneuver header with next step info
function updateManeuverInstruction(step) {
  const instruction = mapInstructionToPortuguese(step.text_description || '');

  maneuverDistance.textContent = `${step.distance} m`;
  maneuverStreet.textContent = instruction;

  // Update icon based on maneuver type
  const icon = createManeuverIcon(step.type);
  maneuverIcon.innerHTML = '';
  maneuverIcon.appendChild(icon);
}

// Map OSRM instruction to Portuguese
function mapInstructionToPortuguese(instruction) {
  const mappings = {
    'Right': 'Vire à direita',
    'Left': 'Vire à esquerda',
    'Continue': 'Siga em frente',
    'Roundabout': 'Rotatória',
    'Destination': 'Destino alcançado'
  };

  for (const [key, value] of Object.entries(mappings)) {
    if (instruction.includes(key)) {
      return `${value} na ${extractStreetName(instruction)}`;
    }
  }

  return `Entre na ${extractStreetName(instruction)}`;
}

// Extract street name from instruction
function extractStreetName(instruction) {
  const match = instruction.match(/[Rr]ua\s+[\w\s]+|[A-a]venida\s+[\w\s]+|[T-t]ravessa[\w\s]+/);
  return match ? match[0] : 'próxima rua';
}

// Calculate distance between two points in meters
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// End route and show completion
function endRoute() {
  isNavigating = false;
  maneuverDistance.textContent = '0 m';
  maneuverStreet.textContent = 'Destino alcançado';
  navHeader.style.display = 'none';
  navBottomBar.style.display = 'none';
  searchBottomSheet.style.display = 'block';
  
  // Clear route from map
  if (currentRouteLayer) {
    map.removeLayer(currentRouteLayer);
    map.removeSource('route-source');
    currentRouteLayer = null;
  }

  // Reset steps
  routeSteps = [];
  currentStepIndex = 0;
}

// Stop GPS tracking
function stopGPSTracking() {
  if (gpsInterval) {
    navigator.geolocation.clearWatch(gpsInterval);
    gpsInterval = null;
  }
}

// Start GPS tracking with mapa centralização e bearing
function startGPSTracking() {
  if (!navigator.geolocation) {
    alert('Geolocalização não suportada neste navegador.');
    return;
  }

  gpsInterval = navigator.geolocation.watchPosition(
    (position) => {
      const { latitude, longitude, speed, heading } = position.coords;
      const coords = [longitude, latitude];
      window.lastKnownCoords = coords; // Store for route loading

      // Update vehicle marker position
      vehicleMarker.setLngLat(coords).setPopup(new maplibregl.Popup().setText('FlowPilot')).togglePopup();

      // Rotate marker based on bearing (direction of movement)
      if (heading !== null) {
        vehicleMarker.getElement().style.transform = `rotate(${heading}rad)`;
      }

      // Fly map to current position, keeping it centered
      map.flyTo({
        center: coords,
        zoom: 17,
        essential: true
      });

      // Update speedometer
      const speedKmh = (speed * 3.6).toFixed(0);
      speedometer.textContent = `${speedKmh} km/h`;

      // Update current street badge
      currentStreetBadge.textContent = `${latitude.toFixed(4).toString().replace('.', ',')}, ${longitude.toFixed(4).toString().replace('.', ',')}`;

      // If route is active, check proximity to next step
      if (isNavigating && routeSteps.length > 0 && currentStepIndex < routeSteps.length) {
        checkProximityToStep(coords);
      }
    },
    (error) => {
      console.error('Erro na geolocalização:', error);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000
    }
  );
}

// Initialize on DOM content loaded
document.addEventListener('DOMContentLoaded', initMap);

// Toggle navigation mode (called from HTML button or programmatically)
function ativarModoNavegacao(ativo = true) {
  isNavigating = ativo;
  
  navHeader.style.display = ativo ? 'flex' : 'none';
  navBottomBar.style.display = ativo ? 'flex' : 'none';
  searchBottomSheet.style.display = ativo ? 'none' : 'block';
  
  if (ativo) {
    // Show floating menu with search initially, then hide when route starts
    floatingMenu.classList.add('visible');
  } else {
    floatingMenu.classList.remove('visible');
  }
}