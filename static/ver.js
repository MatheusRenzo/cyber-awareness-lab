(function () {
  "use strict";

  const out = document.getElementById("ver-out");
  const status = document.getElementById("ver-status");
  const btn = document.getElementById("ver-refresh");
  const beaconCards = document.getElementById("beacon-cards");
  const beaconCount = document.getElementById("beacon-count");
  const deviceGroupsCount = document.getElementById("device-groups-count");
  const auditSummary = document.getElementById("audit-summary");
  const intervalSelect = document.getElementById("ver-interval");
  let pollTimer = null;
  let intervalMs = 3000;
  /** Só na primeira vez com dados: abrir o 1.º grupo se ainda não existir UI de grupos. */
  let verBeaconHadDeviceGroups = false;
  /** Nomes amigáveis vindos do servidor (cadastro /b?nome= ou Guardar no /ver). */
  let deviceLabelsMap = {};
  /** Atualização automática saltou-se por estar a ler JSON / a editar o nome — repetir ao sair do foco. */
  let beaconRefreshPending = false;
  /** Texto do campo "Nome no painel" ainda não guardado (não sobrescrever no re-render). */
  const labelDraftByKey = Object.create(null);

  /** URLs das APIs (definidas no HTML com url_for) — evita 404 quando o app corre sob subcaminho. */
  function labApiUrl(name) {
    const api = typeof window !== "undefined" && window.__LAB_API__;
    const fallback = {
      beaconTail: "/api/beacon-tail",
      deviceLabel: "/api/device-label",
      auditTail: "/api/audit-tail",
    };
    if (api && typeof api[name] === "string" && api[name]) return api[name];
    return fallback[name] || "";
  }

  /** Não substituir o DOM das coletas: foco em campo/botão OU painel técnico (JSON, UA, diagnóstico) aberto. */
  function isBeaconRefreshPaused() {
    if (!beaconCards) return false;
    if (beaconCards.querySelector(".ver-device-captures details.ver-details[open]")) return true;
    const ae = document.activeElement;
    if (!ae || !beaconCards.contains(ae)) return false;
    const tag = ae.tagName;
    return tag === "INPUT" || tag === "BUTTON" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function pretty(obj) {
    return JSON.stringify(obj, null, 2);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Nome definido no painel / gravado em `device_labels` (chave = device_key). */
  function labelFromMap(lab, dk) {
    if (!lab || dk == null) return "";
    const k = String(dk).trim();
    if (!k) return "";
    if (Object.prototype.hasOwnProperty.call(lab, k)) {
      const v = lab[k];
      return v != null && String(v).trim() !== "" ? String(v).trim() : "";
    }
    return "";
  }

  function formatWhen(isoOrTs) {
    try {
      const d = typeof isoOrTs === "string" ? new Date(isoOrTs) : new Date((isoOrTs || 0) * 1000);
      if (Number.isNaN(d.getTime())) return "—";
      return d.toLocaleString("pt-BR", {
        dateStyle: "short",
        timeStyle: "medium",
      });
    } catch {
      return "—";
    }
  }

  function geoHasCoords(g) {
    return g && typeof g.latitude === "number" && typeof g.longitude === "number";
  }

  /** Texto curto para o chip de GPS (timeout, permissão, etc.). */
  function geoStatusChip(geo) {
    if (geoHasCoords(geo)) return { label: "GPS OK", variant: "ok" };
    if (!geo) return { label: "Sem GPS", variant: "warn" };
    const hint = geo && geo.hint != null ? String(geo.hint).toUpperCase() : "";
    if (hint === "TIMEOUT") return { label: "GPS: tempo esgotado", variant: "warn" };
    if (hint === "PERMISSION_DENIED" || hint === "DENIED") return { label: "GPS: permissão negada", variant: "warn" };
    if (geo.error) return { label: "GPS: " + String(geo.error).slice(0, 22), variant: "warn" };
    return { label: "Sem GPS", variant: "warn" };
  }

  function simpleHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function eventTimeMs(ev) {
    if (ev && typeof ev.ts === "number") return ev.ts * 1000;
    if (ev && ev.collected_at) {
      const t = new Date(ev.collected_at).getTime();
      return Number.isNaN(t) ? 0 : t;
    }
    return 0;
  }

  /** Mesmo “dispositivo” ≈ mesma impressão leve (canvas + ecrã + idioma + UA). IP não entra (muda em móvel). */
  function deviceKeyFromEvent(ev) {
    const fp = ev.fingerprint || {};
    const ua = String(ev.user_agent || fp.user_agent || "").trim();
    const raw = [
      fp.canvas && fp.canvas.hash32,
      fp.screen,
      fp.language,
      Array.isArray(fp.languages) ? fp.languages.join(",") : "",
      fp.timezone,
      ua,
    ]
      .filter(Boolean)
      .join("||");
    if (!raw) return "k:" + simpleHash(String(ev.ip || "") + "|anon");
    return "k:" + simpleHash(raw);
  }

  function deviceLabelFromEvent(ev) {
    const fp = ev.fingerprint || {};
    const ua = String(ev.user_agent || fp.user_agent || "").trim();
    let os = "";
    if (/Windows NT/i.test(ua)) os = "Windows";
    else if (/Mac OS X|Macintosh/i.test(ua)) os = "macOS";
    else if (/Android/i.test(ua)) os = "Android";
    else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
    else if (/Linux/i.test(ua)) os = "Linux";
    const scr = fp.screen || "—";
    const lang = fp.language || "";
    const ch = fp.canvas && fp.canvas.hash32 ? "id " + fp.canvas.hash32 : "";
    const parts = [os, scr, lang, ch].filter(Boolean);
    if (parts.length) return parts.join(" · ");
    return ua.slice(0, 80) || "Dispositivo";
  }

  function deviceKeyFor(ev) {
    if (ev && ev.device_key != null && String(ev.device_key).trim() !== "") return String(ev.device_key).trim();
    return deviceKeyFromEvent(ev);
  }

  function groupBeaconsByDevice(events) {
    const map = new Map();
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const k = deviceKeyFor(ev);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(ev);
    }
    const groups = [];
    map.forEach((captures, key) => {
      captures.sort((a, b) => eventTimeMs(b) - eventTimeMs(a));
      const rep = captures[0];
      groups.push({
        key: key,
        label: deviceLabelFromEvent(rep || {}),
        captures: captures,
        lastMs: eventTimeMs(rep),
      });
    });
    groups.sort((a, b) => b.lastMs - a.lastMs);
    return groups;
  }

  function cameraUiSummary(cam) {
    const s = String(cam || "—");
    if (/NotAllowedError/i.test(s)) return "Câmera: permissão negada ou bloqueada (NotAllowedError).";
    if (/NotFoundError/i.test(s)) return "Câmera: nenhum dispositivo encontrado.";
    return s.slice(0, 120) + (s.length > 120 ? "…" : "");
  }

  function chip(label, variant) {
    const v = variant || "neutral";
    return '<span class="ver-chip ver-chip--' + v + '">' + escapeHtml(label) + "</span>";
  }

  function captureStableSlug(ev) {
    const t = ev && ev.collected_at ? String(ev.collected_at) : "";
    const ts = ev && ev.ts != null ? String(ev.ts) : "";
    const ip = ev && ev.ip != null ? String(ev.ip) : "";
    return simpleHash(t + "|" + ts + "|" + ip);
  }

  /** Guarda quais <details> estavam abertos antes do refresh automático. */
  function collectOpenState(container) {
    const deviceKeys = new Set();
    const detailIds = new Set();
    if (!container) return { deviceKeys: deviceKeys, detailIds: detailIds };
    container.querySelectorAll(".ver-device-group[data-device-key]").forEach((el) => {
      if (el.open) {
        const k = el.getAttribute("data-device-key");
        if (k) deviceKeys.add(k);
      }
    });
    container.querySelectorAll("details[data-ver-stable]").forEach((el) => {
      if (el.open) {
        const id = el.getAttribute("data-ver-stable");
        if (id) detailIds.add(id);
      }
    });
    return { deviceKeys: deviceKeys, detailIds: detailIds };
  }

  function renderBeaconCard(ev, opts) {
    opts = opts || {};
    const nested = !!opts.nested;
    const ph = ev.photo_jpeg_base64;
    const hasPhoto = !!ph;
    const geo = ev.geolocation;
    const hasGeo = geoHasCoords(geo);
    const geoChip = geoStatusChip(geo);
    const ctx = ev.beacon_context && typeof ev.beacon_context === "object" ? ev.beacon_context : {};
    const secure = ctx.isSecureContext === true;
    const when = ev.collected_at || new Date((ev.ts || 0) * 1000).toISOString();
    const cam = String(ev.camera_status || "—");
    const camOk = cam === "ok";

    const media = hasPhoto
      ? '<div class="ver-beacon-card__media ver-beacon-card__media--photo">' +
        '<img src="data:image/jpeg;base64,' +
        escapeHtml(ph) +
        '" alt="Captura" loading="lazy" />' +
        "</div>"
      : '<div class="ver-beacon-card__media ver-beacon-card__media--empty">' +
        '<span class="ver-beacon-card__empty-icon" aria-hidden="true">◇</span>' +
        "<p>Sem foto</p>" +
        "<small>" +
        escapeHtml(cameraUiSummary(cam)) +
        "</small></div>";

    let chips =
      chip(hasPhoto ? "Foto OK" : "Sem foto", hasPhoto ? "ok" : "warn") +
      chip(geoChip.label, geoChip.variant) +
      chip(secure ? "HTTPS" : "Não seguro", secure ? "ok" : "danger");

    let geoBlock = "";
    if (hasGeo) {
      const lat = geo.latitude;
      const lon = geo.longitude;
      const acc = geo.accuracy != null ? Math.round(geo.accuracy) + " m" : "—";
      const mapUrl =
        "https://www.openstreetmap.org/?mlat=" +
        encodeURIComponent(lat) +
        "&mlon=" +
        encodeURIComponent(lon) +
        "#map=16/" +
        encodeURIComponent(lat) +
        "/" +
        encodeURIComponent(lon);
      const hint = geo.reverse_geocode_hint ? escapeHtml(String(geo.reverse_geocode_hint).slice(0, 180)) : "";
      geoBlock =
        '<div class="ver-geo">' +
        '<div class="ver-geo__coords">' +
        '<span class="ver-mono">' +
        escapeHtml(lat.toFixed(5) + ", " + lon.toFixed(5)) +
        "</span>" +
        '<span class="ver-geo__acc">± ' +
        escapeHtml(acc) +
        "</span></div>" +
        (hint ? '<p class="ver-geo__hint">' + hint + (String(geo.reverse_geocode_hint).length > 180 ? "…" : "") + "</p>" : "") +
        '<a class="ver-link" href="' +
        mapUrl +
        '" target="_blank" rel="noopener">Ver no OpenStreetMap ↗</a>' +
        "</div>";
    } else if (geo) {
      geoBlock =
        '<div class="ver-geo ver-geo--error">' +
        "<strong>Geolocalização</strong>" +
        '<pre class="ver-mini-json">' +
        escapeHtml(pretty(geo)) +
        "</pre></div>";
    } else {
      geoBlock = '<p class="ver-muted-line">Sem dados de GPS.</p>';
    }

    const ctxLine =
      ctx.protocol || ctx.host
        ? '<p class="ver-muted-line ver-mono">' +
          escapeHtml((ctx.protocol || "") + "//" + (ctx.host || "")) +
          "</p>"
        : "";

    const ua = (ev.user_agent || "").trim();
    const uaShort = ua.length > 160 ? ua.slice(0, 160) + "…" : ua;

    const dOpen = opts.openDetails && typeof opts.openDetails.has === "function" ? opts.openDetails : new Set();
    const gk = opts.groupKey ? String(opts.groupKey) : "";
    const slug = gk ? gk + "/" + captureStableSlug(ev) : captureStableSlug(ev);
    function detailAttr(suffix) {
      const full = slug + ":" + suffix;
      return ' data-ver-stable="' + escapeHtml(full) + '"' + (dOpen.has(full) ? " open" : "");
    }

    const cd = ev.camera_debug && typeof ev.camera_debug === "object" && Object.keys(ev.camera_debug).length > 0;
    const dbgBlock = cd
      ? '<details class="ver-details ver-details--mono ver-details--dbg"' +
        detailAttr("cam") +
        '><summary>Diagnóstico da câmera</summary><pre class="ver-mini-json ver-mini-json--dbg">' +
        escapeHtml(pretty(ev.camera_debug)) +
        "</pre></details>"
      : "";

    const technical = escapeHtml(pretty(ev));

    return (
      '<article class="ver-beacon-card' + (nested ? " ver-beacon-card--nested" : "") + '">' +
      media +
      '<div class="ver-beacon-card__body">' +
      '<div class="ver-beacon-card__head">' +
      '<time class="ver-beacon-card__time" datetime="' +
      escapeHtml(when) +
      '">' +
      escapeHtml(formatWhen(when)) +
      "</time>" +
      '<span class="ver-ip-pill" title="IP visto pelo servidor">' +
      escapeHtml(ev.ip || "—") +
      "</span></div>" +
      '<div class="ver-beacon-card__chips">' +
      chips +
      "</div>" +
      (camOk ? "" : '<p class="ver-cam-line"><strong>Câmera:</strong> <span class="ver-mono">' + escapeHtml(cameraUiSummary(cam)) + "</span></p>") +
      ctxLine +
      geoBlock +
      (ua
        ? '<details class="ver-details"' +
          detailAttr("ua") +
          "><summary>User-Agent</summary><p class=\"ver-ua\">" +
          escapeHtml(uaShort) +
          "</p></details>"
        : "") +
      dbgBlock +
      '<details class="ver-details ver-details--mono"' +
      detailAttr("json") +
      "><summary>JSON completo</summary><pre class=\"ver-json-block\">" +
      technical +
      "</pre></details>" +
      "</div></article>"
    );
  }

  function renderDeviceGroup(group, index, openState, labels) {
    const lab = labels && typeof labels === "object" ? labels : {};
    const n = group.captures.length;
    const lastEv = group.captures[0];
    const lastWhen = formatWhen(lastEv ? lastEv.collected_at || lastEv.ts : 0);
    const dk = String(group.key || "").trim();
    const fromTable = labelFromMap(lab, dk);
    const fromCapture =
      lastEv && lastEv.device_label && String(lastEv.device_label).trim()
        ? String(lastEv.device_label).trim()
        : "";
    const printServer = fromTable || fromCapture;
    const print =
      Object.prototype.hasOwnProperty.call(labelDraftByKey, dk) ? labelDraftByKey[dk] : printServer;
    const nameBlock = print
      ? '<p class="ver-device-print-name">' + escapeHtml(print) + "</p>"
      : "";
    const deviceOpen =
      openState.deviceKeys.has(dk) ||
      (!verBeaconHadDeviceGroups && index === 0 && openState.deviceKeys.size === 0);
    const openAttr = deviceOpen ? " open" : "";
    const techLabel = escapeHtml(group.label);
    const titleHtml = print
      ? '<span class="ver-device-summary__title ver-device-summary__title--secondary">' + techLabel + "</span>"
      : '<span class="ver-device-summary__title">' + techLabel + "</span>";
    const keyShort = escapeHtml(String(dk).slice(0, 14));
    const cards = group.captures
      .map((ev) =>
        renderBeaconCard(ev, {
          nested: true,
          groupKey: dk,
          openDetails: openState.detailIds,
        })
      )
      .join("");
    return (
      '<details class="ver-device-group" data-device-key="' +
      escapeHtml(dk) +
      '"' +
      openAttr +
      ">" +
      '<summary class="ver-device-summary">' +
      nameBlock +
      '<span class="ver-device-summary__main">' +
      titleHtml +
      '<span class="ver-device-summary__badges">' +
      chip(n + " captura" + (n !== 1 ? "s" : ""), "accent") +
      chip("última " + lastWhen, "neutral") +
      "</span></span>" +
      '<span class="ver-device-summary__id ver-mono" title="Chave interna de agrupamento">' +
      keyShort +
      "…</span></summary>" +
      '<div class="ver-device-captures">' +
      cards +
      "</div>" +
      '<div class="ver-device-rename" data-device-key="' +
      escapeHtml(dk) +
      '">' +
      '<label class="ver-rename-label" for="ver-rename-' +
      index +
      '">Nome no painel</label>' +
      '<div class="ver-rename-row">' +
      '<input id="ver-rename-' +
      index +
      '" class="ver-input ver-device-rename-input" type="text" maxlength="120" placeholder="ex.: Maria – iPhone turma B" value="' +
      escapeHtml(print) +
      '" />' +
      '<button type="button" class="btn ghost ver-save-label">Guardar</button>' +
      "</div>" +
      '<p class="ver-rename-hint muted">Quem abre o link pode enviar o nome na URL: <code class="ver-code">/b?nome=Seu+Nome</code>.</p>' +
      "</div>" +
      "</details>"
    );
  }

  function renderBeacons(events) {
    if (!beaconCards) return;
    const n = Array.isArray(events) ? events.length : 0;
    if (beaconCount) beaconCount.textContent = String(n);
    if (!Array.isArray(events) || events.length === 0) {
      if (deviceGroupsCount) deviceGroupsCount.textContent = "0";
      verBeaconHadDeviceGroups = false;
      beaconCards.innerHTML =
        '<div class="ver-empty-state">' +
        '<div class="ver-empty-state__ring" aria-hidden="true"></div>' +
        "<h3>Nenhuma coleta ainda</h3>" +
        "<p>Envie o link <code class=\"ver-code\">/b</code> por <strong>HTTPS</strong> (túnel Cloudflare).</p>" +
        "</div>";
      return;
    }
    const openState = collectOpenState(beaconCards);
    const groups = groupBeaconsByDevice(events);
    if (deviceGroupsCount) deviceGroupsCount.textContent = String(groups.length);
    beaconCards.innerHTML =
      '<div class="ver-device-groups">' +
      groups.map((g, i) => renderDeviceGroup(g, i, openState, deviceLabelsMap)).join("") +
      "</div>";
    if (groups.length > 0) verBeaconHadDeviceGroups = true;
  }

  function auditVariant(type) {
    if (type === "lab_report") return "accent";
    if (type === "server_meta_view") return "neutral";
    return "neutral";
  }

  function renderAuditSummary(events) {
    if (!auditSummary) return;
    if (!Array.isArray(events) || events.length === 0) {
      auditSummary.innerHTML = '<p class="ver-muted-line">Sem eventos na fila.</p>';
      return;
    }
    const recent = [...events].reverse().slice(0, 12);
    auditSummary.innerHTML =
      '<ul class="ver-audit-list">' +
      recent
        .map((e) => {
          const t = e.type || "evento";
          const when = formatWhen(e.ts);
          const v = auditVariant(t);
          let sub = "";
          if (t === "server_meta_view") {
            sub = escapeHtml((e.ua_short || "").slice(0, 80));
          } else if (t === "lab_report") {
            sub = (e.bundle_keys || []).join(", ");
            sub = escapeHtml(sub.slice(0, 100));
          } else {
            sub = escapeHtml(pretty(e).slice(0, 120) + "…");
          }
          return (
            '<li class="ver-audit-item">' +
            '<div class="ver-audit-item__row">' +
            '<span class="ver-audit-item__time">' +
            escapeHtml(when) +
            "</span>" +
            '<span class="ver-chip ver-chip--' +
            v +
            '">' +
            escapeHtml(t) +
            "</span>" +
            '<span class="ver-audit-item__ip">' +
            escapeHtml(e.ip || "—") +
            "</span></div>" +
            '<span class="ver-audit-item__sub">' +
            sub +
            "</span></li>"
          );
        })
        .join("") +
      "</ul>";
  }

  async function loadBeacons(opts) {
    if (!beaconCards) return;
    const force = !!(opts && opts.force);
    if (!force && isBeaconRefreshPaused()) {
      beaconRefreshPending = true;
      return;
    }
    beaconRefreshPending = false;
    try {
      const r = await fetch(labApiUrl("beaconTail"), {
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        cache: "no-store",
      });
      const j = await r.json();
      if (j.labels && typeof j.labels === "object") deviceLabelsMap = j.labels;
      renderBeacons(j.events);
    } catch (e) {
      beaconCards.innerHTML =
        '<div class="ver-empty-state ver-empty-state--error"><h3>Erro ao carregar coletas</h3><p>' + escapeHtml(String(e)) + "</p></div>";
    }
  }

  function initBeaconLabelSave() {
    if (!beaconCards || beaconCards.dataset.verLabelBind) return;
    beaconCards.dataset.verLabelBind = "1";
    beaconCards.addEventListener("input", (e) => {
      const inp = e.target && e.target.closest && e.target.closest(".ver-device-rename-input");
      if (!inp || !beaconCards.contains(inp)) return;
      const wrap = inp.closest(".ver-device-rename");
      const key = wrap && wrap.getAttribute("data-device-key");
      if (!key) return;
      labelDraftByKey[key] = inp.value;
    });
    beaconCards.addEventListener("click", async (e) => {
      const btn = e.target.closest(".ver-save-label");
      if (!btn) return;
      e.preventDefault();
      const wrap = btn.closest(".ver-device-rename");
      if (!wrap) return;
      const key = wrap.getAttribute("data-device-key");
      const inp = wrap.querySelector(".ver-device-rename-input");
      if (!key || !inp) return;
      btn.disabled = true;
      try {
        const r = await fetch(labApiUrl("deviceLabel"), {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "Cache-Control": "no-cache" },
          cache: "no-store",
          body: JSON.stringify({ device_key: key, label: inp.value.trim() }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) {
          window.alert("Não foi possível guardar o nome: " + (j.error || r.status + " " + r.statusText));
          return;
        }
        if (j.labels && typeof j.labels === "object") deviceLabelsMap = j.labels;
        delete labelDraftByKey[key];
        await loadBeacons({ force: true });
      } catch (err) {
        window.alert("Erro de rede ao guardar o nome: " + String(err));
      } finally {
        btn.disabled = false;
      }
    });
  }

  /** Quando o foco sai da zona de coletas / fecha o último detalhe técnico, aplicar refresh pendente. */
  function initBeaconRefreshResume() {
    if (!beaconCards || beaconCards.dataset.verResumeBind) return;
    beaconCards.dataset.verResumeBind = "1";
    beaconCards.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!beaconRefreshPending) return;
        if (isBeaconRefreshPaused()) return;
        beaconRefreshPending = false;
        loadBeacons();
      }, 0);
    });
    beaconCards.addEventListener("toggle", (e) => {
      const t = e.target;
      if (!t || t.tagName !== "DETAILS" || !t.classList.contains("ver-details")) return;
      if (!beaconRefreshPending) return;
      window.setTimeout(() => {
        if (isBeaconRefreshPaused()) return;
        beaconRefreshPending = false;
        loadBeacons();
      }, 0);
    }, true);
  }

  async function load(opts) {
    const forceBeacon = !!(opts && opts.forceBeacon);
    status.textContent = "carregando…";
    try {
      const r = await fetch(labApiUrl("auditTail"), {
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
        cache: "no-store",
      });
      const j = await r.json();
      out.textContent = pretty(j);
      const n = Array.isArray(j.events) ? j.events.length : 0;
      status.textContent = n + " evento(s) · " + new Date().toLocaleTimeString("pt-BR");
      renderAuditSummary(j.events);
    } catch (e) {
      out.textContent = "Erro: " + e;
      status.textContent = "erro";
      if (auditSummary) auditSummary.innerHTML = "";
    }
    await loadBeacons(forceBeacon ? { force: true } : undefined);
  }

  function setPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (intervalMs <= 0) return;
    pollTimer = setInterval(load, intervalMs);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } else {
      setPoll();
    }
  });

  if (intervalSelect) {
    intervalSelect.addEventListener("change", () => {
      intervalMs = parseInt(intervalSelect.value, 10);
      if (Number.isNaN(intervalMs)) intervalMs = 3000;
      setPoll();
      load();
    });
  }

  btn.addEventListener("click", () => load({ forceBeacon: true }));
  initBeaconLabelSave();
  initBeaconRefreshResume();
  load();
  setPoll();
})();
