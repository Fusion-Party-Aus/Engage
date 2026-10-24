#!/usr/bin/env python3
"""Convert the trusted Reclaim static export into route-preserving content JSON.

The static export remains the source material. This script extracts the page
title, description, and semantic main content while dropping the old site
chrome and styling classes. Only an explicit HTML allowlist and safe URL
schemes are retained.
"""

from __future__ import annotations

import html
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "src" / "data" / "policies.json"
SEARCH_INDEX_OUTPUT = ROOT / "src" / "data" / "policy-index.json"
ALLOWED_TAGS = {
    "a", "blockquote", "br", "em", "h1", "h2", "h3", "h4", "h5",
    "h6", "hr", "img", "li", "ol", "p", "section", "strong", "table", "tbody",
    "td", "th", "thead", "tr", "ul",
}
VOID_TAGS = {"br", "hr", "img"}
SKIP_TAGS = {"script", "style", "svg", "template", "noscript"}


class ExportPageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title_parts: list[str] = []
        self.description = ""
        self.in_title = False
        self.main_depth = 0
        self.skip_depth = 0
        self.body: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag == "meta" and values.get("name", "").lower() == "description":
            self.description = (values.get("content") or "").strip()
        if tag == "main":
            self.main_depth += 1
        if not self.main_depth:
            return
        if tag in SKIP_TAGS:
            self.skip_depth += 1
            return
        if self.skip_depth or tag not in ALLOWED_TAGS:
            return
        attributes: list[str] = []
        if tag == "a":
            href = values.get("href") or ""
            if safe_url(href):
                attributes.append(f'href="{html.escape(href, quote=True)}"')
                if urlparse(href).scheme == "https":
                    attributes.append('rel="noreferrer noopener"')
        elif tag in {"section", "h1", "h2", "h3", "h4", "h5", "h6"}:
            anchor = values.get("id") or ""
            if re.fullmatch(r"[a-z0-9][a-z0-9-]*", anchor):
                attributes.append(f'id="{anchor}"')
        elif tag == "img":
            src = values.get("src") or ""
            if not safe_url(src):
                return
            attributes.append(f'src="{html.escape(src, quote=True)}"')
            attributes.append(f'alt="{html.escape(values.get("alt") or "", quote=True)}"')
            if values.get("width", "").isdigit():
                attributes.append(f'width="{values["width"]}"')
            if values.get("height", "").isdigit():
                attributes.append(f'height="{values["height"]}"')
        elif tag in {"td", "th"}:
            for key in ("colspan", "rowspan"):
                if (values.get(key) or "").isdigit():
                    attributes.append(f'{key}="{values[key]}"')
        attr_text = (" " + " ".join(attributes)) if attributes else ""
        self.body.append(f"<{tag}{attr_text}>")

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.in_title = False
        if self.main_depth and tag == "main":
            self.main_depth -= 1
            return
        if not self.main_depth:
            return
        if tag in SKIP_TAGS and self.skip_depth:
            self.skip_depth -= 1
            return
        if self.skip_depth or tag not in ALLOWED_TAGS or tag in VOID_TAGS:
            return
        self.body.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)
        if self.main_depth and not self.skip_depth:
            self.body.append(html.escape(data, quote=False))


def safe_url(value: str) -> bool:
    if value.startswith(("/", "#")):
        return not value.startswith("//")
    return urlparse(value).scheme in {"https", "mailto"}


def route_for(page: Path) -> str:
    relative = page.parent.relative_to(ROOT)
    return "/" if str(relative) == "." else f"/{relative.as_posix()}/"


def extract(page: Path) -> dict[str, str]:
    parser = ExportPageParser()
    parser.feed(page.read_text(encoding="utf-8"))
    parser.close()
    title = re.sub(r"\s+", " ", "".join(parser.title_parts)).strip()
    body = re.sub(r"\s+", " ", "".join(parser.body)).strip()
    if not title:
        raise ValueError(f"Missing title in {page.relative_to(ROOT)}")
    if not body:
        raise ValueError(f"Missing main content in {page.relative_to(ROOT)}")
    route = route_for(page)
    area = "RECLAIM OUR ECONOMY" if route.startswith("/reclaim-our-economy/") else "RECLAIM OUR FUTURE"
    return {
        "slug": route,
        "title": title.split(" · ", 1)[0],
        "area": area,
        "summary": parser.description,
        "bodyHtml": body,
        "metaTitle": title,
        "description": parser.description,
    }


def main() -> None:
    pages = sorted(
        page
        for page in ROOT.glob("reclaim-*/**/index.html")
        if page.parent.name not in {"reclaim-our-economy", "reclaim-our-future"}
    )
    records = [extract(page) for page in pages]
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    index_source = (ROOT / "index.html").read_text(encoding="utf-8")
    match = re.search(r'<script\b[^>]*\bid="policy-search-index"[^>]*>(.*?)</script>', index_source, re.S)
    if not match:
        raise ValueError("Missing policy-search-index in static export index.html")
    search_index = json.loads(match.group(1))
    if not isinstance(search_index, list) or not search_index:
        raise ValueError("The static policy search index is empty or invalid")
    SEARCH_INDEX_OUTPUT.write_text(json.dumps(search_index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Migrated {len(records)} policy routes into {OUTPUT.relative_to(ROOT)}")
    print(f"Migrated {len(search_index)} proposal search entries into {SEARCH_INDEX_OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
