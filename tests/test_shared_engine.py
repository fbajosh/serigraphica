"""Exercise the engine used by both the desktop sidecar and the web package."""
from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/editor/engine"))
from transform import export_dewarped


class SharedEngineTest(unittest.TestCase):
    def test_single_rectangle_exports_real_jpg_and_png_and_sidecar_finds_shared_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = np.full((120, 160, 3), 225, np.uint8)
            image[35:85, 45:115] = (45, 90, 135)
            source = root / "input.png"
            self.assertTrue(cv2.imwrite(str(source), image))
            path = {"cornerIndices": [0, 1, 2, 3], "nodes": [
                {"point": [x, y], "handle": [0, 0], "corner": True}
                for x, y in [(10, 10), (150, 10), (150, 110), (10, 110)]
            ]}
            for extension, magic in (("jpg", b"\xff\xd8"), ("png", b"\x89PNG\r\n\x1a\n")):
                output = root / f"output.{extension}"
                result = export_dewarped(str(source), [path], str(output))
                self.assertTrue(output.read_bytes().startswith(magic))
                self.assertEqual((result["outputWidth"], result["outputHeight"]), (140, 100))
            request = {"id": 1, "method": "detect_guides", "params": {"path": str(source)}}
            result = subprocess.run([sys.executable, str(ROOT / "python/sidecar.py")],
                                    input=json.dumps(request) + "\n", text=True, capture_output=True, check=True)
            response = json.loads(result.stdout.strip())
            self.assertNotIn("error", response)
            self.assertEqual(response["result"]["imageWidth"], 160)


if __name__ == "__main__":
    unittest.main()
