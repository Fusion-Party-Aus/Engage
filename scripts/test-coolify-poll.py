"""Isolated poller regression checks; no network or deployments."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('coolify-poll-deploy.sh').resolve()


class PollerTests(unittest.TestCase):
    def run_case(self, health='0', production='finished', built=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / 'state'
            state.mkdir()
            if built:
                (state / 'staging.sha').write_text('new\n')
            config = root / 'config'
            config.write_text(f'COOLIFY_URL=http://mock\nCOOLIFY_TOKEN=test\n'
                              f'STAGING_APP_UUID=staging\nPROD_APP_UUID=production\n'
                              f'REPO_URL=mock\nBRANCH=main\nSTATE_DIR={state}\n')
            mocks = {
                'git': 'echo "new refs/heads/main"',
                'flock': 'exit 0',
                'sleep': 'exit 0',
                'ssh': f'echo "$*" >> "$MOCK_ROOT/ssh"; exit {health}',
                'curl': '''case "$*" in
  *'/api/v1/deploy '*) echo "$*" >> "$MOCK_ROOT/posts"; echo '{"deployment_uuid":"deployment"}';;
  *) echo "{\\\"status\\\":\\\"$MOCK_STATUS\\\"}";;
esac''',
            }
            for name, content in mocks.items():
                path = root / name
                path.write_text('#!/bin/sh\n' + content + '\n')
                path.chmod(0o755)
            env = dict(os.environ, PATH=f'{root}:' + os.environ['PATH'],
                       ENGAGE_COOLIFY_POLL_CONFIG=str(config), MOCK_ROOT=str(root),
                       MOCK_STATUS=production)
            first = subprocess.run(['bash', str(SCRIPT)], env=env, capture_output=True)
            posts = (root / 'posts').read_text() if (root / 'posts').exists() else ''
            second = subprocess.run(['bash', str(SCRIPT)], env=env, capture_output=True)
            self.assertEqual(posts, (root / 'posts').read_text() if (root / 'posts').exists() else '')
            self.assertEqual(second.returncode, 0)
            recorded = (state / 'production.sha').exists()
            ssh = (root / 'ssh').read_text() if (root / 'ssh').exists() else ''
            return first.returncode, posts, recorded, ssh

    def test_success_reuses_staging_and_confirms_production(self):
        code, posts, recorded, ssh = self.run_case(built=True)
        self.assertEqual(code, 0)
        self.assertEqual(posts.count('/api/v1/deploy '), 1)
        self.assertTrue(recorded)
        self.assertIn('StrictHostKeyChecking=yes', ssh)
        self.assertIn('http://127.0.0.1:4400/api/health', ssh)

    def test_health_failure_does_not_promote_or_redeploy(self):
        code, posts, recorded, _ = self.run_case(health='1')
        self.assertNotEqual(code, 0)
        self.assertEqual(posts.count('/api/v1/deploy '), 1)
        self.assertFalse(recorded)

    def test_failed_production_is_not_recorded(self):
        code, _, recorded, _ = self.run_case(production='failed', built=True)
        self.assertNotEqual(code, 0)
        self.assertFalse(recorded)


if __name__ == '__main__':
    unittest.main()
