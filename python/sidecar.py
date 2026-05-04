"""JSON-RPC sidecar for serigraphica.

Reads newline-delimited JSON requests on stdin, writes responses on stdout.
Logs go to stderr.

Request:  {"id": int, "method": str, "params": dict}
Response: {"id": int, "result": any} | {"id": int, "error": str}
"""

from __future__ import annotations

import json
import sys
import traceback

import cv2

from transform import export_corrected


def _image_meta(params: dict) -> dict:
    path = params["path"]
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"failed to read image: {path}")
    h, w = img.shape[:2]
    return {"width": int(w), "height": int(h)}


def _export_corrected(params: dict) -> dict:
    return export_corrected(
        params["path"],
        params["corners"],
        params["output_path"],
        int(params.get("quality", 92)),
    )


HANDLERS = {
    "image_meta": _image_meta,
    "export_corrected": _export_corrected,
}


def main() -> int:
    sys.stderr.write("[sidecar] ready\n")
    sys.stderr.flush()
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            sys.stderr.write(f"[sidecar] bad json: {e}\n")
            continue
        rid = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}
        handler = HANDLERS.get(method)
        if handler is None:
            sys.stdout.write(json.dumps({"id": rid, "error": f"unknown method: {method}"}) + "\n")
            sys.stdout.flush()
            continue
        try:
            result = handler(params)
            sys.stdout.write(json.dumps({"id": rid, "result": result}) + "\n")
        except Exception as e:
            sys.stderr.write(f"[sidecar] error in {method}: {e}\n{traceback.format_exc()}")
            sys.stdout.write(json.dumps({"id": rid, "error": str(e)}) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
