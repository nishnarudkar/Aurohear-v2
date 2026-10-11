"""Domain errors, mapped to HTTP responses by the API layer."""

from __future__ import annotations

from typing import Any


class DomainError(Exception):
    status_code = 400
    code = "domain_error"

    def __init__(self, message: str, **details: Any) -> None:
        super().__init__(message)
        self.message = message
        self.details = details


class NotFound(DomainError):
    status_code = 404
    code = "not_found"


class Conflict(DomainError):
    """The request is well-formed but contradicts the stored session state."""

    status_code = 409
    code = "conflict"


class IntegrityFailure(DomainError):
    """Stored data failed a replay consistency check. Should never happen."""

    status_code = 500
    code = "integrity_failure"
