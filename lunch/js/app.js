function resolveApiOrigin() {
  const params = new URLSearchParams(window.location.search);
  const override = params.get('api');
  if (override) return override.replace(/\/$/, '');
  if (window.location.port === '8080') return '';
  return 'http://localhost:8080';
}

const API_ORIGIN = resolveApiOrigin();
const API_BASE = `${API_ORIGIN}/api/v1/lunch`;

const TYPE_COLORS = {
  cafeteria: '#00ffff',
  restaurant: '#ff00ff',
  casual: '#ffff00',
  all: '#00cccc',
};

let map = null;
let markers = [];
let infoWindow = null;
let spots = [];
let activeType = 'all';
let activeSpotId = null;
let searchCenter = null;
let searchCenterMarker = null;
let searchRadiusM = 1500;
let mapClientId = '';

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error('서버에 연결할 수 없습니다.');
  }
  if (!res.ok) throw new Error(`API 오류 (${res.status})`);
  const json = await res.json();
  if (!json.success) throw new Error(json.message || 'API 오류');
  return json.data;
}

function showStatus(message, isError = false) {
  document.getElementById('spotCount').textContent = message;
  if (isError) {
    document.getElementById('spotList').innerHTML =
      `<li class="list-message list-message--error">${message}</li>`;
  }
}

function showEmptyPrompt() {
  document.getElementById('spotCount').textContent = '위치를 입력해 주세요';
  document.getElementById('spotList').innerHTML =
    '<li class="list-message">역·건물명·주소를 입력하고<br/><strong>주변 검색</strong>을 눌러 주세요.</li>';
}

function formatPrice(min, max) {
  if (min == null && max == null) return '';
  if (min != null && max != null && min !== max) {
    return `${min.toLocaleString()}~${max.toLocaleString()}원`;
  }
  const price = min ?? max;
  return `${price.toLocaleString()}원`;
}

