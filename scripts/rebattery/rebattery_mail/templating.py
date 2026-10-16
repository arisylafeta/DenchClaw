"""Deterministic rendering shared by drafts, campaigns and template reads."""
import html
import re

from .core import Refused

VARIABLE = re.compile(r"(?<!\{)\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}(?!\})")
POSTMARK = re.compile(r"\{\{\{\s*pm:[^{}]+\}\}\}")


def render_template(template: str, variables: dict, html_mode: bool = False) -> str:
    def replace(match):
        name = match.group(1)
        if name not in variables or variables[name] is None:
            raise Refused("missing_variable", variable=name)
        value = str(variables[name])
        return html.escape(value, quote=True) if html_mode else value
    rendered = VARIABLE.sub(replace, template or "")
    unchecked = POSTMARK.sub("", rendered)
    if "{{" in unchecked or "}}" in unchecked:
        raise Refused("unresolved_merge_token")
    return rendered


def render_message(row, variables) -> dict:
    for name in row.get("required_variables", []):
        if name not in variables or variables[name] is None or not str(variables[name]).strip():
            raise Refused("missing_variable", variable=name)
    return {"subject": render_template(row.get("subject", ""), variables),
            "html": render_template(row.get("html", row.get("body_html", "")), variables, True),
            "text": render_template(row.get("text_body", row.get("text", row.get("body_text", ""))), variables)}
