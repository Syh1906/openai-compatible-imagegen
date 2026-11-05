from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from image_provider_requests import request_image
from image_request_options import resolve_request_options
from model_profiles import validate_model_profiles
from tests.support.python_fixtures import make_png


class Image26RequestTests(unittest.TestCase):
    def test_image26_profile_declares_auto_size_complexity_and_markup(self):
        for model in ('gpt-image-2.6-sunburst', 'gpt-image-2.6-flare'):
            validate_model_profiles({
                'config_version': 2, 'active_profile': 'image26',
                'providers': {'openai': {'protocol': 'openai-compatible', 'base_url': 'https://api.openai.com/v1'}},
                'models': {'image26': {
                    'provider': 'openai', 'model': model, 'defaults': {'size': 'auto'},
                    'capabilities': {'generate': True, 'edit': True, 'markup': True},
                    'parameters': {'complexity': 'medium'},
                    'parameter_fields': {'complexity': {'title': '复杂度', 'type': 'string', 'path': ['complexity'], 'enum': ['low', 'medium', 'high']}},
                }},
            })

    def cfg(self, parameters=None):
        return SimpleNamespace(protocol='openai-compatible', model='gpt-image-2.6-flare', parameters=parameters or {}, endpoints={}, base_url='https://example.invalid/v1', api_key='', user_agent='test', proxy={}, defaults={}, limits={}, config_version=2)

    def test_gif_svg_and_auto_size_are_preserved(self):
        for fmt in ('gif', 'svg'):
            options = resolve_request_options(self.cfg(), {'format':fmt, 'size':'auto'})
            self.assertEqual((options['format'], options['size']), (fmt, 'auto'))
        with patch('image_transport.request_json', return_value={'data':[]}) as send:
            request_image(self.cfg({'frame_count':9, 'frame_duration_ms':200, 'complexity':'medium'}), 'generate', {'prompt':'loop', 'output_format':'gif', 'n':1}, 30)
            self.assertEqual(send.call_args.kwargs['payload']['frame_count'], 9)

    def test_invalid_generation_combinations_never_send(self):
        for fmt, parameters, count in [('gif', {'frame_count':65},1), ('gif', {'frame_duration_ms':10},1), ('png', {'frame_count':9},1), ('svg', {},2), ('gif', {'partial_images':1},1), ('svg', {'prompt_rewriter':True},1)]:
            with self.subTest(fmt=fmt,parameters=parameters), patch('image_transport.request_json') as send:
                with self.assertRaises(ValueError):
                    request_image(self.cfg(parameters),'generate',{'prompt':'x','output_format':fmt,'n':count},30)
                send.assert_not_called()
        with patch('image_transport.request_json') as send, self.assertRaises(ValueError):
            request_image(self.cfg(), 'generate', {'prompt':'loop', 'output_format':'gif', 'size':'513x512'}, 30)
        send.assert_not_called()

    def test_edit_cannot_return_gif_or_svg(self):
        for fmt in ('gif','svg'):
            with patch('image_transport.request_multipart') as send:
                with self.assertRaises(ValueError):
                    request_image(self.cfg(),'edit',{'prompt':'x','output_format':fmt},30,files=[('image',Path('not-read.png'),b'')])
                send.assert_not_called()

    def test_markup_is_a_separate_transparent_upload(self):
        files = [('image[]', Path('parent.png'), make_png(2, 2)), ('markup', Path('markup.png'), make_png(2, 2, 0))]
        with patch('image_transport.request_multipart', return_value={}) as send:
            request_image(self.cfg(), 'edit', {'prompt':'edit'}, 30, files=files)
            self.assertEqual(send.call_args.kwargs['files'], files)
        for invalid in (
            files + [('mask', Path('mask.png'), make_png(2, 2))],
            [files[0], ('markup', Path('markup.png'), make_png(1, 1, 0))],
            [files[0], ('markup', Path('markup.png'), make_png(2, 2))],
        ):
            with patch('image_transport.request_multipart') as send, self.assertRaises(ValueError):
                request_image(self.cfg(), 'edit', {'prompt':'edit'}, 30, files=invalid)
            send.assert_not_called()