function loadNaverMapScript(clientId) {
  if (window.naver?.maps?.Service?.geocode) return Promise.resolve();

  const params = ['ncpKeyId', 'ncpClientId'];

  function loadWithCallback(param) {
    return new Promise((resolve, reject) => {
      const cb = `__naverReady_${param}`;
      window.navermap_authFailure = () => reject(new Error('NAVER_AUTH_FAIL'));

      window[cb] = () => {
        delete window[cb];
        if (window.naver?.maps?.Map) resolve();
        else reject(new Error('NAVER_INIT_FAIL'));
      };

      const script = document.createElement('script');
      script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?${param}=${encodeURIComponent(clientId)}&submodules=geocoder&callback=${cb}`;
      script.onerror = () => {
        delete window[cb];
        script.remove();
        reject(new Error('NAVER_LOAD_FAIL'));
      };
      document.head.appendChild(script);
    });
  }

  return params.reduce(
    (chain, param) => chain.catch(() => loadWithCallback(param)),
    Promise.reject()
  );
}

function toLatLng(lat, lng) {
  return new naver.maps.LatLng(Number(lat), Number(lng));
}

function radiusToZoom(radiusM) {
  if (radiusM <= 1000) return 16;
  if (radiusM <= 1500) return 15;
  if (radiusM <= 3000) return 14;
  return 13;
}

async function ensureMapReady() {
  if (map) return;
  if (!mapClientId) return;
  await loadNaverMapScript(mapClientId);
  if (!map) initMap();
}

function moveMapToSearchCenter() {
  if (!map || !searchCenter) return;

  const centerPos = toLatLng(searchCenter.latitude, searchCenter.longitude);

  const applyView = () => {
    if (spots.length === 0) {
      map.setCenter(centerPos);
      map.setZoom(radiusToZoom(searchRadiusM));
    } else {
      const bounds = new naver.maps.LatLngBounds();
      bounds.extend(centerPos);
      spots.forEach(spot => bounds.extend(toLatLng(spot.latitude, spot.longitude)));
      map.fitBounds(bounds, { top: 60, right: 60, bottom: 60, left: 60 });
    }
    renderSearchCenterMarker();
  };

  // fitBounds는 지도 크기 확정 후 호출해야 정확히 이동합니다.
  requestAnimationFrame(() => {
    applyView();
    setTimeout(applyView, 150);
  });
}

function getMapCenter() {
  if (searchCenter) {
    return toLatLng(searchCenter.latitude, searchCenter.longitude);
  }
  return new naver.maps.LatLng(37.4979, 127.0276);
}

function initMap() {
  const el = document.getElementById('map');
  map = new naver.maps.Map(el, {
    center: getMapCenter(),
    zoom: searchCenter ? 15 : 11,
    zoomControl: true,
    zoomControlOptions: { position: naver.maps.Position.TOP_RIGHT },
  });
  infoWindow = new naver.maps.InfoWindow({ maxWidth: 300 });

  const resizeMap = () => {
    if (!map || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w > 0 && h > 0) map.setSize(new naver.maps.Size(w, h));
  };

  naver.maps.Event.once(map, 'init', resizeMap);
  naver.maps.Event.once(map, 'tilesloaded', () => hideMapSetup());
  setTimeout(resizeMap, 100);
  setTimeout(resizeMap, 500);
  window.addEventListener('resize', resizeMap);
}

function clearSearchCenterMarker() {
  if (searchCenterMarker) {
    searchCenterMarker.setMap(null);
    searchCenterMarker = null;
  }
}

function renderSearchCenterMarker() {
  if (!map) return;
  clearSearchCenterMarker();
  if (!searchCenter) return;

  const pos = toLatLng(searchCenter.latitude, searchCenter.longitude);
  searchCenterMarker = new naver.maps.Marker({
    position: pos,
    map,
    title: searchCenter.label,
    icon: {
      content: `<div style="background:#00ffff;color:#0a0a0a;padding:6px 10px;border-radius:14px;font-size:11px;font-weight:700;white-space:nowrap;box-shadow:0 2px 8px rgba(0,255,255,.4);border:2px solid #fff;">📍 ${searchCenter.query}</div>`,
      anchor: new naver.maps.Point(0, 0),
    },
    zIndex: 200,
  });
}

function clearMarkers() {
  markers.forEach(m => m.setMap(null));
  markers = [];
}

function renderMarkers(spotList) {
  if (!map) return;
  clearMarkers();

  spotList.forEach(spot => {
    const pos = toLatLng(spot.latitude, spot.longitude);
    const color = TYPE_COLORS[spot.typeSlug] || TYPE_COLORS.all;

    const marker = new naver.maps.Marker({
      position: pos,
      map,
      title: spot.name,
      icon: {
        content: `<div style="background:${color};color:#fff;padding:4px 8px;border-radius:12px;font-size:11px;font-weight:600;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.25);border:2px solid #fff;">${spot.typeIcon || '🍽️'} ${spot.name}</div>`,
        anchor: new naver.maps.Point(0, 0),
      },
    });

    naver.maps.Event.addListener(marker, 'click', () => {
      selectSpot(spot.id);
      const badges = [
        spot.soloDining ? '🪑 혼밥' : '',
        spot.workerVerified ? '✅ 인증' : '',
      ].filter(Boolean).join(' ');
      infoWindow.setContent(`<div style="padding:8px;min-width:200px;"><strong>${spot.name}</strong><br/><span style="color:#666;font-size:12px;">${spot.typeName}${badges ? ' · ' + badges : ''}</span><br/><span style="color:#f59e0b;font-size:12px;">★ ${spot.rating}</span>${spot.menuHighlight ? `<br/><span style="font-size:11px;color:#444;">${spot.menuHighlight}</span>` : ''}</div>`);
      infoWindow.open(map, marker);
    });
    markers.push(marker);
  });

  moveMapToSearchCenter();
}

function focusSpotOnMap(spot) {
  if (!map || !spot) return;
  map.setCenter(toLatLng(spot.latitude, spot.longitude));
  map.setZoom(16);
}

function renderMapSetupInfo(config) {
  const pageUrl = window.location.origin + window.location.pathname.replace(/\/$/, '');
  const urls = Array.from(new Set([
    pageUrl,
    `${pageUrl}/`,
    ...(config?.webUrls || []),
    window.location.origin,
    `${API_ORIGIN}/lunch`,
    `${API_ORIGIN}/lunch/`,
  ]));
  document.getElementById('mapSetupPageUrl').textContent = pageUrl;
  document.getElementById('mapSetupClientId').textContent = config?.clientId || '-';
  document.getElementById('mapSetupUrls').textContent = urls.join('\n');
}

function showMapSetup(reason) {
  document.getElementById('mapSetupReason').textContent = reason || '';
  document.getElementById('mapSetup').classList.remove('hidden');
}

function hideMapSetup() {
  document.getElementById('mapSetup').classList.add('hidden');
}

function watchMapAuthFailure() {
  window.navermap_authFailure = () => {
    showMapSetup('네이버 지도 Open API 인증 실패 — NCP Web 서비스 URL에 이 페이지 주소를 추가하세요.');
  };
}

function initRadiusButtons() {
  document.getElementById('radiusList').querySelectorAll('.chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      searchRadiusM = Number(btn.dataset.radius);
      updateRadiusButtons();
      if (searchCenter) searchByLocation();
    });
  });
  updateRadiusButtons();
}

function updateRadiusButtons() {
  document.getElementById('radiusList').querySelectorAll('.chip-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.radius) === searchRadiusM);
  });
}

function renderTypes(types) {
  const el = document.getElementById('typeList');
  el.innerHTML = types.map(t => `
    <button class="chip-btn ${t.slug === activeType ? 'active' : ''}"
            data-slug="${t.slug}">${t.icon || ''} ${t.name}</button>
  `).join('');
  el.querySelectorAll('.chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeType = btn.dataset.slug;
      renderTypes(types);
      if (searchCenter) loadSpots();
    });
  });
}

function formatDistance(m) {
  if (m == null) return '';
  if (m < 1000) return `${m}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

function renderSpotList(spotList) {
  const countLabel = searchCenter
    ? `${searchCenter.query} 주변 ${searchRadiusM >= 1000 ? (searchRadiusM / 1000) + 'km' : searchRadiusM + 'm'}`
    : '검색 대기';
  document.getElementById('spotCount').textContent = `${countLabel} · 맛집 ${spotList.length}개`;

  const el = document.getElementById('spotList');
  if (!searchCenter) {
    showEmptyPrompt();
    return;
  }
  if (spotList.length === 0) {
    const naverUrl = `https://map.naver.com/v5/search/${encodeURIComponent(searchCenter.query + ' 맛집')}`;
    el.innerHTML = `<li class="list-message">
      반경 내 등록 맛집이 없습니다.<br/>
      <a href="${naverUrl}" target="_blank" rel="noopener">네이버 지도에서 더 찾기</a>
    </li>`;
    return;
  }

  el.innerHTML = spotList.map(s => `
    <li class="spot-item ${s.id === activeSpotId ? 'active' : ''}" data-id="${s.id}">
      <img class="spot-item__thumb" src="${s.imageUrl || ''}" alt="${s.name}" loading="lazy"
           onerror="this.style.display='none'" />
      <div class="spot-item__info">
        <div class="spot-item__meta">
          <span class="spot-item__type">${s.typeIcon || ''} ${s.typeName}</span>
          ${s.soloDining ? '<span class="spot-item__badge">혼밥</span>' : ''}
          ${s.workerVerified ? '<span class="spot-item__badge">인증</span>' : ''}
          ${s.id < 0 ? '<span class="spot-item__badge">실시간</span>' : ''}
        </div>
        <div class="spot-item__name">${s.name}</div>
        ${s.menuHighlight ? `<div class="spot-item__menu">${s.menuHighlight}</div>` : ''}
        ${formatPrice(s.lunchPriceMin, s.lunchPriceMax) ? `<div class="spot-item__price">${formatPrice(s.lunchPriceMin, s.lunchPriceMax)}</div>` : ''}
        <div class="spot-item__rating">★ ${s.rating} (${s.reviewCount})${s.distanceM != null ? ` · ${formatDistance(s.distanceM)}` : ''}</div>
      </div>
    </li>
  `).join('');

  el.querySelectorAll('.spot-item').forEach(item => {
    item.addEventListener('click', () => selectSpot(Number(item.dataset.id)));
  });
}

function renderDetail(spot) {
  document.getElementById('detailPanel').classList.add('open');
  document.getElementById('detailContent').innerHTML = `
    ${spot.imageUrl ? `<img class="detail__image" src="${spot.imageUrl}" alt="${spot.name}" />` : ''}
    <div class="detail__body">
      <div class="detail__badges">
        <span class="detail__badge detail__badge--type">${spot.typeIcon || ''} ${spot.typeName}</span>
        ${spot.soloDining ? '<span class="detail__badge detail__badge--solo">🪑 혼밥 가능</span>' : ''}
        ${spot.workerVerified ? '<span class="detail__badge detail__badge--verified">✅ 직장인 인증</span>' : ''}
      </div>
      <h2 class="detail__name">${spot.name}</h2>
      ${spot.buildingName ? `<div class="detail__building">📍 ${spot.buildingName}</div>` : ''}
      ${spot.menuHighlight ? `<div class="detail__menu"><strong>대표 메뉴</strong><br/>${spot.menuHighlight}</div>` : ''}
      <div class="detail__rating">★ ${spot.rating} · 리뷰 ${spot.reviewCount}개${spot.distanceM != null ? ` · ${formatDistance(spot.distanceM)}` : ''}</div>
      <p class="detail__desc">${spot.description || ''}</p>
      <div class="detail__row"><span class="detail__label">주소</span><span>${spot.roadAddress || spot.address}</span></div>
      <div class="detail__row"><span class="detail__label">전화</span><span>${spot.phone || '-'}</span></div>
      <div class="detail__row"><span class="detail__label">점심</span><span>${spot.openLunch || '-'} ~ ${spot.closeLunch || '-'}</span></div>
      <div class="detail__row"><span class="detail__label">가격</span><span>${formatPrice(spot.lunchPriceMin, spot.lunchPriceMax) || '-'}</span></div>
      <div class="detail__actions">
        <a class="detail__btn detail__btn--primary"
           href="https://map.naver.com/v5/search/${encodeURIComponent(spot.name + ' ' + (spot.roadAddress || spot.address))}"
           target="_blank" rel="noopener">길찾기</a>
        <button class="detail__btn detail__btn--outline" id="focusMapBtn">지도에서 보기</button>
      </div>
    </div>`;
  document.getElementById('focusMapBtn')?.addEventListener('click', () => focusSpotOnMap(spot));
}

function selectSpot(id) {
  activeSpotId = id;
  const spot = spots.find(s => s.id === id);
  if (!spot) return;
  renderSpotList(spots);
  renderDetail(spot);
  focusSpotOnMap(spot);
}

function geocodeOnClient(query) {
  return new Promise((resolve, reject) => {
    if (!window.naver?.maps?.Service?.geocode) {
      reject(new Error('지도 지오코더를 사용할 수 없습니다.'));
      return;
    }

    naver.maps.Service.geocode({ query }, (status, response) => {
      if (status !== naver.maps.Service.Status.OK) {
        reject(new Error('위치를 찾을 수 없습니다.'));
        return;
      }
      const addresses = response?.v2?.addresses;
      if (!addresses?.length) {
        reject(new Error('위치를 찾을 수 없습니다.'));
        return;
      }
      const first = addresses[0];
      resolve({
        query,
        label: first.roadAddress || first.jibunAddress || query,
        latitude: parseFloat(first.y),
        longitude: parseFloat(first.x),
      });
    });
  });
}

async function resolveLocation(query) {
  try {
    const soloOnly = document.getElementById('soloOnlyFilter').checked;
    const verifiedOnly = document.getElementById('verifiedOnlyFilter').checked;
    const spotKeyword = document.getElementById('keywordInput').value.trim();
    const params = new URLSearchParams({ query, radiusM: String(searchRadiusM) });
    if (activeType && activeType !== 'all') params.set('type', activeType);
    if (spotKeyword) params.set('keyword', spotKeyword);
    if (soloOnly) params.set('soloOnly', 'true');
    if (verifiedOnly) params.set('verifiedOnly', 'true');

    const result = await fetchJson(`${API_BASE}/locations/search?${params}`);
    return {
      center: {
        query: result.location.query,
        label: result.location.label,
        latitude: result.location.latitude,
        longitude: result.location.longitude,
      },
      spots: result.spots,
    };
  } catch {
    if (!window.naver?.maps?.Service?.geocode && mapClientId) {
      await loadNaverMapScript(mapClientId);
    }
    const center = await geocodeOnClient(query);
    const params = new URLSearchParams({
      nearLat: String(center.latitude),
      nearLng: String(center.longitude),
      radiusM: String(searchRadiusM),
      nearQuery: query,
    });
    const spotKeyword = document.getElementById('keywordInput').value.trim();
    const soloOnly = document.getElementById('soloOnlyFilter').checked;
    const verifiedOnly = document.getElementById('verifiedOnlyFilter').checked;
    if (activeType && activeType !== 'all') params.set('type', activeType);
    if (spotKeyword) params.set('keyword', spotKeyword);
    if (soloOnly) params.set('soloOnly', 'true');
    if (verifiedOnly) params.set('verifiedOnly', 'true');

    const nearbySpots = await fetchJson(`${API_BASE}/spots?${params}`);
    return { center, spots: nearbySpots };
  }
}

async function applySearchResults() {
  renderSpotList(spots);
  await ensureMapReady();
  renderMarkers(spots);
}

async function searchByLocation() {
  const query = document.getElementById('locationInput').value.trim();
  if (!query) {
    searchCenter = null;
    spots = [];
    showEmptyPrompt();
    if (map) renderMarkers([]);
    return;
  }

  document.getElementById('spotCount').textContent = '검색 중...';

  try {
    const { center, spots: results } = await resolveLocation(query);
    searchCenter = {
      query: center.query,
      label: center.label,
      latitude: Number(center.latitude),
      longitude: Number(center.longitude),
    };
    spots = results;
    await applySearchResults();
  } catch {
    showStatus(`'${query}' 위치를 찾을 수 없습니다. 역·건물명·주소를 다시 확인해 주세요.`, true);
  }
}

async function loadSpots() {
  if (!searchCenter) {
    showEmptyPrompt();
    return;
  }

  try {
    const keyword = document.getElementById('keywordInput').value.trim();
    const soloOnly = document.getElementById('soloOnlyFilter').checked;
    const verifiedOnly = document.getElementById('verifiedOnlyFilter').checked;

    const params = new URLSearchParams({
      nearLat: String(searchCenter.latitude),
      nearLng: String(searchCenter.longitude),
      radiusM: String(searchRadiusM),
      nearQuery: searchCenter.query,
    });
    if (activeType && activeType !== 'all') params.set('type', activeType);
    if (keyword) params.set('keyword', keyword);
    if (soloOnly) params.set('soloOnly', 'true');
    if (verifiedOnly) params.set('verifiedOnly', 'true');

    spots = await fetchJson(`${API_BASE}/spots?${params}`);
    await applySearchResults();
  } catch (err) {
    showStatus(`검색 실패: ${err.message}`, true);
  }
}

async function initNaverMapLayer(clientId) {
  if (!clientId) {
    showMapSetup('Client ID가 설정되지 않았습니다.');
    return;
  }
  await loadNaverMapScript(clientId);
  initMap();
  renderMarkers(spots);
  watchMapAuthFailure();
}

async function init() {
  if (window.location.protocol === 'file:') {
    showStatus('로컬 서버로 열어 주세요 (예: Live Server)', true);
    showMapSetup('HTML 파일을 직접 열면 동작하지 않습니다.');
    return;
  }

  try {
    const [mapConfig, types] = await Promise.all([
      fetch(`${API_ORIGIN}/api/v1/config/naver-map`).then(r => r.json()).then(j => j.data),
      fetchJson(`${API_BASE}/types`),
    ]);

    initRadiusButtons();
    renderTypes(types);
    renderMapSetupInfo(mapConfig);
    mapClientId = (mapConfig?.clientId || '').trim();
    showEmptyPrompt();

    try {
      await initNaverMapLayer(mapClientId);
    } catch (err) {
      console.error(err);
      showMapSetup('네이버 지도 인증 실패 — NCP Web URL에 이 페이지 주소를 추가하세요.');
    }
  } catch (err) {
    console.error(err);
    showStatus(`연결 실패: ${err.message}`, true);
    showMapSetup(`API 연결 실패 — spring-app을 실행했는지 확인하세요 (${err.message})`);
  }
}

document.getElementById('locationSearchBtn').addEventListener('click', searchByLocation);
document.getElementById('locationInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') searchByLocation();
});
document.getElementById('keywordSearchBtn').addEventListener('click', () => {
  if (searchCenter) loadSpots();
  else searchByLocation();
});
document.getElementById('keywordInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (searchCenter) loadSpots();
    else searchByLocation();
  }
});
document.getElementById('soloOnlyFilter').addEventListener('change', () => {
  if (searchCenter) loadSpots();
});
document.getElementById('verifiedOnlyFilter').addEventListener('change', () => {
  if (searchCenter) loadSpots();
});
document.getElementById('detailClose').addEventListener('click', () => {
  document.getElementById('detailPanel').classList.remove('open');
  activeSpotId = null;
  renderSpotList(spots);
});
document.getElementById('mapSetupClose')?.addEventListener('click', hideMapSetup);

init();
