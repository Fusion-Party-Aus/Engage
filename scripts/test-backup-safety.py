#!/usr/bin/env python3
"""Exercise backup/restore safety guards without contacting MongoDB."""

import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class BackupSafetyTests(unittest.TestCase):
    def test_scripts_parse_as_bash(self):
        for name in ("backup-preview.sh", "restore-preview.sh"):
            subprocess.run(["bash", "-n", str(ROOT / "scripts" / name)], check=True)

    def test_backup_refuses_non_preview_mode(self):
        env = {**os.environ, "APP_MODE": "production"}
        result = subprocess.run([str(ROOT / "scripts" / "backup-preview.sh")], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("Refusing backup", result.stderr)

    def test_restore_refuses_same_source_and_target_database(self):
        env = {
            **os.environ,
            "APP_MODE": "preview",
            "MONGODB_URI": "mongodb://unreachable.invalid",
            "MONGODB_DB_NAME": "preview",
            "MONGODB_TARGET_DB_NAME": "preview",
        }
        result = subprocess.run(
            [str(ROOT / "scripts" / "restore-preview.sh"), "/tmp/unused-archive"],
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("separate database", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
