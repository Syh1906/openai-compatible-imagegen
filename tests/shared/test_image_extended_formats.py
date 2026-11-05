from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from image_response import inspect_response_image


class ExtendedFormatTests(unittest.TestCase):
    def test_gif_original_is_recognized_and_truncation_rejected(self):
        image = bytes.fromhex('47494638396101000100800000000000ffffff2c00000000010001000002024401003b')
        result = inspect_response_image(image)
        self.assertEqual((result.image_format, result.width, result.height), ('gif', 1, 1))
        with self.assertRaises(ValueError):
            inspect_response_image(image[:-1])

    def test_static_svg_and_unsafe_content(self):
        image = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 64"><path d="M0 0L10 10"/></svg>'
        result = inspect_response_image(image)
        self.assertEqual((result.image_format, result.width, result.height), ('svg', 128, 64))
        for content in (b'<script/>', b'<image href="https://example.com/a.png"/>', b'<rect onclick="alert(1)"/>', b'<foreignObject/>', b'<style>rect{fill:url(https://example.com)}</style>'):
            with self.subTest(content=content), self.assertRaises(ValueError):
                inspect_response_image(image.replace(b'<path d="M0 0L10 10"/>', content))

    def test_static_svg_styles_and_local_gradients(self):
        image = b'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="64"><style>.a { fill: url(#paint) }</style><defs><linearGradient id="paint"><stop offset="0" stop-color="red"/></linearGradient></defs><path class="a" style="stroke: #123;stroke-width:2" d="M0 0L10 10"/></svg>'
        self.assertEqual(inspect_response_image(image).image_format, 'svg')

    def test_multiframe_gif_is_preserved_and_each_frame_validated(self):
        frame = bytes.fromhex('2c0000000001000100000202440100')
        image = bytes.fromhex('47494638396101000100800000000000ffffff') + frame * 2 + b';'
        self.assertEqual(inspect_response_image(image).image_format, 'gif')
        with self.assertRaises(ValueError):
            inspect_response_image(image[:-3] + b';')
