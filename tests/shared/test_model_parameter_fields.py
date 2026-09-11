from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from image_parameters import resolve_parameter_defaults, validate_parameter_fields, validate_parameter_values


class ModelParameterFieldTests(unittest.TestCase):
    def test_runtime_values_keep_types_and_bounds_but_allow_new_enum_values(self):
        fields = {"style": {"type": "string", "path": ["style"], "enum": ["old"]}, "seed": {"type": "integer", "path": ["seed"], "minimum": 0}}
        validate_parameter_values(fields, {"style": "future", "seed": 4})
        for values in ({"seed": "four"}, {"seed": -1}, {"style": {}}):
            with self.assertRaises(ValueError):
                validate_parameter_values(fields, values)
    def test_configured_fields_map_defaults_to_protocol_paths(self):
        fields = {"seed": {"title": "随机种子", "type": "integer", "path": ["generationConfig", "seed"], "default": 7}, "style": {"type": "string", "path": ["vendor", "style"], "enum": ["soft", "sharp"], "default": "soft"}}
        validate_parameter_fields(fields)
        result = resolve_parameter_defaults(fields, {"generationConfig": {"seed": 9}})
        self.assertEqual(result, {"generationConfig": {"seed": 9}, "vendor": {"style": "soft"}})

    def test_field_contract_rejects_reserved_paths_and_wrong_default_types(self):
        for field in ({"type": "integer", "path": ["n"]}, {"type": "integer", "path": ["seed"], "default": "seven"}, {"type": "string", "path": []}, {"type": "number", "path": ["x"], "minimum": 10, "maximum": 1}):
            with self.assertRaises(ValueError):
                validate_parameter_fields({"custom": field})


if __name__ == "__main__":
    unittest.main()
