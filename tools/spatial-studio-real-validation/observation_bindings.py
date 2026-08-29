#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

SCHEMA_VERSION = "spatial-studio/observation-bindings/v1"
MANIFEST_SCHEMA_VERSION = "spatial-studio/observation-set/v1"
ROLE_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class BindingError(ValueError):
    pass


@dataclass(frozen=True)
class VerifiedObject:
    role: str
    sha256: str
    bytes: int
    object_path: str
    source_path: str
    media_type: str | None
    local_path: Path

    def provenance(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "sha256": self.sha256,
            "bytes": self.bytes,
            "object_path": self.object_path,
            "source_path": self.source_path,
            "media_type": self.media_type,
            "local_path": str(self.local_path),
        }


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(16 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest(root: Path) -> dict[str, Any]:
    root = root.resolve(strict=True)
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema_version") != MANIFEST_SCHEMA_VERSION:
        raise BindingError("unsupported ObservationSet schema")
    identity = manifest.get("observation_set_id")
    if not isinstance(identity, str) or not identity.startswith("sha256:"):
        raise BindingError("invalid ObservationSet identity")
    unsigned = {key: value for key, value in manifest.items() if key != "observation_set_id"}
    actual = hashlib.sha256(_canonical_json(unsigned)).hexdigest()
    if identity != f"sha256:{actual}":
        raise BindingError("ObservationSet manifest identity verification failed")
    return manifest


def index_objects(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for item in manifest.get("objects", []):
        digest = item.get("sha256")
        if not isinstance(digest, str) or not SHA256_PATTERN.fullmatch(digest):
            raise BindingError("invalid object digest")
        if digest in result:
            raise BindingError("duplicate object digest")
        result[digest] = item
    return result


def safe_path(root: Path, object_path: str) -> Path:
    posix = PurePosixPath(object_path)
    if posix.is_absolute() or ".." in posix.parts or posix.parts[:2] != ("objects", "sha256"):
        raise BindingError("unsafe object path")
    resolved_root = root.resolve(strict=True)
    current = resolved_root
    for part in posix.parts:
        current = current / part
        if current.is_symlink():
            raise BindingError("object path contains symbolic link")
    resolved = current.resolve(strict=True)
    resolved.relative_to(resolved_root)
    return resolved


def verify_role(root: Path, manifest: dict[str, Any], objects: dict[str, dict[str, Any]], role: str) -> VerifiedObject:
    if not ROLE_PATTERN.fullmatch(role):
        raise BindingError(f"invalid role {role!r}")
    digest = manifest.get("roles", {}).get(role)
    if not isinstance(digest, str) or digest not in objects:
        raise BindingError(f"required role {role!r} is absent")
    item = objects[digest]
    expected_path = f"objects/sha256/{digest[:2]}/{digest}"
    if item.get("object_path") != expected_path:
        raise BindingError("non-canonical object path")
    path = safe_path(root, expected_path)
    expected_bytes = item.get("bytes")
    if not isinstance(expected_bytes, int) or path.stat().st_size != expected_bytes:
        raise BindingError("object byte count mismatch")
    if _sha256_file(path) != digest:
        raise BindingError("object SHA-256 mismatch")
    return VerifiedObject(
        role=role,
        sha256=digest,
        bytes=expected_bytes,
        object_path=expected_path,
        source_path=item.get("source_path", ""),
        media_type=item.get("media_type"),
        local_path=path,
    )


def assign(document: dict[str, Any], pointer: str, value: Any) -> None:
    if not pointer.startswith("/"):
        raise BindingError("JSON Pointer must start with /")
    tokens = [token.replace("~1", "/").replace("~0", "~") for token in pointer[1:].split("/")]
    cursor: dict[str, Any] = document
    for token in tokens[:-1]:
        child = cursor.setdefault(token, {})
        if not isinstance(child, dict):
            raise BindingError("JSON Pointer crosses scalar")
        cursor = child
    cursor[tokens[-1]] = value


def materialize_bindings(root: Path, binding_document: dict[str, Any], template: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    if binding_document.get("schema_version") != SCHEMA_VERSION:
        raise BindingError("unsupported binding schema")
    bindings = binding_document.get("bindings")
    if not isinstance(bindings, list) or not bindings:
        raise BindingError("bindings must be non-empty")
    manifest = load_manifest(root)
    objects = index_objects(manifest)
    request = copy.deepcopy(template)
    verified: list[VerifiedObject] = []
    for binding in bindings:
        role = binding["role"]
        target = binding["target"]
        item = verify_role(root, manifest, objects, role)
        assign(request, target, str(item.local_path))
        verified.append(item)
    provenance = {
        "schema_version": SCHEMA_VERSION,
        "observation_set_id": manifest["observation_set_id"],
        "bindings": [item.provenance() for item in verified],
    }
    assign(request, "/provenance/observation_set", provenance)
    return request, provenance
