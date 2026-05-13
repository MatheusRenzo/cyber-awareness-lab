"""Entrada Gunicorn: gunicorn -w 2 -b 0.0.0.0:8787 wsgi:app"""

from app import app

__all__ = ["app"]
