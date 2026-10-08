import os
from pathlib import Path
import pytest


@pytest.fixture
def installed_liberation():
    selected = os.environ.get('MATERIALS_TEST_FONT_DIR')
    if not selected:
        pytest.skip('Set MATERIALS_TEST_FONT_DIR to the explicitly installed reviewed Liberation Sans distribution to run fallback checks')
    return Path(selected).resolve()

# Capture exactly the known warning at its third-party import boundary.
# All other warnings retain pytest's normal handling.
import warnings
with warnings.catch_warnings(record=True) as reportlab_warnings:
    warnings.simplefilter('always', DeprecationWarning)
    import reportlab.lib.rl_safe_eval
assert len(reportlab_warnings) == 1
assert reportlab_warnings[0].category is DeprecationWarning
assert str(reportlab_warnings[0].message) == 'ast.NameConstant is deprecated and will be removed in Python 3.14; use ast.Constant instead'
assert reportlab_warnings[0].filename.endswith('/reportlab/lib/rl_safe_eval.py')
