#!/usr/bin/env python3
"""Temporary validation snapshot of Spatial Studio's FJD ObservationSet ingester."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import tarfile
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Callable, Iterable

SCHEMA_VERSION = "spatial-studio/observation-set/v1"
ADAPTER_NAME = "fjd-p2-project/v1"
DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024


class IngestionError(ValueError):
    pass


@dataclass(frozen=True)
class ArchiveLimits:
    maximum_entries: int = 100_000
    maximum_total_uncompressed_bytes: int = 32 * 1024 * 1024 * 1024
    maximum_entry_bytes: int = 12 * 1024 * 1024 * 1024
    maximum_compression_ratio: float = 2_000.0


@dataclass(frozen=True)
class Candidate:
    role: str
    source_path: str
    media_type: str | None
    size: int
    opener: Callable[[], BinaryIO]


@dataclass(frozen=True)
class StoredObject:
    sha256: str
    bytes: int
    object_path: str
    source_path: str
    media_type: str | None

    def manifest_value(self) -> dict[str, Any]:
        return {
            "sha256": self.sha256,
            "bytes": self.bytes,
            "object_path": self.object_path,
            "source_path": self.source_path,
            "media_type": self.media_type,
        }


def _sha256_file(path: Path, chunk_bytes: int = DEFAULT_CHUNK_BYTES) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_bytes):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _normalize_archive_path(raw: str, label: str) -> str:
    if not raw or "\x00" in raw or "\\" in raw:
        raise IngestionError(f"unsafe {label} path: {raw!r}")
    path = PurePosixPath(raw)
    if (
        path.is_absolute()
        or not path.parts
        or any(part in ("", ".", "..") for part in path.parts)
        or ":" in path.parts[0]
    ):
        raise IngestionError(f"unsafe {label} path: {raw!r}")
    return path.as_posix()


def _zip_member_is_symlink(info: zipfile.ZipInfo) -> bool:
    return stat.S_ISLNK(info.external_attr >> 16)


def _validate_zip(archive: zipfile.ZipFile, limits: ArchiveLimits) -> list[zipfile.ZipInfo]:
    infos = archive.infolist()
    if len(infos) > limits.maximum_entries:
        raise IngestionError(f"outer ZIP contains {len(infos)} entries; limit is {limits.maximum_entries}")
    total = 0
    for info in infos:
        _normalize_archive_path(info.filename, "ZIP")
        if _zip_member_is_symlink(info):
            raise IngestionError(f"ZIP symbolic link is not allowed: {info.filename!r}")
        if info.is_dir():
            continue
        if info.file_size > limits.maximum_entry_bytes:
            raise IngestionError(
                f"ZIP entry {info.filename!r} is {info.file_size} bytes; limit is {limits.maximum_entry_bytes}"
            )
        total += info.file_size
        if total > limits.maximum_total_uncompressed_bytes:
            raise IngestionError("outer ZIP exceeds the total uncompressed-byte safety limit")
        ratio = info.file_size / max(info.compress_size, 1)
        if ratio > limits.maximum_compression_ratio:
            raise IngestionError(
                f"ZIP entry {info.filename!r} has suspicious compression ratio {ratio:.1f}"
            )
    return infos


def _validate_tar_members(
    archive: tarfile.TarFile,
    limits: ArchiveLimits,
    compressed_bytes: int,
) -> list[tarfile.TarInfo]:
    members = archive.getmembers()
    if len(members) > limits.maximum_entries:
        raise IngestionError(
            f"nested LAS archive contains {len(members)} entries; limit is {limits.maximum_entries}"
        )
    total = 0
    for member in members:
        _normalize_archive_path(member.name, "TAR")
        if member.issym() or member.islnk():
            raise IngestionError(f"TAR link is not allowed: {member.name!r}")
        if not member.isfile() and not member.isdir():
            raise IngestionError(f"unsupported TAR member type for {member.name!r}")
        if member.isfile():
            if member.size > limits.maximum_entry_bytes:
                raise IngestionError(
                    f"TAR member {member.name!r} is {member.size} bytes; limit is {limits.maximum_entry_bytes}"
                )
            total += member.size
            if total > limits.maximum_total_uncompressed_bytes:
                raise IngestionError("nested LAS archive exceeds the total uncompressed-byte safety limit")
    ratio = total / max(compressed_bytes, 1)
    if ratio > limits.maximum_compression_ratio:
        raise IngestionError(f"nested LAS archive has suspicious aggregate compression ratio {ratio:.1f}")
    return members


def _copy_bounded(source: BinaryIO, destination: BinaryIO, maximum_bytes: int) -> int:
    copied = 0
    while chunk := source.read(DEFAULT_CHUNK_BYTES):
        copied += len(chunk)
        if copied > maximum_bytes:
            raise IngestionError(f"stream exceeded declared safety limit of {maximum_bytes} bytes")
        destination.write(chunk)
    return copied


def _single(candidates: list[Candidate], role: str, *, required: bool = True) -> Candidate | None:
    matches = [candidate for candidate in candidates if candidate.role == role]
    if not matches:
        if required:
            raise IngestionError(f"required FJD role {role!r} was not found")
        return None
    if len(matches) > 1:
        paths = ", ".join(sorted(candidate.source_path for candidate in matches))
        raise IngestionError(f"role {role!r} is ambiguous across: {paths}")
    return matches[0]


def _media_type(path: str) -> str | None:
    lower = path.lower()
    if lower.endswith(".fjdata"):
        return "application/vnd.fjd.fjdata"
    if lower.endswith(".trajectory.las") or lower.endswith(".las"):
        return "application/vnd.las"
    if lower.endswith(".laz"):
        return "application/vnd.laszip"
    if lower.endswith(".insv"):
        return "video/mp4"
    if lower.endswith(".rtcm"):
        return "application/vnd.rtcm"
    if lower.endswith((".fjdslamp2", ".fjdslamp2.gz", ".fjdslamp2.tgz")):
        return "application/vnd.fjd.slam-capture"
    return None


def _outer_candidates(
    archive: zipfile.ZipFile,
    infos: list[zipfile.ZipInfo],
    include_raw_slam: bool,
) -> tuple[list[Candidate], zipfile.ZipInfo]:
    candidates: list[Candidate] = []
    nested_las: list[zipfile.ZipInfo] = []
    for info in infos:
        if info.is_dir():
            continue
        normalized = _normalize_archive_path(info.filename, "ZIP")
        lower = normalized.lower()
        if lower.endswith((".las.tgz", ".las.tar.gz")):
            nested_las.append(info)
            continue
        role: str | None = None
        if lower.endswith(".insv"):
            role = "external_camera_media"
        elif lower.endswith(".rtcm"):
            role = "rtcm_corrections"
        elif include_raw_slam and lower.endswith(
            (".fjdslamp2", ".fjdslamp2.gz", ".fjdslamp2.tgz")
        ):
            role = "raw_slam_capture"
        if role is not None:
            candidates.append(
                Candidate(
                    role=role,
                    source_path=normalized,
                    media_type=_media_type(normalized),
                    size=info.file_size,
                    opener=lambda info=info: archive.open(info, "r"),
                )
            )
    if len(nested_las) != 1:
        paths = ", ".join(sorted(info.filename for info in nested_las)) or "none"
        raise IngestionError(
            f"expected exactly one nested .las.tgz package; found {len(nested_las)}: {paths}"
        )
    return candidates, nested_las[0]


def _spool_zip_member(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    directory: Path,
    limits: ArchiveLimits,
) -> Path:
    destination = directory / "nested-las.tgz"
    with archive.open(info, "r") as source, destination.open("wb") as output:
        copied = _copy_bounded(source, output, limits.maximum_entry_bytes)
    if copied != info.file_size:
        raise IngestionError(
            f"nested LAS package yielded {copied} bytes; ZIP declared {info.file_size}"
        )
    return destination


def _nested_candidates(
    nested_path: Path,
    outer_source_path: str,
    limits: ArchiveLimits,
) -> tuple[tarfile.TarFile, list[Candidate]]:
    archive = tarfile.open(nested_path, mode="r:gz")
    members = _validate_tar_members(archive, limits, nested_path.stat().st_size)
    candidates: list[Candidate] = []
    for member in members:
        if not member.isfile():
            continue
        normalized = _normalize_archive_path(member.name, "TAR")
        lower = normalized.lower()
        role: str | None = None
        if lower.endswith(".fjdata"):
            role = "fjdata"
        elif lower.endswith(".trajectory.las"):
            role = "scanner_trajectory"
        elif lower.endswith((".las", ".laz")):
            role = "metric_point_cloud"
        if role is None:
            continue

        def opener(member: tarfile.TarInfo = member) -> BinaryIO:
            stream = archive.extractfile(member)
            if stream is None:
                raise IngestionError(f"cannot extract TAR member {member.name!r}")
            return stream

        candidates.append(
            Candidate(
                role=role,
                source_path=f"{outer_source_path}!{normalized}",
                media_type=_media_type(normalized),
                size=member.size,
                opener=opener,
            )
        )
    return archive, candidates


def _ensure_canonical_parent(root: Path, relative: Path) -> None:
    current = root
    for part in relative.parts[:-1]:
        current = current / part
        if current.is_symlink():
            raise IngestionError(f"object-store parent is a symbolic link: {current}")
        current.mkdir(exist_ok=True)
        if not current.is_dir():
            raise IngestionError(f"object-store parent is not a directory: {current}")


def _store_candidate(root: Path, candidate: Candidate, limits: ArchiveLimits) -> StoredObject:
    temporary_directory = root / ".tmp"
    if temporary_directory.is_symlink():
        raise IngestionError(f"temporary directory is a symbolic link: {temporary_directory}")
    temporary_directory.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix="object-", suffix=".partial", dir=temporary_directory
    )
    temporary_path = Path(temporary_name)
    digest = hashlib.sha256()
    copied = 0
    try:
        with os.fdopen(file_descriptor, "wb") as destination, candidate.opener() as source:
            while chunk := source.read(DEFAULT_CHUNK_BYTES):
                copied += len(chunk)
                if copied > limits.maximum_entry_bytes:
                    raise IngestionError(
                        f"candidate {candidate.source_path!r} exceeded the entry limit"
                    )
                digest.update(chunk)
                destination.write(chunk)
            destination.flush()
            os.fsync(destination.fileno())
        if copied != candidate.size:
            raise IngestionError(
                f"candidate {candidate.source_path!r} yielded {copied} bytes; archive declared {candidate.size}"
            )
        sha256 = digest.hexdigest()
        relative = Path("objects") / "sha256" / sha256[:2] / sha256
        _ensure_canonical_parent(root, relative)
        final_path = root / relative
        if final_path.is_symlink():
            raise IngestionError(f"content-addressed object is a symbolic link: {final_path}")
        if final_path.exists():
            if not final_path.is_file():
                raise IngestionError(f"object path is not a regular file: {final_path}")
            if final_path.stat().st_size != copied or _sha256_file(final_path) != sha256:
                raise IngestionError(
                    f"existing content-addressed object failed validation: {final_path}"
                )
            temporary_path.unlink()
        else:
            os.replace(temporary_path, final_path)
        return StoredObject(
            sha256=sha256,
            bytes=copied,
            object_path=relative.as_posix(),
            source_path=candidate.source_path,
            media_type=candidate.media_type,
        )
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


def _write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


def _manifest_identity(unsigned_manifest: dict[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(_canonical_json(unsigned_manifest)).hexdigest()


def _validate_existing_manifest_for_fast_repeat(
    output_root: Path,
    source_sha256: str,
    source_bytes: int,
    include_raw_slam: bool,
) -> dict[str, Any] | None:
    manifest_path = output_root / "manifest.json"
    if not manifest_path.exists():
        return None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise IngestionError(f"existing manifest is invalid: {exc}") from exc
    source = manifest.get("source")
    metadata = manifest.get("metadata")
    if not isinstance(source, dict) or not isinstance(metadata, dict):
        raise IngestionError("existing manifest is structurally invalid")
    same_profile = (
        manifest.get("schema_version") == SCHEMA_VERSION
        and manifest.get("adapter") == ADAPTER_NAME
        and source.get("sha256") == source_sha256
        and source.get("bytes") == source_bytes
        and metadata.get("raw_slam_included") is include_raw_slam
    )
    if not same_profile:
        raise IngestionError(
            "output already contains an ObservationSet from a different source or ingestion profile"
        )
    unsigned = {key: value for key, value in manifest.items() if key != "observation_set_id"}
    if manifest.get("observation_set_id") != _manifest_identity(unsigned):
        raise IngestionError("existing ObservationSet manifest identity is invalid")
    objects = manifest.get("objects")
    roles = manifest.get("roles")
    if not isinstance(objects, list) or not isinstance(roles, dict):
        raise IngestionError("existing ObservationSet objects or roles are invalid")
    digests = set()
    for position, item in enumerate(objects):
        if not isinstance(item, dict):
            raise IngestionError(f"existing manifest object {position} is invalid")
        digest = item.get("sha256")
        object_path = item.get("object_path")
        expected_bytes = item.get("bytes")
        if (
            not isinstance(digest, str)
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
            or object_path != f"objects/sha256/{digest[:2]}/{digest}"
            or not isinstance(expected_bytes, int)
            or isinstance(expected_bytes, bool)
            or expected_bytes < 0
        ):
            raise IngestionError(f"existing manifest object {position} is invalid")
        path = output_root / object_path
        if path.is_symlink() or not path.is_file():
            raise IngestionError(f"existing object is missing or unsafe: {path}")
        if path.stat().st_size != expected_bytes or _sha256_file(path) != digest:
            raise IngestionError(f"existing object failed validation: {path}")
        digests.add(digest)
    for role, digest in roles.items():
        if not isinstance(role, str) or digest not in digests:
            raise IngestionError(f"existing role {role!r} references an invalid object")
    return manifest


def ingest_fjd_project(
    source_zip: Path,
    output_root: Path,
    *,
    include_raw_slam: bool = False,
    limits: ArchiveLimits = ArchiveLimits(),
) -> dict[str, Any]:
    source_zip = source_zip.resolve(strict=True)
    if not source_zip.is_file():
        raise IngestionError(f"source is not a regular file: {source_zip}")
    if output_root.is_symlink():
        raise IngestionError(f"output root may not be a symbolic link: {output_root}")
    output_root.mkdir(parents=True, exist_ok=True)
    output_root = output_root.resolve(strict=True)
    source_bytes = source_zip.stat().st_size
    source_sha256 = _sha256_file(source_zip)

    existing = _validate_existing_manifest_for_fast_repeat(
        output_root,
        source_sha256,
        source_bytes,
        include_raw_slam,
    )
    if existing is not None:
        return existing

    with zipfile.ZipFile(source_zip, mode="r") as outer:
        infos = _validate_zip(outer, limits)
        outer_candidates, nested_info = _outer_candidates(outer, infos, include_raw_slam)
        nested_source_path = _normalize_archive_path(nested_info.filename, "ZIP")
        with tempfile.TemporaryDirectory(prefix="spatial-studio-fjd-") as temporary:
            nested_path = _spool_zip_member(outer, nested_info, Path(temporary), limits)
            nested_archive, nested_candidates = _nested_candidates(
                nested_path, nested_source_path, limits
            )
            try:
                candidates = outer_candidates + nested_candidates
                selected = [
                    _single(candidates, "metric_point_cloud"),
                    _single(candidates, "scanner_trajectory"),
                    _single(candidates, "fjdata"),
                    _single(candidates, "external_camera_media"),
                    _single(candidates, "rtcm_corrections", required=False),
                    _single(candidates, "raw_slam_capture", required=False)
                    if include_raw_slam
                    else None,
                ]
                selected_candidates = [candidate for candidate in selected if candidate]
                stored = [
                    _store_candidate(output_root, candidate, limits)
                    for candidate in selected_candidates
                ]
            finally:
                nested_archive.close()

    unique_objects: dict[str, StoredObject] = {}
    roles: dict[str, str] = {}
    for candidate, stored_object in zip(selected_candidates, stored, strict=True):
        unique_objects.setdefault(stored_object.sha256, stored_object)
        roles[candidate.role] = stored_object.sha256

    objects = [
        item.manifest_value()
        for item in sorted(unique_objects.values(), key=lambda value: value.sha256)
    ]
    unsigned_manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "adapter": ADAPTER_NAME,
        "source": {
            "display_name": source_zip.name,
            "sha256": source_sha256,
            "bytes": source_bytes,
        },
        "objects": objects,
        "roles": dict(sorted(roles.items())),
        "metadata": {
            "raw_slam_included": include_raw_slam,
            "nested_las_source_path": nested_source_path,
        },
    }
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "observation_set_id": _manifest_identity(unsigned_manifest),
        **{key: value for key, value in unsigned_manifest.items() if key != "schema_version"},
    }

    manifest_path = output_root / "manifest.json"
    if manifest_path.exists():
        raise IngestionError(
            "output manifest appeared during ingestion; refuse to overwrite concurrent work"
        )
    _write_json_atomic(manifest_path, manifest)
    shutil.rmtree(output_root / ".tmp", ignore_errors=True)
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_zip", type=Path)
    parser.add_argument("--output", "-o", type=Path, required=True)
    parser.add_argument("--include-raw-slam", action="store_true")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        manifest = ingest_fjd_project(
            args.source_zip,
            args.output,
            include_raw_slam=args.include_raw_slam,
        )
    except (IngestionError, OSError, zipfile.BadZipFile, tarfile.TarError) as exc:
        raise SystemExit(f"FJD ObservationSet ingestion failed: {exc}") from exc
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
