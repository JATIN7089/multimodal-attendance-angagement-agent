(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;

  let session = null;
  let rosterFilter = 'all';
  let searchTerm = '';
  let mediaStream = null;
  let audioContext = null;
  let analyser = null;
  let detectorPromise = null;
  let detectorReady = false;
  let detectorGeneration = 0;
  let detectorOptions = null;
  let detectorOptionsCache = new Map();
  let emptyDetectionFrames = 0;
  let lastRecoveryAt = 0;
  let lastLoopTimestamp = 0;
  let smoothedFps = 0;
  let trackedFaces = new Map();
  let nextTrackId = 1;
  let countHistory = [];
  let consecutiveDetectionErrors = 0;
  let pollRefreshTimer = null;

  const els = {
    elapsed: $('#elapsedTime'),
    sessionControl: $('#sessionControl'),
    present: $('#presentCount'),
    engagement: $('#engagementCount'),
    participation: $('#participationCount'),
    interactions: $('#interactionCount'),
    attention: $('#attentionCount'),
    attendanceRing: $('#attendanceRing'),
    suggestions: $('#suggestions'),
    attentionList: $('#attentionList'),
    rosterBody: $('#rosterBody'),
    rosterShowing: $('#rosterShowing'),
    chart: $('#trendChart'),
    chartLine: $('#trendLine'),
    chartArea: $('#trendArea'),
    chartDots: $('#trendDots'),
    chartLabels: $('#chartLabels'),
    cameraStage: $('#cameraStage'),
    cameraVideo: $('#cameraVideo'),
    detectionCanvas: $('#detectionCanvas'),
    cameraButton: $('#cameraButton'),
    cameraSource: $('#cameraSource'),
    detectionSensitivity: $('#detectionSensitivity'),
    cameraPeople: $('#cameraPeople'),
    cameraMode: $('#cameraMode'),
    cameraDiagnostics: $('#cameraDiagnostics'),
    recordingBadge: $('#recordingBadge'),
    detectorStatus: $('#detectorStatus'),
    detectorStatusTitle: $('#detectorStatusTitle'),
    detectorStatusText: $('#detectorStatusText'),
    cameraState: $('#cameraState'),
    cameraStatusTitle: $('#cameraStatusTitle'),
    cameraStatusText: $('#cameraStatusText'),
    visualDescription: $('#visualDescription'),
    visualStatus: $('#visualStatus'),
    movementDescription: $('#movementDescription'),
    movementStatus: $('#movementStatus'),
    audioPercent: $('#audioPercent'),
    audioDescription: $('#audioDescription'),
    constellation: $('#constellation'),
    sessionEvents: $('#sessionEvents'),
    pollModal: $('#pollModal'),
    pollForm: $('#pollForm'),
    pollLive: $('#pollLive'),
    pollBars: $('#pollBars'),
    momentModal: $('#momentModal'),
  };

  const safe = (value) => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return response.json();
  }

  function formatElapsed(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'error' : ''}`;
    toast.textContent = message;
    $('#toastRegion').append(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      setTimeout(() => toast.remove(), 250);
    }, 3200);
  }

  function renderSession() {
    if (!session) return;
    const { summary } = session;
    $('#sessionTitle').textContent = session.title;
    els.elapsed.textContent = formatElapsed(session.elapsed);
    els.present.textContent = summary.present;
    els.engagement.textContent = summary.engagement;
    els.participation.textContent = summary.participation;
    els.interactions.textContent = `${summary.interactions} interactions`;
    els.attention.textContent = summary.lowAttention;
    // Live camera indicators are updated only by real browser sensor data.
    // Keeping demo session metrics separate prevents simulated values from
    // being presented as camera detections.

    const attendancePercent = Math.round(100 * summary.present / summary.total);
    els.attendanceRing.style.background = `conic-gradient(#a98bff 0 ${attendancePercent}%, #24292e ${attendancePercent}%)`;
    $('span', els.attendanceRing).textContent = `${attendancePercent}%`;

    els.sessionControl.innerHTML = session.running
      ? `${icon('pause')}<span>Pause</span>`
      : `${icon('play')}<span>Resume</span>`;

    renderSuggestions();
    renderAttention();
    renderRoster();
    renderChart();
    renderConstellation();
    renderEvents();
    renderPoll();
  }

  function renderSuggestions() {
    els.suggestions.innerHTML = session.suggestions.map((suggestion) => {
      const iconName = suggestion.icon === 'check' ? 'usercheck' : suggestion.icon === 'trend' ? 'chart' : 'spark';
      return `<article class="suggestion ${safe(suggestion.type)}">
        <div class="suggestion-icon">${icon(iconName)}</div>
        <div class="suggestion-copy">
          <h3>${safe(suggestion.title)}</h3>
          <p>${safe(suggestion.body)}</p>
          <button type="button" data-suggestion="${safe(suggestion.cta)}">${safe(suggestion.cta)} →</button>
        </div>
      </article>`;
    }).join('');
  }

  function renderAttention() {
    const low = session.students
      .filter((student) => student.status !== 'absent')
      .sort((a, b) => a.engagement - b.engagement)
      .slice(0, 3);
    els.attentionList.innerHTML = low.map((student) => `<div class="attention-person">
      <div class="person-avatar">${safe(student.initials)}<i></i></div>
      <div><b>${safe(student.name)}</b><span>${student.engagement < 62 ? 'Low activity · 8 min' : 'Attention trending down'}</span></div>
      <div class="engagement-score"><strong>${student.engagement}%</strong><small>engaged</small></div>
    </div>`).join('');
  }

  function engagementColor(value) {
    if (value >= 75) return '#25ad89';
    if (value >= 60) return '#e8a239';
    return '#ed6270';
  }

  function renderRoster() {
    const filtered = session.students.filter((student) => {
      const matchesStatus = rosterFilter === 'all' || student.status === rosterFilter || (rosterFilter === 'low' && student.status !== 'absent' && student.engagement < 68);
      const matchesSearch = student.name.toLowerCase().includes(searchTerm);
      return matchesStatus && matchesSearch;
    });

    const counts = {
      all: session.students.length,
      present: session.students.filter((s) => s.status === 'present').length,
      late: session.students.filter((s) => s.status === 'late').length,
      absent: session.students.filter((s) => s.status === 'absent').length,
    };
    $$('#filterTabs button').forEach((button) => {
      const filter = button.dataset.filter;
      button.classList.toggle('active', filter === rosterFilter);
      const count = $('span', button);
      if (count) count.textContent = counts[filter];
    });

    if (!filtered.length) {
      els.rosterBody.innerHTML = '<tr class="empty-row"><td colspan="6">No learners match this view.</td></tr>';
    } else {
      els.rosterBody.innerHTML = filtered.map((student) => {
        const absent = student.status === 'absent';
        const color = engagementColor(student.engagement);
        return `<tr>
          <td><div class="student-cell"><div class="person-avatar">${safe(student.initials)}</div><div><b>${safe(student.name)}</b><span>STU-${String(student.id).padStart(3, '0')}</span></div></div></td>
          <td><span class="status-badge status-${safe(student.status)}">${student.status[0].toUpperCase() + student.status.slice(1)}</span></td>
          <td>${absent ? '<span>—</span>' : `<div class="engagement-cell"><div class="engagement-bar"><i style="width:${student.engagement}%;--bar-color:${color}"></i></div><span style="color:${color}">${student.engagement}%</span></div>`}</td>
          <td>${absent ? '—' : `<div class="interaction-cell">${icon('hand')}<span>${student.interactions}</span></div>`}</td>
          <td>${safe(student.lastSeen)}</td>
          <td><button class="icon-button row-menu" aria-label="More options for ${safe(student.name)}">${icon('more')}</button></td>
        </tr>`;
      }).join('');
    }
    els.rosterShowing.textContent = `Showing ${filtered.length} of ${session.students.length} learners`;
  }

  function renderChart() {
    const points = session.timeline;
    if (!points.length) return;
    const width = 760;
    const top = 10;
    const bottom = 200;
    const xStep = points.length === 1 ? 0 : width / (points.length - 1);
    const coordinates = points.map((point, index) => ({
      x: index * xStep,
      y: bottom - (point.value / 100) * (bottom - top),
      ...point,
    }));
    const line = coordinates.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
    els.chartLine.setAttribute('d', line);
    els.chartArea.setAttribute('d', `${line} L${width},${bottom} L0,${bottom} Z`);
    els.chartDots.innerHTML = coordinates.map((point) => `<circle class="trend-dot" cx="${point.x}" cy="${point.y}" r="3.5"><title>${safe(point.label)}: ${point.value}%</title></circle>`).join('');
    const indexes = [0, Math.floor((points.length - 1) * .25), Math.floor((points.length - 1) * .5), Math.floor((points.length - 1) * .75), points.length - 1];
    els.chartLabels.innerHTML = [...new Set(indexes)].map((index) => `<span>${safe(points[index].label)}</span>`).join('');
  }

  function renderConstellation() {
    if (!els.constellation || !session?.students) return;
    els.constellation.innerHTML = session.students.map((student) => {
      const absent = student.status === 'absent';
      const quiet = !absent && student.engagement < 70;
      const color = absent ? '#343d3f' : quiet || student.status === 'late' ? '#f6ba5a' : '#c8ff61';
      const glow = absent ? 0 : Math.max(5, Math.round(student.engagement / 5));
      const classes = `${student.status === 'late' ? 'late' : ''} ${absent ? 'absent' : ''}`.trim();
      const score = absent ? 'away' : `${student.engagement}%`;
      return `<button class="learner-node ${classes}" style="--node-color:${color};--glow:${glow}px" data-student-id="${student.id}" data-score="${score}" aria-label="Open ${safe(student.name)} in learner ledger">${safe(student.initials)}</button>`;
    }).join('');
  }

  function renderEvents() {
    if (!els.sessionEvents) return;
    const events = session?.events || [];
    if (!events.length) {
      els.sessionEvents.innerHTML = '<div class="empty-event">No moments marked yet.</div>';
      return;
    }
    els.sessionEvents.innerHTML = [...events].reverse().slice(0, 6).map((event) => `<article class="event-item ${safe(event.type)}">
      <time>${safe(event.time)}</time><i></i><div><b>${safe(event.title)}</b><span>${safe(event.detail)}</span></div>
    </article>`).join('');
  }

  function renderPoll() {
    if (!session?.poll) return;
    const poll = session.poll;
    const launchLabel = $('#launchPoll span');
    if (launchLabel) launchLabel.textContent = poll.active ? 'View live poll' : 'Launch pulse poll';
    if (!poll.active) {
      els.pollForm.hidden = false;
      els.pollLive.hidden = true;
      return;
    }
    els.pollForm.hidden = true;
    els.pollLive.hidden = false;
    $('#pollLiveQuestion').textContent = poll.question;
    $('#pollResponseCount').textContent = `${poll.responses} ${poll.responses === 1 ? 'response' : 'responses'}`;
    const total = Math.max(poll.responses, 1);
    els.pollBars.innerHTML = poll.options.map((option) => {
      const percentage = Math.round(100 * option.votes / total);
      return `<div class="poll-bar"><span>${safe(option.label)}</span><div><i style="width:${percentage}%"></i></div><b>${percentage}%</b></div>`;
    }).join('');
  }

  async function loadSession() {
    try {
      session = await api('/api/session');
      renderSession();
    } catch (error) {
      showToast('Could not load the live session', 'error');
      console.error(error);
    }
  }

  async function toggleSession() {
    if (!session) return;
    const action = session.running ? 'stop' : 'start';
    els.sessionControl.disabled = true;
    try {
      session = await api('/api/session/control', {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      renderSession();
      showToast(action === 'stop' ? 'Session paused — tracking is on hold' : 'Session resumed — live signals active');
    } catch (error) {
      showToast('Could not update the session', 'error');
    } finally {
      els.sessionControl.disabled = false;
    }
  }

  async function tick() {
    if (!session?.running) return;
    try {
      const level = analyser ? readAudioLevel() : session.audioLevel;
      session = await api('/api/session/tick', {
        method: 'POST',
        body: JSON.stringify({ seconds: 5, audioLevel: level }),
      });
      renderSession();
    } catch (error) {
      console.warn('Live update skipped', error);
    }
  }

  function readAudioLevel() {
    if (!analyser) return 0;
    const values = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(values);
    const meanSquare = values.reduce((sum, value) => {
      const normalized = (value - 128) / 128;
      return sum + normalized * normalized;
    }, 0) / Math.max(values.length, 1);
    return Math.max(0, Math.min(100, Math.round(Math.sqrt(meanSquare) * 360)));
  }

  function setDetectorStatus(title = '', text = '', type = 'loading') {
    if (!title) {
      els.detectorStatus.hidden = true;
      els.detectorStatus.classList.remove('error');
      return;
    }
    els.detectorStatus.hidden = false;
    els.detectorStatus.classList.toggle('error', type === 'error');
    els.detectorStatusTitle.textContent = title;
    els.detectorStatusText.textContent = text;
  }

  function setCameraState(state, title, text) {
    els.cameraState.dataset.state = state;
    els.cameraStatusTitle.textContent = title;
    els.cameraStatusText.textContent = text;
  }

  function cameraErrorMessage(error) {
    const name = error?.name || '';
    const permissionsPolicy = document.permissionsPolicy || document.featurePolicy;
    if (!window.isSecureContext) return 'Camera needs HTTPS or localhost. Open the secure preview URL and try again.';
    if (permissionsPolicy?.allowsFeature && !permissionsPolicy.allowsFeature('camera')) {
      return 'This embedded preview blocks camera access. Open the preview in a new browser tab and try again.';
    }
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Camera access is blocked. Allow Camera in the browser site controls, then try again.';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No camera was found. Connect a camera and try again.';
    if (name === 'NotReadableError' || name === 'TrackStartError') return 'The camera is busy in another app. Close that app and try again.';
    if (name === 'OverconstrainedError') return 'This camera does not support the requested mode. Try another camera.';
    return error?.message ? `Camera could not start: ${error.message}` : 'Camera could not start. Check browser permissions and try again.';
  }

  async function loadDetectorModels() {
    if (detectorReady) return;
    if (detectorPromise) return detectorPromise;
    detectorPromise = (async () => {
      if (!window.faceapi) throw new Error('The local detection library did not load. Refresh the page and try again.');
      const { faceapi } = window;
      try {
        const backendSet = await faceapi.tf.setBackend('webgl');
        if (!backendSet) await faceapi.tf.setBackend('cpu');
      } catch (webglError) {
        await faceapi.tf.setBackend('cpu');
      }
      await faceapi.tf.ready();
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri('/static/models'),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri('/static/models'),
      ]);
      detectorOptionsCache.clear();
      updateDetectorSensitivity();
      detectorReady = true;
    })().catch((error) => {
      detectorPromise = null;
      throw error;
    });
    return detectorPromise;
  }

  function detectorProfileConfig(profile = els.detectionSensitivity?.value || 'balanced') {
    // TinyFaceDetector accepts only these input sizes. Higher sizes cost more CPU/GPU
    // but preserve more detail for small or distant faces.
    const configs = {
      performance: { inputSize: 320, scoreThreshold: 0.42 },
      balanced: { inputSize: 512, scoreThreshold: 0.32 },
      high: { inputSize: 608, scoreThreshold: 0.24 },
    };
    return configs[profile] || configs.balanced;
  }

  function updateDetectorSensitivity() {
    const { faceapi } = window;
    if (!faceapi) return;
    const config = detectorProfileConfig();
    const key = `${config.inputSize}:${config.scoreThreshold}`;
    if (!detectorOptionsCache.has(key)) {
      detectorOptionsCache.set(key, new faceapi.TinyFaceDetectorOptions(config));
    }
    detectorOptions = detectorOptionsCache.get(key);
  }

  async function populateCameraSources() {
    const select = els.cameraSource;
    if (!select || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter((device) => device.kind === 'videoinput');
      const selected = select.value;
      select.replaceChildren(new Option('Default camera', ''));
      cameras.forEach((camera, index) => {
        select.add(new Option(camera.label || `Camera ${index + 1}`, camera.deviceId));
      });
      if (selected && cameras.some((camera) => camera.deviceId === selected)) select.value = selected;
      select.disabled = cameras.length < 2;
      if (cameras.length > 1) select.disabled = false;
    } catch (error) {
      console.warn('Could not enumerate cameras', error);
    }
  }

  function waitForVideo(video) {
    if (video.readyState >= 2 && video.videoWidth) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Camera started but did not provide video frames.')), 10000);
      video.addEventListener('loadeddata', () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
      video.addEventListener('error', () => {
        window.clearTimeout(timeout);
        reject(new Error('The browser could not read the camera stream.'));
      }, { once: true });
    });
  }

  async function toggleCamera() {
    if (mediaStream) {
      stopCamera();
      showToast('Camera and local AI detection stopped');
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      const message = !window.isSecureContext
        ? 'Camera requires a secure HTTPS preview or localhost'
        : 'Camera access is not supported in this browser';
      setCameraState('error', 'Camera unavailable', message);
      setDetectorStatus('Camera unavailable', message, 'error');
      showToast(message, 'error');
      return;
    }

    const generation = ++detectorGeneration;
    els.cameraButton.disabled = true;
    els.cameraButton.innerHTML = `${icon('camera')}<span>Starting camera…</span>`;
    setCameraState('loading', 'Starting camera', 'Requesting camera and microphone permission…');
    setDetectorStatus('Preparing private AI detection…', 'Models run entirely inside this browser');

    try {
      const modelTask = loadDetectorModels();
      // Keep a concurrent model failure handled even if camera permission fails first.
      modelTask.catch(() => {});
      const selectedDeviceId = els.cameraSource?.value;
      const videoConstraints = {
        ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : { facingMode: 'user' }),
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 24, max: 30 },
      };
      const constraints = {
        video: videoConstraints,
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      };
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (firstError) {
        // Never silently switch to a different webcam when the user explicitly selected one.
        if (selectedDeviceId && ['NotFoundError', 'OverconstrainedError'].includes(firstError.name)) {
          throw firstError;
        }
        // A missing/blocked microphone must not prevent visual detection.
        if (['NotAllowedError', 'PermissionDeniedError', 'NotFoundError', 'OverconstrainedError'].includes(firstError.name)) {
          mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } else {
          throw firstError;
        }
      }
      if (generation !== detectorGeneration) return;
      await populateCameraSources();

      els.cameraVideo.srcObject = mediaStream;
      await waitForVideo(els.cameraVideo);
      await els.cameraVideo.play();
      els.cameraStage.classList.add('camera-on');
      els.cameraButton.innerHTML = `${icon('x')}<span>Stop vision</span>`;
      els.cameraMode.textContent = 'LOCAL AI';
      els.recordingBadge.classList.add('is-live');
      els.cameraPeople.textContent = '0';
      $('#detectionLabel').textContent = 'faces';
      setCameraState('loading', 'Loading AI detector', 'Camera is live; preparing local face-presence model…');
      setupAudio(mediaStream);

      const videoTrack = mediaStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.addEventListener('ended', () => {
          if (mediaStream && generation === detectorGeneration) {
            stopCamera();
            setCameraState('error', 'Camera disconnected', 'Reconnect the camera and start detection again.');
            showToast('Camera was disconnected', 'error');
          }
        }, { once: true });
      }

      await modelTask;
      if (!mediaStream || generation !== detectorGeneration) return;
      setDetectorStatus();
      setCameraState('working', 'AI detection active', 'Looking for real face-presence signals…');
      runDetectionLoop(generation);
      showToast('Real face detection is active — frames stay on this device');
    } catch (error) {
      console.error('Camera startup failed', error);
      const cameraErrorNames = new Set([
        'NotAllowedError', 'PermissionDeniedError', 'NotFoundError', 'DevicesNotFoundError',
        'NotReadableError', 'TrackStartError', 'OverconstrainedError', 'SecurityError',
      ]);
      const modelFailure = !cameraErrorNames.has(error?.name)
        && !String(error?.message || '').toLowerCase().includes('camera');
      const message = modelFailure
        ? `Local AI model could not start: ${error.message || 'unknown error'}`
        : cameraErrorMessage(error);
      stopCamera();
      els.cameraMode.textContent = 'ERROR';
      els.cameraButton.innerHTML = `${icon('camera')}<span>Retry vision</span>`;
      setCameraState('error', 'Detection unavailable', message);
      setDetectorStatus('Detection could not start', message, 'error');
      showToast(message, 'error');
    } finally {
      els.cameraButton.disabled = false;
    }
  }

  function setupAudio(stream) {
    if (!stream.getAudioTracks().length || !(window.AudioContext || window.webkitAudioContext)) {
      els.audioPercent.textContent = 'Off';
      els.audioDescription.textContent = 'Microphone unavailable · visual AI still active';
      return;
    }
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      if (audioContext.state === 'suspended') audioContext.resume();
    } catch (error) {
      analyser = null;
      els.audioPercent.textContent = 'Off';
      els.audioDescription.textContent = 'Microphone signal unavailable';
      console.warn('Audio activity unavailable', error);
    }
  }

  function averagePoint(points) {
    if (!points?.length) return null;
    return points.reduce((total, point) => ({ x: total.x + point.x / points.length, y: total.y + point.y / points.length }), { x: 0, y: 0 });
  }

  function isFaceFrontal(result) {
    try {
      const leftEye = averagePoint(result.landmarks.getLeftEye());
      const rightEye = averagePoint(result.landmarks.getRightEye());
      const nose = result.landmarks.getNose();
      const noseTip = nose[Math.floor(nose.length / 2)] || averagePoint(nose);
      if (!leftEye || !rightEye || !noseTip) return true;
      const eyeMidX = (leftEye.x + rightEye.x) / 2;
      const eyeDistance = Math.max(1, Math.abs(rightEye.x - leftEye.x));
      return Math.abs(noseTip.x - eyeMidX) / eyeDistance < 0.42;
    } catch (error) {
      return true;
    }
  }

  function trackDetections(results) {
    const now = performance.now();
    const previous = [...trackedFaces.values()].filter((track) => now - track.lastSeen < 1500);
    const used = new Set();
    const current = results.map((result) => {
      const box = result.detection.box;
      const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      let best = null;
      let bestDistance = Infinity;
      previous.forEach((track) => {
        if (used.has(track.id)) return;
        const distance = Math.hypot(center.x - track.center.x, center.y - track.center.y);
        const limit = Math.max(box.width, box.height, track.box.width) * 1.15;
        if (distance < limit && distance < bestDistance) {
          best = track;
          bestDistance = distance;
        }
      });
      const id = best?.id || nextTrackId++;
      if (best) used.add(id);
      const instantMovement = best ? bestDistance / Math.max(box.width, box.height, 1) : 0;
      const movement = best ? best.movement * 0.68 + instantMovement * 0.32 : 0;
      return {
        id,
        box,
        center,
        movement,
        frontal: isFaceFrontal(result),
        score: result.detection.score,
        lastSeen: now,
      };
    });
    trackedFaces = new Map([
      ...previous.filter((track) => !used.has(track.id)).map((track) => [track.id, track]),
      ...current.map((track) => [track.id, track]),
    ]);
    return current;
  }

  function mapVideoBox(box) {
    const stageWidth = els.cameraStage.clientWidth;
    const stageHeight = els.cameraStage.clientHeight;
    const videoWidth = els.cameraVideo.videoWidth || stageWidth;
    const videoHeight = els.cameraVideo.videoHeight || stageHeight;
    const scale = Math.max(stageWidth / videoWidth, stageHeight / videoHeight);
    const renderedWidth = videoWidth * scale;
    const renderedHeight = videoHeight * scale;
    const offsetX = (stageWidth - renderedWidth) / 2;
    const offsetY = (stageHeight - renderedHeight) / 2;
    const width = box.width * scale;
    const height = box.height * scale;
    return {
      x: stageWidth - (offsetX + box.x * scale + width),
      y: offsetY + box.y * scale,
      width,
      height,
    };
  }

  function drawCornerBox(context, box, color) {
    const corner = Math.max(8, Math.min(18, box.width * 0.2));
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(box.x, box.y + corner); context.lineTo(box.x, box.y); context.lineTo(box.x + corner, box.y);
    context.moveTo(box.x + box.width - corner, box.y); context.lineTo(box.x + box.width, box.y); context.lineTo(box.x + box.width, box.y + corner);
    context.moveTo(box.x + box.width, box.y + box.height - corner); context.lineTo(box.x + box.width, box.y + box.height); context.lineTo(box.x + box.width - corner, box.y + box.height);
    context.moveTo(box.x + corner, box.y + box.height); context.lineTo(box.x, box.y + box.height); context.lineTo(box.x, box.y + box.height - corner);
    context.stroke();
  }

  function drawLiveDetections(tracks) {
    const canvas = els.detectionCanvas;
    const width = els.cameraStage.clientWidth;
    const height = els.cameraStage.clientHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.font = '700 9px Inter, system-ui, sans-serif';

    tracks.forEach((track) => {
      const box = mapVideoBox(track.box);
      const color = track.frontal ? '#43e0b4' : '#f0ac4b';
      drawCornerBox(context, box, color);
      const confidence = Math.round(track.score * 100);
      const label = `Person ${String(track.id).padStart(2, '0')} · ${confidence}%`;
      const labelWidth = Math.min(box.width, context.measureText(label).width + 12);
      const labelY = Math.max(3, box.y - 20);
      context.fillStyle = color;
      context.fillRect(box.x, labelY, labelWidth, 18);
      context.fillStyle = '#09231d';
      context.fillText(label, box.x + 6, labelY + 12, Math.max(0, labelWidth - 9));
    });

    context.fillStyle = 'rgba(7, 15, 28, .78)';
    context.fillRect(12, 14, 112, 23);
    context.fillStyle = '#54dfb9';
    context.font = '700 8px Inter, system-ui, sans-serif';
    context.fillText('REAL · LOCAL AI', 22, 29);
  }

  function updateLiveSignals(tracks, inferenceMs, liveFps) {
    countHistory.push(tracks.length);
    countHistory = countHistory.slice(-5);
    const sortedCounts = [...countHistory].sort((a, b) => a - b);
    const stableCount = sortedCounts[Math.floor(sortedCounts.length / 2)] ?? tracks.length;
    els.cameraPeople.textContent = stableCount;
    $('#detectionLabel').textContent = stableCount === 1 ? 'face' : 'faces';
    els.visualDescription.textContent = stableCount
      ? `${stableCount} sustained face-presence ${stableCount === 1 ? 'signal' : 'signals'}`
      : 'No face currently visible';
    els.visualStatus.textContent = stableCount ? 'Detected' : 'Scanning';

    const averageMovement = tracks.length
      ? tracks.reduce((sum, track) => sum + track.movement, 0) / tracks.length
      : 0;
    const frontalCount = tracks.filter((track) => track.frontal).length;
    if (!tracks.length) {
      els.movementDescription.textContent = 'Waiting for a face-presence signal';
      els.movementStatus.textContent = '—';
    } else if (averageMovement > 0.11) {
      els.movementDescription.textContent = `${frontalCount}/${tracks.length} facing toward camera`;
      els.movementStatus.textContent = 'Active';
    } else {
      els.movementDescription.textContent = `${frontalCount}/${tracks.length} facing toward camera`;
      els.movementStatus.textContent = averageMovement < 0.025 ? 'Steady' : 'Normal';
    }

    if (analyser) {
      const audioLevel = readAudioLevel();
      els.audioPercent.textContent = `${audioLevel}%`;
      els.audioDescription.textContent = audioLevel < 8
        ? 'Quiet room signal'
        : audioLevel < 40 ? 'Conversation activity detected' : 'High audio activity';
    }
    const profile = detectorProfileConfig();
    const resolution = `${els.cameraVideo.videoWidth || 0}×${els.cameraVideo.videoHeight || 0}`;
    if (els.cameraDiagnostics) els.cameraDiagnostics.textContent = `${resolution} · ${Math.round(liveFps || 0)} FPS · ${profile.inputSize}px`;
    setCameraState('working', 'AI detection active', `${stableCount} ${stableCount === 1 ? 'face' : 'faces'} · ${Math.round(inferenceMs)}ms inference · ${Math.round(liveFps || 0)} FPS`);
  }

  async function runDetectionLoop(generation) {
    const { faceapi } = window;
    while (mediaStream && generation === detectorGeneration) {
      const started = performance.now();
      if (lastLoopTimestamp) {
        const interval = started - lastLoopTimestamp;
        const instantFps = 1000 / Math.max(interval, 1);
        smoothedFps = smoothedFps ? smoothedFps * 0.75 + instantFps * 0.25 : instantFps;
      }
      lastLoopTimestamp = started;
      try {
        if (document.hidden || els.cameraVideo.readyState < 2) {
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          continue;
        }
        // Apply the selected profile immediately; don't leave a stale options object active.
        updateDetectorSensitivity();
        let results = await faceapi
          .detectAllFaces(els.cameraVideo, detectorOptions)
          .withFaceLandmarks(true);

        // Recovery pass: after several empty frames, retry at maximum model input size
        // with a lower threshold. Rate-limited to avoid doubling every frame's cost.
        const now = performance.now();
        emptyDetectionFrames = results.length ? 0 : emptyDetectionFrames + 1;
        if (!results.length && emptyDetectionFrames >= 3 && now - lastRecoveryAt > 1200) {
          const recoveryConfig = { inputSize: 608, scoreThreshold: 0.20 };
          const recoveryKey = `${recoveryConfig.inputSize}:${recoveryConfig.scoreThreshold}`;
          if (!detectorOptionsCache.has(recoveryKey)) {
            detectorOptionsCache.set(recoveryKey, new faceapi.TinyFaceDetectorOptions(recoveryConfig));
          }
          lastRecoveryAt = now;
          const recoveryResults = await faceapi
            .detectAllFaces(els.cameraVideo, detectorOptionsCache.get(recoveryKey))
            .withFaceLandmarks(true);
          if (recoveryResults.length) {
            results = recoveryResults;
            emptyDetectionFrames = 0;
          }
        }
        if (!mediaStream || generation !== detectorGeneration) return;
        const tracks = trackDetections(results);
        const elapsed = performance.now() - started;
        drawLiveDetections(tracks);
        updateLiveSignals(tracks, elapsed, smoothedFps);
        consecutiveDetectionErrors = 0;
        const delay = Math.max(30, 120 - elapsed);
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      } catch (error) {
        consecutiveDetectionErrors += 1;
        console.warn('Detection frame failed', error);
        if (consecutiveDetectionErrors >= 3) {
          setCameraState('error', 'AI detection interrupted', 'Camera is live, but local detection failed. Stop and retry.');
          setDetectorStatus('Detection interrupted', 'Stop detection, then start it again.', 'error');
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      }
    }
  }

  function stopCamera() {
    detectorGeneration += 1;
    const stream = mediaStream;
    mediaStream = null;
    stream?.getTracks().forEach((track) => track.stop());
    if (audioContext) audioContext.close().catch(() => {});
    audioContext = null;
    analyser = null;
    trackedFaces = new Map();
    nextTrackId = 1;
    countHistory = [];
    consecutiveDetectionErrors = 0;
    lastLoopTimestamp = 0;
    smoothedFps = 0;
    if (els.cameraDiagnostics) els.cameraDiagnostics.textContent = 'WAITING';
    els.cameraVideo.pause();
    els.cameraVideo.srcObject = null;
    els.cameraStage.classList.remove('camera-on');
    els.cameraButton.innerHTML = `${icon('camera')}<span>Activate vision</span>`;
    els.cameraMode.textContent = 'STANDBY';
    els.recordingBadge.classList.remove('is-live');
    els.cameraPeople.textContent = '—';
    $('#detectionLabel').textContent = 'faces';
    els.visualDescription.textContent = 'Waiting for live camera';
    els.visualStatus.textContent = 'Ready';
    els.movementDescription.textContent = 'Calculated from sustained face tracks';
    els.movementStatus.textContent = 'Ready';
    els.audioPercent.textContent = '—';
    els.audioDescription.textContent = 'Microphone starts with camera';
    setCameraState('idle', 'Vision layer ready', 'Click activate · frames never leave this device');
    setDetectorStatus();
    const context = els.detectionCanvas.getContext('2d');
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, els.detectionCanvas.width, els.detectionCanvas.height);
  }

  function exportReport() {
    window.location.assign('/api/session/export.csv');
    showToast('Attendance report is being downloaded');
  }

  function openModal(prompt = '') {
    setModalOpen($('#copilotModal'), true);
    $('#copilotInput').value = prompt;
    setTimeout(() => $('#copilotInput').focus(), 100);
  }

  function closeModal() {
    setModalOpen($('#copilotModal'), false);
    $('#copilotAnswer').classList.remove('show');
  }

  function setModalOpen(modal, open) {
    modal.classList.toggle('open', open);
    document.body.style.overflow = $$('.command-modal.open').length ? 'hidden' : '';
  }

  function openPollModal() {
    renderPoll();
    setModalOpen(els.pollModal, true);
    if (!session?.poll?.active) setTimeout(() => $('#pollQuestion').focus(), 100);
    window.clearInterval(pollRefreshTimer);
    pollRefreshTimer = window.setInterval(async () => {
      if (!els.pollModal.classList.contains('open') || !session?.poll?.active) return;
      try {
        session = await api('/api/session');
        renderPoll();
      } catch (error) {
        console.warn('Poll refresh skipped', error);
      }
    }, 1500);
  }

  function closePollModal() {
    setModalOpen(els.pollModal, false);
    window.clearInterval(pollRefreshTimer);
    pollRefreshTimer = null;
  }

  function openMomentModal() {
    setModalOpen(els.momentModal, true);
    setTimeout(() => $('#momentNote').focus(), 100);
  }

  function closeMomentModal() {
    setModalOpen(els.momentModal, false);
  }

  async function launchPoll(event) {
    event.preventDefault();
    const question = $('#pollQuestion').value.trim();
    const template = $('#pollForm').dataset.template || 'confidence';
    const optionSets = {
      confidence: ['Lost', 'Getting there', 'Confident', 'Ready to explain'],
      pace: ['Too slow', 'Just right', 'A little fast', 'Lost me'],
      break: ['Keep going', 'One-minute reset', 'Need a break'],
    };
    if (question.length < 5) {
      showToast('Add a clear poll question first', 'error');
      return;
    }
    try {
      session = await api('/api/poll/start', {
        method: 'POST',
        body: JSON.stringify({ question, options: optionSets[template] }),
      });
      renderSession();
      renderPoll();
      showToast('Pulse poll is live — anonymous responses are arriving');
    } catch (error) {
      showToast('Could not start the poll', 'error');
    }
  }

  async function finishPoll() {
    try {
      session = await api('/api/poll/close', { method: 'POST', body: '{}' });
      renderSession();
      closePollModal();
      $('#events').scrollIntoView({ behavior: 'smooth', block: 'center' });
      showToast('Poll closed and added to the moment log');
    } catch (error) {
      showToast('There is no active poll to close', 'error');
    }
  }

  async function saveMoment(event) {
    event.preventDefault();
    const note = $('#momentNote').value.trim();
    if (note.length < 3) {
      showToast('Write a short note before saving', 'error');
      return;
    }
    try {
      session = await api('/api/session/checkpoint', {
        method: 'POST',
        body: JSON.stringify({ note }),
      });
      $('#momentNote').value = '';
      renderSession();
      closeMomentModal();
      $('#events').scrollIntoView({ behavior: 'smooth', block: 'center' });
      showToast('Teaching moment saved to this session');
    } catch (error) {
      showToast('Could not save this moment', 'error');
    }
  }

  async function toggleCameraFocus() {
    const deck = $('.vision-deck');
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (deck.requestFullscreen) await deck.requestFullscreen();
      else deck.classList.toggle('focus-mode');
    } catch (error) {
      deck.classList.toggle('focus-mode');
    }
  }

  function answerCopilot(question) {
    const q = question.toLowerCase();
    let answer;
    if (q.includes('who') || q.includes('support') || q.includes('attention')) {
      const names = session.students.filter((s) => s.status !== 'absent').sort((a, b) => a.engagement - b.engagement).slice(0, 3).map((s) => s.name);
      answer = `<strong>Three learners may benefit from a check-in:</strong> ${safe(names.join(', '))}. This is based on sustained low activity, not identity or emotion inference. Please use your classroom context before acting.`;
    } else if (q.includes('activity') || q.includes('next') || q.includes('suggest')) {
      answer = `<strong>Try a 2-minute think–pair–share.</strong> Engagement is ${session.summary.engagement}%, and participation is ${session.summary.participation}%. Ask one applied question, give 45 seconds to think, then invite pairs to compare answers.`;
    } else {
      answer = `<strong>The class is broadly on track.</strong> ${session.summary.present} of ${session.summary.total} learners are present, average engagement is ${session.summary.engagement}%, and ${session.summary.participation}% have participated. The main opportunity is a short pace change for learners showing sustained low activity.`;
    }
    const answerBox = $('#copilotAnswer');
    answerBox.innerHTML = answer;
    answerBox.classList.add('show');
  }

  function setupEvents() {
    els.sessionControl.addEventListener('click', toggleSession);
    els.cameraButton.addEventListener('click', toggleCamera);
    els.detectionSensitivity?.addEventListener('change', () => {
      updateDetectorSensitivity();
      countHistory = [];
      if (detectorReady) {
        const config = detectorProfileConfig();
        showToast(`${els.detectionSensitivity.selectedOptions[0].text}: ${config.inputSize}px model input`);
      }
    });
    els.cameraSource?.addEventListener('change', async () => {
      if (!mediaStream) return;
      stopCamera();
      await toggleCamera();
    });
    $('#exportTop').addEventListener('click', exportReport);
    $('#exportRoster').addEventListener('click', exportReport);
    $('#exportJson').addEventListener('click', () => {
      window.location.assign('/api/session/report.json');
      showToast('Privacy-safe JSON session report is downloading');
    });
    $('#focusCamera').addEventListener('click', toggleCameraFocus);
    $('#rosterSearch').addEventListener('input', (event) => {
      searchTerm = event.target.value.trim().toLowerCase();
      renderRoster();
    });
    $('#filterTabs').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-filter]');
      if (!button) return;
      rosterFilter = button.dataset.filter;
      renderRoster();
    });
    els.constellation.addEventListener('click', (event) => {
      const node = event.target.closest('[data-student-id]');
      if (!node) return;
      const student = session.students.find((item) => item.id === Number(node.dataset.studentId));
      if (!student) return;
      rosterFilter = 'all';
      searchTerm = student.name.toLowerCase();
      $('#rosterSearch').value = student.name;
      renderRoster();
      $('#attendance').scrollIntoView({ behavior: 'smooth', block: 'start' });
      showToast(`Opened ${student.name}'s session signals`);
    });
    $('#viewLearners').addEventListener('click', () => {
      rosterFilter = 'low';
      renderRoster();
      $('#attendance').scrollIntoView({ behavior: 'smooth', block: 'start' });
      showToast('Showing learners with sustained low activity');
    });
    $$('[data-filter-button="low"]').forEach((button) => button.addEventListener('click', () => $('#viewLearners').click()));

    els.suggestions.addEventListener('click', (event) => {
      const button = event.target.closest('[data-suggestion]');
      if (!button) return;
      if (button.dataset.suggestion.toLowerCase().includes('poll')) openPollModal();
      else if (button.dataset.suggestion.toLowerCase().includes('learner')) $('#viewLearners').click();
      else openModal('How is participation distributed?');
    });

    $('#askCopilot').addEventListener('click', () => openModal());
    $('#closeModal').addEventListener('click', closeModal);
    $('#copilotModal').addEventListener('click', (event) => { if (event.target.id === 'copilotModal') closeModal(); });
    $('#copilotForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const question = $('#copilotInput').value.trim();
      if (question) answerCopilot(question);
    });
    $$('.quick-prompts button').forEach((button) => button.addEventListener('click', () => {
      $('#copilotInput').value = button.textContent;
      answerCopilot(button.textContent);
    }));

    $('#launchPoll').addEventListener('click', openPollModal);
    $$('[data-open-poll]').forEach((button) => button.addEventListener('click', openPollModal));
    $('#closePoll').addEventListener('click', closePollModal);
    els.pollModal.addEventListener('click', (event) => { if (event.target.id === 'pollModal') closePollModal(); });
    els.pollForm.addEventListener('submit', launchPoll);
    $('#closeLivePoll').addEventListener('click', finishPoll);
    $$('#pollForm [data-poll-template]').forEach((button) => button.addEventListener('click', () => {
      const templates = {
        confidence: 'How confident are you with today’s concept?',
        pace: 'How is the pace of this session right now?',
        break: 'What does your attention need right now?',
      };
      els.pollForm.dataset.template = button.dataset.pollTemplate;
      $('#pollQuestion').value = templates[button.dataset.pollTemplate];
      $$('#pollForm [data-poll-template]').forEach((item) => item.classList.toggle('active', item === button));
    }));

    $('#markMoment').addEventListener('click', openMomentModal);
    $$('[data-mark-moment]').forEach((button) => button.addEventListener('click', openMomentModal));
    $('#closeMoment').addEventListener('click', closeMomentModal);
    els.momentModal.addEventListener('click', (event) => { if (event.target.id === 'momentModal') closeMomentModal(); });
    $('#momentForm').addEventListener('submit', saveMoment);

    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openModal();
      }
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (!typing && !event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        openMomentModal();
      }
      if (event.key === 'Escape') {
        closeModal();
        closePollModal();
        closeMomentModal();
      }
    });

    const sidebar = $('#sidebar');
    const scrim = $('#sidebarScrim');
    const closeSidebar = () => { sidebar.classList.remove('open'); scrim.classList.remove('open'); };
    $('#openSidebar').addEventListener('click', () => { sidebar.classList.add('open'); scrim.classList.add('open'); });
    $('#closeSidebar').addEventListener('click', closeSidebar);
    scrim.addEventListener('click', closeSidebar);

    $$('.nav-link').forEach((link) => link.addEventListener('click', (event) => {
      const href = link.getAttribute('href') || '';
      closeSidebar();
      // Real page routes should navigate normally. Only handle in-page anchors here.
      if (!href.startsWith('#')) return;
      $$('.nav-link').forEach((item) => item.classList.remove('active'));
      link.classList.add('active');
      const target = document.querySelector(href);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else event.preventDefault();
    }));

    window.addEventListener('resize', () => {
      if (!mediaStream) return;
      const now = performance.now();
      const visibleTracks = [...trackedFaces.values()].filter((track) => now - track.lastSeen < 900);
      drawLiveDetections(visibleTracks);
    }, { passive: true });
    window.addEventListener('beforeunload', stopCamera);
  }

  setupEvents();
  loadSession();
  setInterval(() => {
    if (session?.running) {
      session.elapsed += 1;
      els.elapsed.textContent = formatElapsed(session.elapsed);
    }
  }, 1000);
  setInterval(tick, 5000);
})();
