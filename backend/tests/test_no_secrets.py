"""Repository hygiene: no credential-shaped strings in tracked files.

A live database password and API key were once committed in docs/DEPLOYMENT.md. This
test scans every git-tracked text file so that cannot happen silently again. Placeholders
such as `<password>` or `user:pass` are allowed.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

#: A database URL carrying a password; `<...>`, `pass`, `password` and `***` placeholders are allowed.
DB_URL_WITH_PASSWORD = re.compile(
    r"\b(?:postgres(?:ql)?|mysql|mongodb)(?:\+\w+)?://[^\s:/@<>]+:(?!<|pass\b|password\b|\*+)[^\s@<>]+@"
)
PATTERNS = {
    "database URL with password": DB_URL_WITH_PASSWORD,
    "JWT": re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "AWS access key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
}
SKIP_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".woff", ".woff2", ".sqlite3"}


def tracked_files() -> list[Path]:
    if shutil.which("git") is None or not (REPO_ROOT / ".git").exists():
        pytest.skip("not a git checkout")
    out = subprocess.run(["git", "ls-files"], cwd=REPO_ROOT, capture_output=True, text=True, check=True).stdout
    return [REPO_ROOT / p for p in out.splitlines() if Path(p).suffix.lower() not in SKIP_SUFFIXES]


def find_secrets(text: str) -> list[str]:
    return [name for name, rx in PATTERNS.items() if rx.search(text)]


def test_no_credentials_in_tracked_files() -> None:
    hits = []
    for path in tracked_files():
        if path.resolve() == Path(__file__).resolve() or not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        hits += [f"{path.relative_to(REPO_ROOT)}: {name}" for name in find_secrets(text)]
    assert not hits, "credential-shaped strings committed:\n" + "\n".join(hits)


@pytest.mark.parametrize(
    "text",
    [
        "postgresql://postgres.abc:hunter2@db.example.com:6543/postgres",
        "postgresql+psycopg://admin:s3cret@localhost/db",
        "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.J4LzLeUqS1EJEDyN4UK1",
        "-----BEGIN PRIVATE KEY-----",
    ],
)
def test_detects_credentials(text: str) -> None:
    assert find_secrets(text)


@pytest.mark.parametrize(
    "text",
    [
        "postgresql+psycopg://<user>:<password>@<host>:5432/<db>",
        'DATABASE_URL="postgresql://user:pass@host:port/db"',
        "postgresql+psycopg://user@host/db",
        "sqlite:///./aurohear-dev.sqlite3",
    ],
)
def test_allows_placeholders(text: str) -> None:
    assert not find_secrets(text)
