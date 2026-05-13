"""
Persistência: SQLite (local) ou PostgreSQL (DATABASE_URL / POSTGRES_*).
Coletas /b (foto, GPS, fingerprint, contexto), nomes de dispositivos e auditoria.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote_plus

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

_lock = threading.Lock()
_backend: Literal["sqlite", "postgres"] | None = None
_sqlite_path: Path | None = None
_pg_dsn: str | None = None


def _beacon_cap() -> int:
    """Número máximo de coletas beacon; 0 ou negativo = sem limite (apenas PostgreSQL recomendado)."""
    raw = os.environ.get("LAB_BEACON_MAX", "").strip()
    if raw:
        try:
            return int(raw)
        except ValueError:
            pass
    return 200 if backend() == "sqlite" else 0


def _audit_cap() -> int:
    raw = os.environ.get("LAB_AUDIT_MAX", "5000").strip()
    try:
        return max(0, int(raw))
    except ValueError:
        return 5000


def _database_url() -> str | None:
    url = (os.environ.get("DATABASE_URL") or "").strip()
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://") :]
    if url:
        return url
    host = (os.environ.get("POSTGRES_HOST") or os.environ.get("PGHOST") or "").strip()
    if not host:
        return None
    user = (os.environ.get("POSTGRES_USER") or os.environ.get("PGUSER") or "postgres").strip()
    password = (os.environ.get("POSTGRES_PASSWORD") or os.environ.get("PGPASSWORD") or "").strip()
    port = (os.environ.get("POSTGRES_PORT") or os.environ.get("PGPORT") or "5432").strip()
    db = (os.environ.get("POSTGRES_DB") or os.environ.get("PGDATABASE") or "postgres").strip()
    return (
        f"postgresql://{quote_plus(user)}:{quote_plus(password)}"
        f"@{host}:{port}/{quote_plus(db)}"
    )


def backend() -> Literal["sqlite", "postgres"]:
    global _backend, _sqlite_path, _pg_dsn
    if _backend is not None:
        return _backend
    dsn = _database_url()
    if dsn:
        _backend = "postgres"
        _pg_dsn = dsn
        return _backend
    _backend = "sqlite"
    _sqlite_path = Path(__file__).resolve().parent / "instance" / "lab.sqlite"
    return _backend


def _sqlite_connect():
    assert _sqlite_path is not None
    _sqlite_path.parent.mkdir(parents=True, exist_ok=True)
    import sqlite3

    conn = sqlite3.connect(str(_sqlite_path), check_same_thread=False, isolation_level=None, timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except Exception:
        pass
    return conn


def _pg_connect():
    import psycopg

    conn = psycopg.connect(_pg_dsn, autocommit=False)
    return conn


def init_db() -> None:
    backend()
    with _lock:
        if backend() == "sqlite":
            _init_sqlite()
        else:
            _init_postgres()


def _init_sqlite() -> None:
    conn = _sqlite_connect()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS beacon_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL NOT NULL,
                device_key TEXT NOT NULL,
                ip TEXT,
                user_agent TEXT,
                collected_at TEXT,
                beacon_context_json TEXT NOT NULL,
                geolocation_json TEXT,
                camera_status TEXT,
                camera_debug_json TEXT,
                fingerprint_json TEXT NOT NULL,
                photo_jpeg_base64 TEXT,
                raw_bundle_json TEXT,
                device_label TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_beacon_id ON beacon_events(id DESC);
            CREATE TABLE IF NOT EXISTS device_labels (
                device_key TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS audit_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL NOT NULL,
                event_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_audit_id ON audit_events(id DESC);
            """
        )
        _sqlite_add_column_if_missing(conn, "beacon_events", "raw_bundle_json", "TEXT")
        _sqlite_add_column_if_missing(conn, "beacon_events", "device_label", "TEXT")
        conn.commit()
    finally:
        conn.close()


def _sqlite_add_column_if_missing(conn, table: str, col: str, decl: str) -> None:
    cur = conn.execute(f"PRAGMA table_info({table})")
    cols = {str(r[1]) for r in cur.fetchall()}
    if col not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")


