"""
CLI entry point for the CalSim View web application.

Usage
-----
    # Explicit mode (original)
    python -m csview.app serve \\
        --network-dir data/network/ \\
        --study data/study/study_a/ \\
        --host 0.0.0.0 --port 8000

    # Hosted mode: load network + studies from bundled data.zip
    python -m csview.app serve --hosted

    # Bundle data.zip for hosted deployment
    python -m csview.app bundle \\
        --network-dir data/network/ \\
        --study data/study/study_a
"""

from __future__ import annotations

import argparse
import atexit
import logging
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m csview.app",
        description="CalSim View — interactive visualisation for CalSim 3 results",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose logging")

    subparsers = parser.add_subparsers(dest="command", required=True)

    # ---- serve ----
    p_serve = subparsers.add_parser("serve", help="Start the web server")
    p_serve.add_argument(
        "--network-dir",
        type=Path,
        default=None,
        help="Directory containing catalog.json + network.geojson (default: ./data/network/)",
    )
    p_serve.add_argument(
        "--study",
        dest="studies",
        action="append",
        type=Path,
        default=[],
        metavar="STUDY_DIR",
        help="Study root directory (repeat for multiple studies)",
    )
    p_serve.add_argument(
        "--default-study",
        default=None,
        help="Name of the study to activate by default",
    )
    p_serve.add_argument(
        "--hosted",
        action="store_true",
        help=(
            "Load network + studies from bundled csview/app/data.zip. "
            "Extracts to a temp directory at startup. "
            "--network-dir and --study are ignored."
        ),
    )
    p_serve.add_argument(
        "--host",
        default="127.0.0.1",
        help="Bind host (default: 127.0.0.1)",
    )
    p_serve.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Bind port (default: 8000)",
    )
    p_serve.add_argument(
        "--reload",
        action="store_true",
        help="Enable uvicorn auto-reload (development only)",
    )

    # ---- bundle ----
    p_bundle = subparsers.add_parser(
        "bundle",
        help="Create data.zip for hosted deployment",
    )
    p_bundle.add_argument(
        "--network-dir",
        type=Path,
        required=True,
        help="Directory containing catalog.json + network.geojson + overlay GeoJSON files",
    )
    p_bundle.add_argument(
        "--study",
        dest="studies",
        action="append",
        type=Path,
        default=[],
        metavar="STUDY_DIR",
        required=True,
        help=(
            "Study directory containing results.parquet + results_meta.json. "
            "Can be repeated for multiple studies."
        ),
    )
    p_bundle.add_argument(
        "--output", "-o",
        type=Path,
        default=None,
        help="Output zip path (default: csview/app/data.zip)",
    )

    return parser


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _extract_bundle() -> tuple:
    """Extract the bundled data.zip to a temp directory.

    Returns
    -------
    network_dir : Path
        ``<tmpdir>/network/`` containing catalog.json, network.geojson, etc.
    study_paths : list[Path]
        One ``<tmpdir>/studies/<name>`` entry per study in the zip.
    """
    bundle = Path(__file__).parent / "data.zip"
    if not bundle.exists():
        print(
            f"Error: bundled data.zip not found at {bundle}\n"
            "Run `python -m csview.app bundle ...` to create it first,\n"
            "or set DATA_ZIP_URL in Render environment variables.",
            file=sys.stderr,
        )
        sys.exit(1)

    tmpdir = Path(tempfile.mkdtemp(prefix="csview-app-"))
    atexit.register(shutil.rmtree, tmpdir, ignore_errors=True)

    with zipfile.ZipFile(bundle) as zf:
        zf.extractall(tmpdir)

    network_dir = tmpdir / "network"
    studies_dir = tmpdir / "studies"
    study_paths = []
    if studies_dir.is_dir():
        study_paths = sorted(p for p in studies_dir.iterdir() if p.is_dir())

    return network_dir, study_paths


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------

def main(argv=None) -> None:
    parser = _build_parser()
    args = parser.parse_args(argv)

    log_level = logging.DEBUG if getattr(args, "verbose", False) else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(levelname)s %(name)s — %(message)s",
        stream=sys.stdout,
    )

    if args.command == "serve":
        _cmd_serve(args)
    elif args.command == "bundle":
        _cmd_bundle(args)


