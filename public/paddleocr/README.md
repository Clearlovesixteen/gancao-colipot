# PaddleOCR assets

This directory is copied into the Chrome extension build output.

Required model files:

- `models/PP-OCRv5_mobile_det.tar`
- `models/PP-OCRv5_mobile_rec.tar`

The archives must be uncompressed tar files compatible with `@paddleocr/paddleocr-js`.
Each archive must contain `inference.onnx` and `inference.yml`; the `model_name`
inside `inference.yml` must match the runtime model name.

The current models are PP-OCRv5 mobile ONNX inference assets from PaddleOCR's
official model storage.
