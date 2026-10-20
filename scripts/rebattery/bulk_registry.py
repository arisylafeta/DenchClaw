"""The bulk listing attribute registry, read from the database (crm_bulk_attributes and friends).

TEMPLATES and BUY_BOX keep the shapes the scripts always used, but nothing is read from files in the repo.
They load on first use and are cached for the life of the process. The connection is, in order:
BULK_REGISTRY_DSN, BULK_TRADES_TEST_DATABASE_URL, then the local denchclaw socket.
"""
import os
from collections.abc import Mapping

import psycopg2
import psycopg2.extras

DEFAULT_DSN = "host=/var/run/postgresql dbname=denchclaw"


def _dsn():
    return os.environ.get("BULK_REGISTRY_DSN") or os.environ.get("BULK_TRADES_TEST_DATABASE_URL") or DEFAULT_DSN


def load(dsn=None):
    conn = psycopg2.connect(dsn or _dsn())
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("select key, side, label, type, needed_for, visibility, min, max, sort_order from crm_bulk_attributes")
        attributes = {r["key"]: r for r in cur.fetchall()}
        cur.execute("select attribute_key, kind, label, sort_order from crm_bulk_attribute_kinds order by sort_order")
        kinds = cur.fetchall()
        cur.execute("select attribute_key, value, sort_order from crm_bulk_attribute_options order by sort_order")
        options = cur.fetchall()
        cur.execute("select file_type, label, needed_for from crm_bulk_required_files order by sort_order")
        required = cur.fetchall()
    finally:
        conn.close()
    fields = {"packs": [], "cells": [], "systems": [], "recycling": []}
    for row in kinds:
        attr = attributes[row["attribute_key"]]
        fields[row["kind"]].append({"key": row["attribute_key"], "label": row["label"],
                                    "neededFor": attr["needed_for"], "visibility": attr["visibility"]})

    def values(key):
        return [o["value"] for o in options if o["attribute_key"] == key]

    demand = sorted((a for a in attributes.values() if a["side"] == "demand"), key=lambda a: a["sort_order"])
    templates = {"fields": fields,
                 "requiredFiles": [{"type": r["file_type"], "label": r["label"], "neededFor": r["needed_for"]} for r in required]}
    buy_box = {
        "lists": {a["key"]: values(a["key"]) for a in demand if a["type"] == "set"},
        "labels": {a["key"]: a["label"] for a in demand if a["type"] == "set"},
        "numbers": {a["key"]: {"label": a["label"], "min": int(a["min"]), "max": int(a["max"])} for a in demand if a["type"] == "number"},
        "volume_units": values("volume_unit"),
        "price_units": values("price_unit"),
        "currencies": values("price_currency"),
    }
    return templates, buy_box


class _Lazy(Mapping):
    """A read-only mapping that loads the registry the first time it is used."""

    _loaded = None

    def __init__(self, index):
        self._index = index

    def _data(self):
        if _Lazy._loaded is None:
            _Lazy._loaded = load()
        return _Lazy._loaded[self._index]

    def __getitem__(self, key):
        return self._data()[key]

    def __iter__(self):
        return iter(self._data())

    def __len__(self):
        return len(self._data())


TEMPLATES = _Lazy(0)
BUY_BOX = _Lazy(1)
