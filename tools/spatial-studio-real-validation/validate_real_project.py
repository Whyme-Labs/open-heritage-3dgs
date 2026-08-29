#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path
from typing import Any

from ingest_fjd import ingest_fjd_project
from observation_bindings import materialize_bindings

REQUIRED_ROLES = (
    "metric_point_cloud",
    "scanner_trajectory",
    "fjdata",
    "external_camera_media",
)
OPTIONAL_ROLES = ("rtcm_corrections",)


def sanitize_paths(value: Any, observation_set_root: Path) -> Any:
    if isinstance(value, dict):
        return {
            key: sanitize_paths(item, observation_set_root)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize_paths(item, observation_set_root) for item in value]
    if isinstance(value, str):
        root = str(observation_set_root.resolve())
        if value.startswith(root):
            return "$OBSERVATION_SET" + value[len(root) :]
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--observation-set", type=Path, required=True)
    parser.add_argument("--results", type=Path, required=True)
    args = parser.parse_args()

    args.results.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    first_started = time.monotonic()
    first = ingest_fjd_project(args.source, args.observation_set)
    first_seconds = time.monotonic() - first_started

    missing = [role for role in REQUIRED_ROLES if role not in first["roles"]]
    if missing:
        raise RuntimeError(f"missing required roles after ingestion: {missing}")
    if "raw_slam_capture" in first["roles"]:
        raise RuntimeError("raw_slam_capture was selected by the default profile")

    repeat_started = time.monotonic()
    repeat = ingest_fjd_project(args.source, args.observation_set)
    repeat_seconds = time.monotonic() - repeat_started
    if repeat != first:
        raise RuntimeError("repeat ingestion changed the ObservationSet manifest")

    roles = [*REQUIRED_ROLES]
    roles.extend(role for role in OPTIONAL_ROLES if role in first["roles"])
    binding_document = {
        "schema_version": "spatial-studio/observation-bindings/v1",
        "bindings": [
            {"role": role, "target": f"/inputs/{role}"}
            for role in roles
        ],
    }
    request, provenance = materialize_bindings(
        args.observation_set,
        binding_document,
        {
            "schema_version": "spatial-studio/real-p2-validation-request/v1",
            "inputs": {},
            "provenance": {},
        },
    )

    object_rows = []
    for item in first["objects"]:
        path = args.observation_set / item["object_path"]
        if not path.is_file() or path.is_symlink():
            raise RuntimeError(f"invalid stored object after ingestion: {path}")
        object_rows.append(
            {
                "sha256": item["sha256"],
                "bytes": item["bytes"],
                "object_path": item["object_path"],
                "source_path": item["source_path"],
                "media_type": item.get("media_type"),
                "roles": sorted(
                    role
                    for role, digest in first["roles"].items()
                    if digest == item["sha256"]
                ),
            }
        )

    summary = {
        "schema_version": "spatial-studio/real-fjd-validation/v1",
        "passes": True,
        "source": first["source"],
        "observation_set_id": first["observation_set_id"],
        "adapter": first["adapter"],
        "role_count": len(first["roles"]),
        "roles": first["roles"],
        "object_count": len(first["objects"]),
        "selected_object_bytes": sum(item["bytes"] for item in first["objects"]),
        "raw_slam_included": first["metadata"]["raw_slam_included"],
        "first_ingestion_seconds": round(first_seconds, 3),
        "repeat_integrity_seconds": round(repeat_seconds, 3),
        "total_validation_seconds": round(time.monotonic() - started, 3),
        "repeat_manifest_identical": repeat == first,
        "binding_count": len(provenance["bindings"]),
        "objects": object_rows,
    }

    (args.results / "manifest.json").write_text(
        json.dumps(first, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (args.results / "validation-summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (args.results / "binding-provenance.json").write_text(
        json.dumps(
            sanitize_paths(provenance, args.observation_set),
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    (args.results / "materialized-request.json").write_text(
        json.dumps(
            sanitize_paths(request, args.observation_set),
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    shutil.rmtree(args.observation_set, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
