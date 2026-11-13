#!/usr/bin/env python3
"""Canonicalize Valhalla indexed tars or union same-graph extracts without changing GraphIds."""
import argparse
import hashlib
import io
import json
import re
import struct
import tarfile
from pathlib import Path

TILE_PATH = re.compile(r"^[012]/(?:[0-9]{3}/)*[0-9]{3}\.gph$")
INDEX_FORMAT = "<QLL"  # offset:uint64, GraphId:uint32, tile bytes:uint32; indexed Valhalla tar
METADATA_NAME = "navoss-graph.json"


def graph_id(name):
    level, identifier = name.removesuffix(".gph").split("/", 1)
    return int(level) | (int(identifier.replace("/", "")) << 3)


def stream_hash(stream):
    return hashlib.file_digest(stream, "sha256").hexdigest()


def member_info(name, size, epoch):
    member = tarfile.TarInfo(name)
    member.size = size
    member.mode = 0o644
    member.mtime = epoch
    return member


def validate_metadata(metadata):
    required = {"graphId", "routingEngineVersion", "tileFormat", "tileFormatVersion", "dataDate", "speedProfileSha256"}
    if not isinstance(metadata, dict) or set(metadata) != required:
        raise ValueError("Invalid graph marker fields")
    if (not isinstance(metadata["graphId"], str) or not re.fullmatch(r"[0-9a-f]{64}", metadata["graphId"])
            or not isinstance(metadata["speedProfileSha256"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", metadata["speedProfileSha256"])
            or metadata["routingEngineVersion"] != "3.9.1"
            or metadata["tileFormat"] != "valhalla-gph"
            or metadata["tileFormatVersion"] != "3.9.1"
            or not isinstance(metadata["dataDate"], str)
            or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", metadata["dataDate"])):
        raise ValueError("Invalid graph marker values")


def assemble(inputs, output, epoch, metadata=None, canonicalize=False):
    if output.exists() or output in inputs:
        raise ValueError("Routing output must be a new path")
    if canonicalize and len(inputs) != 1:
        raise ValueError("Unmarked canonicalization accepts only one input")
    if metadata is not None:
        if len(inputs) != 1:
            raise ValueError("Seeding graph metadata accepts only one upstream extract")
        validate_metadata(metadata)
    archives = []
    tiles = {}
    accepted_metadata = metadata
    created_output = False
    try:
        for path in inputs:
            archive = tarfile.open(path, "r:")
            archives.append(archive)
            markers = [member for member in archive.getmembers() if member.name == METADATA_NAME]
            if len(markers) > 1:
                raise ValueError("Duplicate graph marker")
            if markers and (not markers[0].isfile() or markers[0].size > 4096):
                raise ValueError("Invalid graph marker member")
            if markers:
                with archive.extractfile(markers[0]) as stream:
                    source_metadata = json.load(stream)
                validate_metadata(source_metadata)
            else:
                source_metadata = None
            if source_metadata is None and not (canonicalize or metadata is not None):
                raise ValueError("Refusing to merge unmarked extracts; independent graphs are incompatible")
            if source_metadata is not None:
                if accepted_metadata is None:
                    accepted_metadata = source_metadata
                elif accepted_metadata != source_metadata:
                    raise ValueError("Extracts have different graph identities")
            seen = set()
            for member in archive.getmembers():
                if member.name in seen:
                    raise ValueError(f"Duplicate archive member: {member.name}")
                seen.add(member.name)
                if member.name in ("index.bin", METADATA_NAME):
                    continue
                if not member.isfile() or not TILE_PATH.fullmatch(member.name):
                    raise ValueError(f"Unsupported routing archive member: {member.name}")
                if accepted_metadata is not None:
                    with archive.extractfile(member) as stream:
                        header = stream.read(32)
                    if len(header) < 32 or header[16:32].split(b"\0", 1)[0].decode("ascii") != accepted_metadata["tileFormatVersion"]:
                        raise ValueError(f"Graph tile header does not match the pinned engine: {member.name}")
                if member.name in tiles:
                    previous_archive, previous_member = tiles[member.name]
                    with previous_archive.extractfile(previous_member) as previous, archive.extractfile(member) as current:
                        if previous_member.size != member.size or stream_hash(previous) != stream_hash(current):
                            raise ValueError(f"Overlapping tile bytes differ: {member.name}")
                else:
                    tiles[member.name] = (archive, member)
        if not tiles:
            raise ValueError("No routing tiles found")
        output.parent.mkdir(parents=True, exist_ok=True)
        index_size = len(tiles) * struct.calcsize(INDEX_FORMAT)
        entries = []
        with tarfile.open(output, "x", format=tarfile.USTAR_FORMAT) as destination:
            created_output = True
            destination.addfile(member_info("index.bin", index_size, epoch), io.BytesIO(bytes(index_size)))
            for name in sorted(tiles, key=graph_id):
                source, member = tiles[name]
                entries.append((destination.offset + tarfile.BLOCKSIZE, graph_id(name), member.size))
                with source.extractfile(member) as stream:
                    destination.addfile(member_info(name, member.size, epoch), stream)
            if accepted_metadata is not None:
                encoded = (json.dumps(accepted_metadata, sort_keys=True, separators=(",", ":")) + "\n").encode()
                destination.addfile(member_info(METADATA_NAME, len(encoded), epoch), io.BytesIO(encoded))
        with output.open("r+b") as destination:
            destination.seek(tarfile.BLOCKSIZE)
            for entry in entries:
                destination.write(struct.pack(INDEX_FORMAT, *entry))
        return {"tiles": len(tiles), "byteSize": output.stat().st_size, "graph": accepted_metadata}
    except Exception:
        if created_output:
            output.unlink(missing_ok=True)
        raise
    finally:
        for archive in archives:
            archive.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--epoch", type=int, required=True)
    parser.add_argument("--metadata", type=Path)
    parser.add_argument("--canonicalize", action="store_true")
    parser.add_argument("inputs", type=Path, nargs="+")
    args = parser.parse_args()
    metadata = json.loads(args.metadata.read_text()) if args.metadata else None
    result = assemble(args.inputs, args.output, args.epoch, metadata, args.canonicalize)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
