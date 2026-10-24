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
CATALOGUE_OUTPUT = ROOT / "src" / "data" / "policy-catalogue.json"
BASELINE_PATH = ROOT / "policy-baseline.md"
INITIAL_ROUND_PATH = ROOT / "src" / "data" / "initial-round.json"
PENDING_VOTE_PATH = ROOT / "pending-vote" / "index.html"
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


def classify_source_type(label: str, url: str | None) -> str:
    low_label = label.lower()
    low_url = (url or "").lower()
    if "no specific pre-existing fusion policy" in low_label:
        return "none-identified"
    if "unpublished migration policy" in low_label or "docs.google.com" in low_url:
        return "unpublished-draft"
    if "submission" in low_label or "submission" in low_url or "assets.nationbuilder.com" in low_url:
        return "submission"
    if "vic.fusionparty.org.au" in low_url or "fusion victoria" in low_label:
        return "state-branch-policy"
    if "policy_faq" in low_url or "policy faq" in low_label:
        return "policy-faq"
    if "fusionparty.org.au/" in low_url:
        return "approved-policy-page-fragment" if "#:~:text=" in low_url else "approved-policy-page-general"
    return "unverified"


def classify_provenance(
    policy_id: str,
    flagged_new: bool,
    lineage_text: str,
    lineage_items: list[dict[str, str | None]],
) -> dict[str, object]:
    source_types = [classify_source_type(str(item.get("label") or ""), item.get("url")) for item in lineage_items]
    has_approved_page = any(st in {"approved-policy-page-fragment", "approved-policy-page-general"} for st in source_types)
    has_only_submissions_or_faq = bool(source_types) and not has_approved_page and all(
        st in {"submission", "policy-faq", "state-branch-policy"} for st in source_types
    )

    if not lineage_text:
        if flagged_new:
            return {
                "category": "new-proposal",
                "priorHeuristicCategory": "new-proposal",
                "label": "Flagged 'New' in static export · Lineage unverified",
                "summary": "Badged 'New — pending AGM vote' in the Reclaim static export (/pending-vote/), but outside the 36-policy AGM Round 1 lineage dataset.",
                "evidenceBasis": "static-export-new-badge-only",
                "sourceTypes": ["unverified"],
                "flaggedNewInStaticExport": True,
                "lineageVerified": False,
                "materialEquivalenceVerified": False,
                "uncertaintyNote": "No clause-by-clause audit against prior approved Fusion policy pages has been recorded in the repository for this domain.",
            }
        return {
            "category": "unverified",
            "priorHeuristicCategory": "unverified",
            "label": "Mapping unverified",
            "summary": "Not badged 'New' in the static export, but no provenance mapping to prior approved Fusion policy wording has been recorded in the repository.",
            "evidenceBasis": "none",
            "sourceTypes": ["unverified"],
            "flaggedNewInStaticExport": False,
            "lineageVerified": False,
            "materialEquivalenceVerified": False,
            "uncertaintyNote": "Absence of a 'New' badge in the static export is not treated as evidence of prior approval or material equivalence.",
        }

    low = lineage_text.lower()
    if "no specific pre-existing fusion policy" in low:
        return {
            "category": "new-proposal",
            "priorHeuristicCategory": "new-proposal",
            "label": "New proposal · No prior policy identified",
            "summary": "Explicitly recorded in the AGM Round 1 lineage notes as having no pre-existing approved Fusion policy, submission, or statement.",
            "evidenceBasis": "round1-lineage-note",
            "sourceTypes": ["none-identified"],
            "flaggedNewInStaticExport": flagged_new,
            "lineageVerified": True,
            "materialEquivalenceVerified": False,
            "uncertaintyNote": "Requires formal member review and vote as a new party policy proposal.",
        }

    if "unpublished migration policy" in low:
        extra_uncertainty = (
            " This policy primarily concerns family law, online safety, and domestic/sexual violence responses; only the visa-cancellation aspect relates to migration, leaving non-migration clauses without a verified approved-policy predecessor."
            if policy_id == "POL-048"
            else ""
        )
        return {
            "category": "draft-derived",
            "priorHeuristicCategory": "draft-derived",
            "label": "Derived from unpublished draft · Unapproved",
            "summary": "Cites an external Google Doc ('Unpublished Migration Policy - Accepted cica March 2026') rather than published party policy.",
            "evidenceBasis": "round1-lineage-note",
            "sourceTypes": source_types or ["unpublished-draft"],
            "flaggedNewInStaticExport": flagged_new,
            "lineageVerified": False if policy_id == "POL-048" else True,
            "materialEquivalenceVerified": False,
            "uncertaintyNote": f"The cited Google Doc is an external unpublished draft, not published party policy.{extra_uncertainty}",
        }

    explicit_divergence = (
        flagged_new
        or "new design" in low
        or "remain new" in low
        or "pathway is new" in low
        or "mechanism is new" in low
        or "distinct mechanism" in low
        or "distinct electoral mechanism" in low
        or "different mechanism" in low
        or "reward payments are additional" in low
        or "expands the commission" in low
        or "machine-readable databases extend" in low
        or "earlier proposal retained" in low
        or "broader antecedent" in low
        or "state-level predecessor" in low
        or "further specifies the mechanism" in low
    )

    prior_heuristic = (
        "materially-revised"
        if (explicit_divergence and "further specifies the mechanism" not in low)
        else ("existing-repackaged" if "direct predecessor" in low else "unverified")
    )

    if explicit_divergence or has_only_submissions_or_faq:
        reason = (
            "Cites only parliamentary inquiry submissions or general FAQ entries rather than formally approved national policy chapters, or explicitly introduces new/expanded mechanisms."
            if has_only_submissions_or_faq
            else "Adapts or expands prior Fusion policy, submissions, or state-level positions with new or materially revised mechanisms."
        )
        return {
            "category": "materially-revised",
            "priorHeuristicCategory": prior_heuristic,
            "label": "Materially revised or submission/FAQ-derived",
            "summary": reason,
            "evidenceBasis": "round1-lineage-note",
            "sourceTypes": source_types,
            "flaggedNewInStaticExport": flagged_new,
            "lineageVerified": True,
            "materialEquivalenceVerified": False,
            "uncertaintyNote": "Cited antecedents do not establish approval of the new or expanded mechanism wording; requires AGM member review and ballot approval.",
        }

    if "direct predecessor" in low and has_approved_page:
        has_fragment = "approved-policy-page-fragment" in source_types
        return {
            "category": "existing-repackaged",
            "priorHeuristicCategory": "existing-repackaged",
            "label": "Approved policy predecessor · Equivalence unverified",
            "summary": "Cites a direct predecessor on a published Fusion policy page, restructured into Reclaim's 4-tier format; material equivalence of the detailed mechanism wording remains unverified.",
            "evidenceBasis": "round1-lineage-note",
            "sourceTypes": source_types,
            "flaggedNewInStaticExport": flagged_new,
            "lineageVerified": True,
            "materialEquivalenceVerified": False,
            "uncertaintyNote": (
                "Includes a text-fragment link to prior published policy wording, but Reclaim adds structured Tier 2–4 operational detail that has not been verified as purely editorial."
                if has_fragment
                else "Links only to a top-level published policy page URL without a clause-level text comparison; Reclaim specifies concrete federal mechanisms that require member review and vote."
            ),
        }

    return {
        "category": "unverified",
        "priorHeuristicCategory": prior_heuristic,
        "label": "Mapping unverified",
        "summary": "Provenance relationship to prior approved policy requires member verification.",
        "evidenceBasis": "round1-lineage-note",
        "sourceTypes": source_types or ["unverified"],
        "flaggedNewInStaticExport": flagged_new,
        "lineageVerified": False,
        "materialEquivalenceVerified": False,
        "uncertaintyNote": "Lineage note does not establish a verified link to approved national party policy.",
    }


