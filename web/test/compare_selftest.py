"""Check the web self-test's output against lxml (libxml2/libxslt with full DTD support).

Usage:
    node web/serve.mjs   (in another terminal)
    msedge --headless=new --virtual-time-budget=120000 --dump-dom http://localhost:8080/test/selftest.html > selftest-dump.html
    python web/test/compare_selftest.py selftest-dump.html
"""
import html
import json
import re
import sys
from pathlib import Path

from lxml import etree

REPO = Path(__file__).resolve().parents[2]
CONFIG = REPO / "resources" / "configuration"
PAWS = {
    "/resources/configuration/Data/PAWSStarterKitMaster.paw": CONFIG / "Data" / "PAWSStarterKitMaster.paw",
    "/testdata/TestData.paw": REPO / "test" / "org" / "sil" / "paws" / "testdata" / "TestData.paw",
}


def main(dump_path):
    dump = Path(dump_path).read_text(encoding="utf-8")
    raw = re.search(r'<pre id="out">(.*?)</pre>', dump, re.S).group(1)
    result = json.loads(html.unescape(raw))
    failures = list(result["errors"])

    parser = etree.XMLParser(load_dtd=True, attribute_defaults=True, resolve_entities=True, no_network=True)
    for name, web in result["pages"].items():
        path = CONFIG / "XmlPageDescriptions" / name
        text = path.read_bytes()
        # Some (French) pages use Windows separators in the DOCTYPE system id; browsers and
        # Java on Windows resolve them, libxml2 silently skips the DTD.
        text = re.sub(rb'(<!DOCTYPE[^>\["]*")([^"]*)"', lambda m: m.group(1) + m.group(2).replace(b"\\", b"/") + b'"', text, count=1)
        root = etree.fromstring(text, parser, base_url=path.as_uri())
        elements = list(root.iter(tag=etree.Element))
        expected = {
            "elements": len(elements),
            "attributes": sum(len(e.attrib) for e in elements),
            "textLength": len(root.xpath("string(.)")),
        }
        for key, value in expected.items():
            if web[key] != value:
                failures.append(f"{name}: {key} web={web[key]} lxml={value}")

    grammar_xslt = etree.XSLT(etree.parse(str(CONFIG / "Transforms" / "PAWSSKMasterGrammarMapper.xsl")))
    for key, path in PAWS.items():
        expected = str(grammar_xslt(etree.parse(str(path))))
        web = result["grammars"].get(key)
        if web != expected:
            failures.insert(0, f"grammar for {path.name} differs (web {len(web or '')} chars, lxml {len(expected)} chars)")
            out = Path(dump_path).with_name(path.stem + ".grm")
            out.with_suffix(".web.grm").write_text(web or "", encoding="utf-8", newline="")
            out.with_suffix(".lxml.grm").write_text(expected, encoding="utf-8", newline="")
        else:
            print(f"grammar for {path.name}: identical ({len(expected.splitlines())} lines)")

    print(f"{len(result['pages'])} page descriptions checked")
    if failures:
        print(f"{len(failures)} problem(s):")
        for f in failures[:40]:
            print("  " + f)
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
