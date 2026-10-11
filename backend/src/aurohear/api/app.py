"""FastAPI application factory.

    uvicorn aurohear.api.app:create_app --factory --reload

Authentication / role-based access (spec §12.3) is NOT implemented yet — do not
expose this service publicly until it is.
"""

from __future__ import annotations

from collections.abc import Iterator

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from aurohear import __version__
from aurohear.audiometry import PROTOCOL_VERSION
from aurohear.config import get_settings
from aurohear.db import make_engine, make_session_factory, session_scope
from aurohear.services.errors import DomainError

from . import routes


def create_app(engine: Engine | None = None) -> FastAPI:
    settings = get_settings()
    engine = engine or make_engine(settings.database_url)
    factory = make_session_factory(engine)

    app = FastAPI(
        title="AuroHear v2 API",
        version=__version__,
        description="Pure-tone threshold audiometry: sessions, trial log, server-computed "
        f"thresholds and QC. Protocol {PROTOCOL_VERSION}.",
    )

    if settings.cors_origins:
        from fastapi.middleware.cors import CORSMiddleware

        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    def get_db() -> Iterator[Session]:
        yield from session_scope(factory)

    app.dependency_overrides[routes.get_db] = get_db

    @app.exception_handler(DomainError)
    async def _domain_error(_request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": exc.message, **exc.details}},
        )

    @app.get("/health", tags=["meta"])
    def health() -> dict[str, str]:
        return {"status": "ok", "version": __version__, "protocol_version": PROTOCOL_VERSION}

    app.include_router(routes.router, prefix="/api/v1", dependencies=[Depends(routes.get_db)])
    return app