def _init_postgres() -> None:
    import psycopg

    stmts = [
        """
        CREATE TABLE IF NOT EXISTS beacon_events (
            id BIGSERIAL PRIMARY KEY,
            ts DOUBLE PRECISION NOT NULL,
            device_key TEXT NOT NULL,
            ip TEXT,
            user_agent TEXT,
            collected_at TEXT,
            beacon_context_json TEXT NOT NULL,
            geolocation_json TEXT,
            camera_status TEXT,
            camera_debug_json TEXT,
            fingerprint_json TEXT NOT NULL,
            photo_jpeg_base64 TEXT,
            raw_bundle_json TEXT,
            device_label TEXT
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_beacon_id ON beacon_events (id DESC)",
        """
        CREATE TABLE IF NOT EXISTS device_labels (
            device_key TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            updated_at DOUBLE PRECISION NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS audit_events (
            id BIGSERIAL PRIMARY KEY,
            ts DOUBLE PRECISION NOT NULL,
            event_json TEXT NOT NULL
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_audit_id ON audit_events (id DESC)",
    ]
    conn = psycopg.connect(_pg_dsn, autocommit=True)
    try:
        with conn.cursor() as cur:
            for s in stmts:
                cur.execute(s.strip())
    finally:
        conn.close()
    _pg_add_column_if_missing("beacon_events", "raw_bundle_json", "TEXT")
    _pg_add_column_if_missing("beacon_events", "device_label", "TEXT")


def _pg_add_column_if_missing(table: str, col: str, decl: str) -> None:
    import psycopg

    conn = psycopg.connect(_pg_dsn, autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT 1 FROM information_schema.columns
                WHERE table_name = %s AND column_name = %s
                """,
                (table, col),
            )
            if cur.fetchone() is None:
                cur.execute(f'ALTER TABLE "{table}" ADD COLUMN "{col}" {decl}')
    finally:
        conn.close()


def _row_get(r: Any, key: str) -> Any:
    if hasattr(r, "get"):
        return r.get(key)
    try:
        return r[key]
    except (KeyError, IndexError, TypeError):
        return None


def _beacon_row_to_dict(r: Any) -> dict[str, Any]:
    g = lambda k: _row_get(r, k)
    rb = g("raw_bundle_json")
    dk_raw = g("device_key")
    dk_str = "" if dk_raw is None else str(dk_raw).strip()
    return {
        "ts": float(g("ts")),
        "device_key": dk_str,
        "ip": g("ip"),
        "user_agent": g("user_agent"),
        "collected_at": g("collected_at"),
        "beacon_context": json.loads(g("beacon_context_json") or "{}"),
        "geolocation": json.loads(g("geolocation_json")) if g("geolocation_json") else None,
        "camera_status": g("camera_status"),
        "camera_debug": json.loads(g("camera_debug_json") or "{}"),
        "fingerprint": json.loads(g("fingerprint_json") or "{}"),
        "photo_jpeg_base64": g("photo_jpeg_base64"),
        "device_label": g("device_label"),
        "raw_bundle": json.loads(rb) if rb else None,
    }


def _prune_beacons_sqlite(conn, cap: int) -> None:
    if cap <= 0:
        return
    cur = conn.execute("SELECT COUNT(*) AS c FROM beacon_events")
    n = int(cur.fetchone()["c"])
    if n > cap + 50:
        to_drop = n - cap
        conn.execute(
            """
            DELETE FROM beacon_events WHERE id IN (
                SELECT id FROM beacon_events ORDER BY id ASC LIMIT ?
            )
            """,
            (to_drop,),
        )


def _prune_beacons_postgres(conn, cap: int) -> None:
    if cap <= 0:
        return
    import psycopg.rows

    with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute("SELECT COUNT(*) AS c FROM beacon_events")
        n = int(cur.fetchone()["c"])
        if n > cap + 50:
            to_drop = n - cap
            cur.execute(
                """
                DELETE FROM beacon_events WHERE id IN (
                    SELECT id FROM beacon_events ORDER BY id ASC LIMIT %s
                )
                """,
                (to_drop,),
            )


def _bundle_for_storage(bundle: dict[str, Any], photo: str | None) -> str | None:
    """JSON do pacote para arquivo (foto referenciada como flag se já está na coluna dedicada)."""
    try:
        b = dict(bundle)
        if isinstance(photo, str) and photo and b.get("photo_jpeg_base64"):
            ph = b["photo_jpeg_base64"]
            b["photo_jpeg_base64"] = f"<same_as_column len={len(ph)}>"
        return json.dumps(b, ensure_ascii=False)
    except Exception:
        return None


def insert_beacon(ev: dict[str, Any]) -> None:
    geo = ev.get("geolocation")
    geo_json = json.dumps(geo, ensure_ascii=False) if geo is not None else None
    raw_bundle = ev.get("raw_bundle")
    raw_json = None
    if isinstance(raw_bundle, dict):
        raw_json = _bundle_for_storage(raw_bundle, ev.get("photo_jpeg_base64") if isinstance(ev.get("photo_jpeg_base64"), str) else None)
    cap = _beacon_cap()

    with _lock:
        if backend() == "sqlite":
            conn = _sqlite_connect()
            try:
                conn.execute(
                    """
                    INSERT INTO beacon_events (
                        ts, device_key, ip, user_agent, collected_at,
                        beacon_context_json, geolocation_json, camera_status,
                        camera_debug_json, fingerprint_json, photo_jpeg_base64,
                        raw_bundle_json, device_label
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        float(ev["ts"]),
                        str(ev["device_key"]),
                        ev.get("ip"),
                        ev.get("user_agent"),
                        ev.get("collected_at"),
                        json.dumps(ev.get("beacon_context") or {}, ensure_ascii=False),
                        geo_json,
                        ev.get("camera_status"),
                        json.dumps(ev.get("camera_debug") or {}, ensure_ascii=False),
                        json.dumps(ev.get("fingerprint") or {}, ensure_ascii=False),
                        ev.get("photo_jpeg_base64"),
                        raw_json,
                        ev.get("device_label"),
                    ),
                )
                _prune_beacons_sqlite(conn, cap)
                conn.commit()
            finally:
                conn.close()
        else:
            import psycopg.rows

            conn = _pg_connect()
            try:
                with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
                    cur.execute(
                        """
                        INSERT INTO beacon_events (
                            ts, device_key, ip, user_agent, collected_at,
                            beacon_context_json, geolocation_json, camera_status,
                            camera_debug_json, fingerprint_json, photo_jpeg_base64,
                            raw_bundle_json, device_label
                        ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                        """,
                        (
                            float(ev["ts"]),
                            str(ev["device_key"]),
                            ev.get("ip"),
                            ev.get("user_agent"),
                            ev.get("collected_at"),
                            json.dumps(ev.get("beacon_context") or {}, ensure_ascii=False),
                            geo_json,
                            ev.get("camera_status"),
                            json.dumps(ev.get("camera_debug") or {}, ensure_ascii=False),
                            json.dumps(ev.get("fingerprint") or {}, ensure_ascii=False),
                            ev.get("photo_jpeg_base64"),
                            raw_json,
                            ev.get("device_label"),
                        ),
                    )
                _prune_beacons_postgres(conn, cap)
                conn.commit()
            finally:
                conn.close()


def list_beacons(limit: int = 200) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with _lock:
        if backend() == "sqlite":
            conn = _sqlite_connect()
            try:
                cur = conn.execute(
                    "SELECT * FROM beacon_events ORDER BY id DESC LIMIT ?",
                    (limit,),
                )
                raw = cur.fetchall()
            finally:
                conn.close()
            for r in raw:
                d = _beacon_row_to_dict(r)
                d.pop("raw_bundle", None)
                rows.append(d)
        else:
            import psycopg.rows

            conn = _pg_connect()
            try:
                with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
                    cur.execute(
                        "SELECT * FROM beacon_events ORDER BY id DESC LIMIT %s",
                        (limit,),
                    )
                    raw = cur.fetchall()
            finally:
                conn.close()
            for r in raw:
                d = _beacon_row_to_dict(r)
                d.pop("raw_bundle", None)
                rows.append(d)
    return rows


def all_labels() -> dict[str, str]:
    with _lock:
        if backend() == "sqlite":
            conn = _sqlite_connect()
            try:
                cur = conn.execute("SELECT device_key, label FROM device_labels")
                raw = cur.fetchall()
            finally:
                conn.close()
            return {str(r["device_key"]): str(r["label"]) for r in raw}
        import psycopg.rows

        conn = _pg_connect()
        try:
            with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
                cur.execute("SELECT device_key, label FROM device_labels")
                raw = cur.fetchall()
        finally:
            conn.close()
        return {str(r["device_key"]): str(r["label"]) for r in raw}


def get_label(device_key: str) -> str | None:
    """Nome amigável atual na tabela `device_labels`, ou None."""
    if not device_key:
        return None
    with _lock:
        if backend() == "sqlite":
            conn = _sqlite_connect()
            try:
                cur = conn.execute(
                    "SELECT label FROM device_labels WHERE device_key = ? LIMIT 1",
                    (device_key,),
                )
                row = cur.fetchone()
            finally:
                conn.close()
            return str(row["label"]) if row else None
        import psycopg.rows

        conn = _pg_connect()
        try:
            with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
                cur.execute(
                    "SELECT label FROM device_labels WHERE device_key = %s LIMIT 1",
                    (device_key,),
                )
                row = cur.fetchone()
        finally:
            conn.close()
        return str(row["label"]) if row else None


def upsert_label(device_key: str, label: str) -> None:
    t = time.time()
    with _lock:
        if backend() == "sqlite":
            conn = _sqlite_connect()
            try:
                conn.execute(
                    """
                    INSERT INTO device_labels (device_key, label, updated_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(device_key) DO UPDATE SET
                        label = excluded.label,
                        updated_at = excluded.updated_at
                    """,
                    (device_key, label, t),
                )
                conn.commit()
            finally:
                conn.close()
        else:
            conn = _pg_connect()
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO device_labels (device_key, label, updated_at)
                        VALUES (%s, %s, %s)
                        ON CONFLICT (device_key) DO UPDATE SET
                            label = EXCLUDED.label,
                            updated_at = EXCLUDED.updated_at
                        """,
                        (device_key, label, t),
                    )
                conn.commit()
            finally:
                conn.close()


def delete_label(device_key: str) -> None:
    with _lock:
        if backend() == "sqlite":
            conn = _sqlite_connect()
            try:
                conn.execute("DELETE FROM device_labels WHERE device_key = ?", (device_key,))
                conn.commit()
            finally:
                conn.close()
        else:
            conn = _pg_connect()
            try:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM device_labels WHERE device_key = %s", (device_key,))
                conn.commit()
            finally:
                conn.close()


def insert_audit(event: dict[str, Any]) -> None:
    t = float(event.get("ts") or time.time())
    payload = json.dumps(event, ensure_ascii=False)
    cap = _audit_cap()
    with _lock:
        if backend() == "sqlite":
            conn = _sqlite_connect()
            try:
                conn.execute(
                    "INSERT INTO audit_events (ts, event_json) VALUES (?, ?)",
                    (t, payload),
                )
                if cap > 0:
                    cur = conn.execute("SELECT COUNT(*) AS c FROM audit_events")
                    n = int(cur.fetchone()["c"])
                    if n > cap + 100:
                        to_drop = n - cap
                        conn.execute(
                            """
                            DELETE FROM audit_events WHERE id IN (
                                SELECT id FROM audit_events ORDER BY id ASC LIMIT ?
                            )
                            """,
                            (to_drop,),
                        )
                conn.commit()
            finally:
                conn.close()
        else:
            import psycopg.rows

            conn = _pg_connect()
            try:
                with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
                    cur.execute(
                        "INSERT INTO audit_events (ts, event_json) VALUES (%s, %s)",
                        (t, payload),
                    )
                    if cap > 0:
                        cur.execute("SELECT COUNT(*) AS c FROM audit_events")
                        n = int(cur.fetchone()["c"])
                        if n > cap + 100:
                            to_drop = n - cap
                            cur.execute(
                                """
                                DELETE FROM audit_events WHERE id IN (
                                    SELECT id FROM audit_events ORDER BY id ASC LIMIT %s
                                )
                                """,
                                (to_drop,),
                            )
                conn.commit()
            finally:
                conn.close()


def list_audit_tail(limit: int = 100) -> list[dict[str, Any]]:
    """Últimos `limit` eventos, do mais antigo ao mais recente (compatível com o painel /ver)."""
    with _lock:
        if backend() == "sqlite":
            conn = _sqlite_connect()
            try:
                cur = conn.execute(
                    """
                    SELECT event_json FROM audit_events
                    WHERE id IN (
                        SELECT id FROM audit_events ORDER BY id DESC LIMIT ?
                    )
                    ORDER BY id ASC
                    """,
                    (limit,),
                )
                raw = [json.loads(r["event_json"]) for r in cur.fetchall()]
            finally:
                conn.close()
            return raw
        import psycopg.rows

        conn = _pg_connect()
        try:
            with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
                cur.execute(
                    """
                    SELECT event_json FROM audit_events
                    WHERE id IN (
                        SELECT id FROM audit_events ORDER BY id DESC LIMIT %s
                    )
                    ORDER BY id ASC
                    """,
                    (limit,),
                )
                raw = [json.loads(r["event_json"]) for r in cur.fetchall()]
        finally:
            conn.close()
        return raw
