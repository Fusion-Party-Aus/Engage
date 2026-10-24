#!/usr/bin/env python3
"""Regression checks for the static content and initial-round migration."""

import json
import re
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
POLICIES = ROOT / "src" / "data" / "policies.json"
ROUND = ROOT / "src" / "data" / "initial-round.json"
POLICY_INDEX = ROOT / "src" / "data" / "policy-index.json"


class PolicyMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.run([sys.executable, str(ROOT / "scripts" / "migrate-static-export.py")], check=True)
        cls.policies = json.loads(POLICIES.read_text(encoding="utf-8"))
        cls.round = json.loads(ROUND.read_text(encoding="utf-8"))
        cls.search_index = json.loads(POLICY_INDEX.read_text(encoding="utf-8"))

    def test_all_policy_routes_and_metadata_are_preserved(self):
        exported = sorted(
            "/" + path.parent.relative_to(ROOT).as_posix() + "/"
            for path in ROOT.glob("reclaim-*/**/index.html")
            if path.parent.name not in {"reclaim-our-economy", "reclaim-our-future"}
        )
        migrated = sorted(policy["slug"] for policy in self.policies)
        self.assertEqual(migrated, exported)
        self.assertEqual(len(migrated), 10)
        for policy in self.policies:
            self.assertTrue(policy["title"])
            self.assertTrue(policy["summary"])
            self.assertTrue(policy["metaTitle"])
            self.assertTrue(policy["bodyHtml"])
            self.assertIn(policy["area"], {"RECLAIM OUR ECONOMY", "RECLAIM OUR FUTURE"})

    def test_migrated_html_contains_no_unsafe_markup_or_urls(self):
        for policy in self.policies:
            body = policy["bodyHtml"]
            self.assertNotRegex(body, r"(?i)<\s*(script|style|svg|iframe|form)\b")
            self.assertNotRegex(body, r"(?i)\son[a-z]+\s*=")
            for value in re.findall(r'\b(?:href|src)="([^"]*)"', body):
                self.assertFalse(value.lower().startswith(("javascript:", "data:", "//")), value)

    def test_all_proposal_search_links_and_anchors_are_preserved(self):
        self.assertEqual(len(self.search_index), 76)
        by_route = {policy["slug"]: policy for policy in self.policies}
        for entry in self.search_index:
            self.assertTrue(entry["title"])
            self.assertTrue(entry["domain"])
            route, anchor = entry["url"].split("#", 1)
            self.assertIn(route, by_route)
            self.assertIn(f'id="{anchor}"', by_route[route]["bodyHtml"])

    def test_initial_round_has_the_expected_draft_ballots(self):
        self.assertEqual(self.round["status"], "draft")
        self.assertTrue(self.round["previewOnly"])
        self.assertFalse(self.round["bindingBallotsEnabled"])
        self.assertEqual(len(self.round["policies"]), 36)
        self.assertEqual(
            [len(area["policies"]) for area in self.round["areas"]],
            [10, 8, 8, 10],
        )
        self.assertEqual(self.round["openingInclusiveUtc"], "2026-10-25T13:00:00.000Z")
        self.assertEqual(self.round["closingExclusiveUtc"], "2026-11-26T13:00:00.000Z")
        self.assertEqual(self.round["meeting"]["date"], "Wednesday, 2 December 2026")
        self.assertFalse(self.round["rules"]["mandatoryDoNotApproveReason"])
        self.assertIsNone(self.round["rules"]["quorum"])
        self.assertEqual(self.round["rules"]["approval"], "strict-majority-of-votes-cast")
        self.assertEqual(len({p["id"] for p in self.round["policies"]}), 36)
        self.assertTrue(all(p["ballot"]["status"] == "draft" for p in self.round["policies"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
