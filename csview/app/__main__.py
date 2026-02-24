"""
CLI entry point for the CalSim View web application.

Usage
-----
    # Run the app
    python -m csview.app \\
        --network-dir data/network/ \\
        --study data/study/study_a/ \\
        --host 0.0.0.0 --port 8000

    # One-time setup: build geo network catalog
    python -m csview.geo \\
        --geo-dir reference/geoschematic \\
        --wresl   reference/calsim-studies/study_a/Run/System \\
        --out     data/network/

    # One-time setup: pre-build Parquet results for a study
    python -m csview.study \\
        --source  reference/calsim-studies/study_a \\
        --catalog data/network/catalog.json \\
        --out     data/study/study_a/
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="calsim-view",
        description="CalSim View — interactive visualisation for CalSim 3 results",
    )
    parser.add_argument(
        "--network-dir",
        type=Path,
        default=Path("data/network"),
        help="Directory containing catalog.json + network.geojson (default: ./data/network/)",
    )
    parser.add_argument(
        "--study",
        dest="studies",
        action="append",
        type=Path,
        default=[],
        metavar="STUDY_DIR",
        help="Study root directory (repeat for multiple studies)",
    )
    parser.add_argument(
        "--default-study",
        default=None,
        help="Name of the study to activate by default",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Bind host (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Bind port (default: 8000)",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable uvicorn auto-reload (development only)",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable debug logging",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s — %(message)s",
        stream=sys.stdout,
    )

    # Validate network dir
    catalog_path = args.network_dir / "catalog.json"
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

    app = create_app(
        network_dir=args.network_dir,
        study_paths=args.studies,
        default_study=args.default_study,
    )

    print(
        f"Starting CalSim View on http://{args.host}:{args.port}\n"
        f"  Network : {args.network_dir}\n"
        f"  Studies : {[str(s) for s in args.studies] or '(none)'}\n"
        f"  API docs: http://{args.host}:{args.port}/docs"
    )

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
