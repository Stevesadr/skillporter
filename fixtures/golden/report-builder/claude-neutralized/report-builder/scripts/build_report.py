#!/usr/bin/env python3
"""Render a standalone HTML report. Reads a CSV, writes one file, needs no network."""
import argparse
import csv
import html
import pathlib


def read_rows(path: pathlib.Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def render(rows: list[dict[str, str]], title: str) -> str:
    head = "".join(f"<th>{html.escape(name)}</th>" for name in (rows[0] if rows else {}))
    body = "".join(
        "<tr>" + "".join(f"<td>{html.escape(value)}</td>" for value in row.values()) + "</tr>"
        for row in rows
    )
    return f"<!doctype html><title>{html.escape(title)}</title><table><tr>{head}</tr>{body}</table>"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--title", default="Sales report")
    args = parser.parse_args()

    rows = read_rows(pathlib.Path(args.input))
    pathlib.Path(args.out).write_text(render(rows, args.title), encoding="utf-8")


if __name__ == "__main__":
    main()
