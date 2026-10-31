"""Run: python3 -m unittest tools/test_bpm_resolve.py   (the same cases as test/bpm.test.mjs)"""
import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from bpm_resolve import resolve_bpm, relation


def V(source, value, confidence=1.0, doubt=None):
    return dict(source=source, value=value, confidence=confidence, **({"doubt": doubt} if doubt else {}))


class Resolver(unittest.TestCase):
    def test_relation(self):
        self.assertEqual(relation(120, 123), "same"); self.assertEqual(relation(86, 172), "double")
        self.assertEqual(relation(172, 86), "half"); self.assertIsNone(relation(120, 150))

    def test_blinding_lights(self):
        r = resolve_bpm([V("preview", 86)], energy=0.9)
        self.assertEqual((r["bpm"], r["feel"], r["detected"], r["flag"]), (172, "double", 86, "check"))
        r = resolve_bpm([V("preview", 86), V("acousticbrainz", 171, 0.6)], energy=0.9)
        self.assertEqual((r["bpm"], r["flag"]), (172, "agree"))

    def test_lose_yourself(self):
        r = resolve_bpm([V("preview", 172)], energy=0.15)
        self.assertEqual((r["bpm"], r["feel"], r["flag"]), (86, "half", "check"))
        self.assertEqual(resolve_bpm([V("preview", 172), V("getsongbpm", 86, 0.5)], energy=0.15)["flag"], "agree")

    def test_override_wins(self):
        r = resolve_bpm([V("preview", 86), V("acousticbrainz", 172), V("override", 90)], energy=0.95)
        self.assertEqual((r["bpm"], r["source"], r["feel"], r["flag"]), (90, "override", "normal", "agree"))

    def test_priority_and_flags(self):
        self.assertEqual(resolve_bpm([V("getsongbpm", 100), V("acousticbrainz", 101), V("preview", 102), V("local", 103)])["source"], "local")
        self.assertEqual(resolve_bpm([V("preview", 128), V("acousticbrainz", 127)])["flag"], "agree")
        self.assertEqual(resolve_bpm([V("preview", 128), V("acousticbrainz", 110)])["flag"], "check")
        self.assertEqual(resolve_bpm([V("preview", 90), V("acousticbrainz", 180)], energy=0.5)["flag"], "check")
        self.assertEqual(resolve_bpm([V("preview", 120, 0.33, "estimators disagree")])["flag"], "check")

    def test_limits(self):
        self.assertEqual(resolve_bpm([V("preview", 120)], energy=0.95)["bpm"], 120)
        self.assertEqual(resolve_bpm([V("preview", 112)], energy=0.9, settings=dict(bpmLow=120))["bpm"], 112)   # 224 > 220
        self.assertIsNone(resolve_bpm([]))
        self.assertIsNone(resolve_bpm([V("preview", 5), V("nope", 100)]))


if __name__ == "__main__":
    unittest.main()