def parse_baseline_policies(baseline_text: str) -> list[dict[str, object]]:
    lines = baseline_text.splitlines()
    current_cat = ""
    current_dom = ""
    current_dom_desc = ""
    parsed: list[dict[str, object]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("# RECLAIM "):
            current_cat = line[2:].strip()
        elif line.startswith("## ") and current_cat:
            current_dom = line[3:].strip()
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j < len(lines) and not lines[j].startswith("#"):
                current_dom_desc = lines[j].strip()
        elif line.startswith("### **") and line.endswith("**"):
            title = line[6:-2].strip()
            j = i + 1
            block: list[str] = []
            while j < len(lines) and not re.match(r"^#{1,3}\s", lines[j]):
                block.append(lines[j])
                j += 1
            raw_block = "\n".join(block).strip()
            before_details = raw_block.split("<details>", 1)[0]
            m_stmt = re.search(r"^1\.\s+(.*)", before_details, re.M)
            statement = m_stmt.group(1).strip() if m_stmt else ""
            outcomes = [m.group(1).strip() for m in re.finditer(r"^\s+\d+\.\s+(.*)", before_details, re.M)]
            det_match = re.search(r"<summary><strong>Further Detail</strong></summary>(.*?)</details>", raw_block, re.S)
            details = det_match.group(1).strip() if det_match else ""
            details = re.sub(r"^\s*---\s*", "", details)
            details = re.sub(r"\s*---\s*$", "", details)
            parsed.append({
                "division": current_cat,
                "domain": current_dom,
                "domainSummary": current_dom_desc,
                "title": title,
                "statement": statement,
                "outcomes": outcomes,
                "details": details.strip(),
            })
            i = j - 1
        i += 1
    return parsed


def parse_markdown_bullets(section_text: str) -> list[dict[str, str | None]]:
    items: list[dict[str, str | None]] = []
    for line in section_text.splitlines():
        cleaned = line.strip()
        if not cleaned.startswith("- "):
            continue
        content = cleaned[2:].strip()
        link_match = re.match(r"^\[([^\]]+)\]\(([^)]+)\)\s*(?:—\s*(.*))?$", content)
        if link_match:
            label, url, note = link_match.groups()
            items.append({
                "label": label.strip(),
                "url": url.strip() if safe_url(url.strip()) else None,
                "description": (note or "").strip(),
            })
        else:
            items.append({
                "label": content,
                "url": None,
                "description": "",
            })
    return items


def build_catalogue(
    records: list[dict[str, str]],
    search_index: list[dict[str, str]],
) -> list[dict[str, object]]:
    baseline_items = parse_baseline_policies(BASELINE_PATH.read_text(encoding="utf-8"))
    if len(baseline_items) != len(search_index):
        raise ValueError(f"Baseline count {len(baseline_items)} != search_index count {len(search_index)}")

    initial_round = json.loads(INITIAL_ROUND_PATH.read_text(encoding="utf-8"))
    round_by_id = {p["id"]: p for p in initial_round["policies"]}
    pending_html = PENDING_VOTE_PATH.read_text(encoding="utf-8")
    pending_urls = set(re.findall(r'href="(/reclaim-[^"#]+#[^"]+)"', pending_html))

    section_html_by_route_anchor: dict[tuple[str, str], str] = {}
    for page_record in records:
        for anchor, content in re.findall(r'<section id="([^"]+)">(.*?)</section>', page_record["bodyHtml"], re.S):
            parts = content.split("<strong>Further Detail</strong>", 1)
            detail_html = parts[1].strip() if len(parts) == 2 else content.strip()
            detail_html = re.sub(r"^\s*<hr>\s*", "", detail_html)
            detail_html = re.sub(r"\s*<hr>\s*$", "", detail_html)
            section_html_by_route_anchor[(page_record["slug"], anchor)] = detail_html.strip()

    catalogue: list[dict[str, object]] = []
    for idx, (entry, base) in enumerate(zip(search_index, baseline_items), 1):
        policy_id = f"POL-{idx:03d}"
        if entry["title"] != base["title"]:
            raise ValueError(f"Policy title mismatch at {policy_id}: {entry['title']} vs {base['title']}")
        domain_slug, anchor = entry["url"].split("#", 1)
        detail_html = section_html_by_route_anchor.get((domain_slug, anchor), "")
        if not detail_html:
            raise ValueError(f"Missing detailHtml for {policy_id} at {entry['url']}")

        flagged_new = entry["url"] in pending_urls
        round_policy = round_by_id.get(policy_id)
        lineage_text = ""
        values_text = ""
        if round_policy:
            details_with_lineage = str(round_policy.get("details", ""))
            if "**Policy Lineage**" in details_with_lineage:
                after_lineage = details_with_lineage.split("**Policy Lineage**", 1)[1]
                if "**Values Alignment**" in after_lineage:
                    lineage_text, values_text = after_lineage.split("**Values Alignment**", 1)
                else:
                    lineage_text = after_lineage

        lineage_items = parse_markdown_bullets(lineage_text.strip())
        prov_meta = classify_provenance(policy_id, flagged_new, lineage_text.strip(), lineage_items)
        values_items = [
            line.strip()[2:].strip()
            for line in values_text.strip().splitlines()
            if line.strip().startswith("- ")
        ]

        full_details = str(base["details"])
        if lineage_text.strip():
            full_details = f"{full_details}\n\n**Policy Lineage**\n\n{lineage_text.strip()}"
        if values_text.strip():
            full_details = f"{full_details}\n\n**Values Alignment**\n\n{values_text.strip()}"

        catalogue.append({
            "policyId": policy_id,
            "version": f"reclaim-v1:{policy_id}",
            "title": entry["title"],
            "division": base["division"],
            "domain": entry["domain"],
            "domainSummary": base["domainSummary"],
            "domainSlug": domain_slug,
            "anchor": anchor,
            "url": entry["url"],
            "statement": base["statement"],
            "outcomes": base["outcomes"],
            "details": full_details,
            "detailHtml": detail_html,
            "provenance": {
                **prov_meta,
                "lineage": lineage_items,
                "valuesAlignment": values_items,
            },
            "initialAgmRound": {
                "included": round_policy is not None,
                "roundId": initial_round["id"] if round_policy is not None else None,
                "ballotId": round_policy["ballot"]["id"] if round_policy is not None else None,
            },
        })
    return catalogue


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
    catalogue = build_catalogue(records, search_index)
    CATALOGUE_OUTPUT.write_text(json.dumps(catalogue, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Migrated {len(records)} policy routes into {OUTPUT.relative_to(ROOT)}")
    print(f"Migrated {len(search_index)} proposal search entries into {SEARCH_INDEX_OUTPUT.relative_to(ROOT)}")
    print(f"Built {len(catalogue)} structured policy catalogue records into {CATALOGUE_OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