def _cmd_serve(args) -> None:
    try:
        import uvicorn  # type: ignore
    except ImportError:
        print(
            "ERROR: uvicorn is not installed.\n"
            "Install with: pip install 'uvicorn[standard]'",
            file=sys.stderr,
        )
        sys.exit(1)

    from csview.app.server import create_app

    # ------------------------------------------------------------------ mode
    if args.hosted:
        if args.network_dir:
            print("Warning: --network-dir is ignored in --hosted mode.", file=sys.stderr)
        if args.studies:
            print("Warning: --study is ignored in --hosted mode.", file=sys.stderr)
        network_dir, study_paths = _extract_bundle()
    else:
        network_dir = args.network_dir or Path("data/network")
        study_paths = args.studies

        # Validate network dir
        catalog_path = network_dir / "catalog.json"
        if not catalog_path.exists():
            print(
                f"ERROR: catalog.json not found at {catalog_path}\n"
                "Build it first with:\n"
                "  python -m csview.geo "
                "--geo-dir reference/geoschematic "
                "--wresl reference/calsim-studies/<run>/Run/System "
                "--out data/network/",
                file=sys.stderr,
            )
            sys.exit(1)

    app = create_app(
        network_dir=network_dir,
        study_paths=study_paths,
        default_study=args.default_study,
    )

    # Resolve host/port. In hosted mode bind 0.0.0.0 (Render requires it).
    # PORT env var takes priority (Render injects it).
    if args.hosted:
        host = os.environ.get("HOST", "0.0.0.0")
    else:
        host = os.environ.get("HOST", args.host)
    port = int(os.environ.get("PORT", args.port))

    mode_label = "hosted" if args.hosted else "explicit"
    print(
        f"\nCalSim View starting at http://{host}:{port}  [{mode_label} mode]\n"
        f"  Network : {network_dir}\n"
        f"  Studies : {[str(s) for s in study_paths] or '(none)'}\n"
        f"  API docs: http://{host}:{port}/docs\n"
    )

    uvicorn.run(
        app,
        host=host,
        port=port,
        reload=args.reload,
        log_level="debug" if args.verbose else "info",
    )


def _cmd_bundle(args) -> None:
    network_dir = Path(args.network_dir).resolve()
    if not network_dir.exists():
        print(f"Error: --network-dir path does not exist: {network_dir}", file=sys.stderr)
        sys.exit(1)
    catalog_path = network_dir / "catalog.json"
    if not catalog_path.exists():
        print(f"Error: catalog.json not found in {network_dir}", file=sys.stderr)
        sys.exit(1)

    study_paths = [Path(s).resolve() for s in args.studies]
    for sp in study_paths:
        if not sp.exists():
            print(f"Error: study path does not exist: {sp}", file=sys.stderr)
            sys.exit(1)
        if not (sp / "results.parquet").exists():
            print(f"Error: results.parquet not found in {sp}", file=sys.stderr)
            sys.exit(1)

    if args.output:
        out_path = Path(args.output)
    else:
        out_path = Path(__file__).parent / "data.zip"

    out_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Building {out_path} ...")

    # Network files to include
    NETWORK_FILES = [
        "catalog.json",
        "network.geojson",
        "network.json",
        "watersheds.geojson",
        "water_budget_areas.geojson",
        "demand_units.geojson",
        "c2vsim_elements.geojson",
        "c2vsim_subregions.geojson",
        "network_diagnostics.json",
    ]

    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        # Write network files → network/
        for fname in NETWORK_FILES:
            src = network_dir / fname
            if src.exists():
                zf.write(src, f"network/{fname}")
                size_kb = src.stat().st_size / 1024
                print(f"  network/{fname} : {size_kb:.0f} KB")
            else:
                print(f"  network/{fname} : (not found, skipping)")

        # Write each study → studies/{name}/
        STUDY_FILES = [
            "results.parquet",
            "results_meta.json",
            "gw_budget.parquet",
            "gw_budget_meta.json",
        ]
        for sp in study_paths:
            study_name = sp.name
            file_count = 0
            for fname in STUDY_FILES:
                src = sp / fname
                if src.exists():
                    zf.write(src, f"studies/{study_name}/{fname}")
                    size_kb = src.stat().st_size / 1024
                    print(f"  studies/{study_name}/{fname} : {size_kb:.0f} KB")
                    file_count += 1
            print(f"  studies/{study_name}/ : {file_count} files")

    size_mb = out_path.stat().st_size / (1024 * 1024)
    print(f"\nBundle written: {out_path}  ({size_mb:.1f} MB)")
    print("\nTo serve the bundle:")
    print("  python -m csview.app serve --hosted")


if __name__ == "__main__":
    main()
