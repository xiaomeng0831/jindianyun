"""The files copied in server/README.md must be enough to import the app."""

import ast
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def deploy_names() -> list[str]:
    text = (ROOT / "DEPLOY_FILES").read_text(encoding="utf-8")
    return [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]


def local_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module.split(".")[0])
    return {name for name in found if (ROOT / f"{name}.py").exists()}


def test_deploy_manifest_imports(tmp_path):
    names = deploy_names()
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert names == ["app.py", "facts.py"]
    for name in names:
        assert f"cp server/{name} " in readme
        assert f"`{name}`" in readme
    dest = tmp_path / "chat"
    dest.mkdir()
    key = tmp_path / "key"
    key.write_text("test-key\n", encoding="utf-8")
    for name in names:
        shutil.copy(ROOT / name, dest / name)
    env = os.environ.copy()
    env["PYTHONPATH"] = str(dest)
    env["SILICONFLOW_KEY_FILE"] = str(key)
    subprocess.check_call([sys.executable, "-c", "import app"], cwd=dest, env=env)


def test_every_local_import_is_in_the_manifest():
    names = deploy_names()
    deployed = {Path(name).stem for name in names}
    for name in names:
        if not name.endswith(".py"):
            continue
        missing = local_modules(ROOT / name) - deployed
        assert not missing, f"{name} imports {missing}, which DEPLOY_FILES does not list"
