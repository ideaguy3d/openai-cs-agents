from __future__ import annotations as _annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict

from chatkit.server import StreamingResult
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from airline.agents import (
    booking_cancellation_agent,
    faq_agent,
    flight_information_agent,
    refunds_compensation_agent,
    seat_special_services_agent,
    triage_agent,
)
from airline.context import (
    AirlineAgentChatContext,
    AirlineAgentContext,
    create_initial_context,
    public_context,
)
from server import AirlineServer
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
logger = logging.getLogger(__name__)

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional local convenience
    load_dotenv = None

app = FastAPI()

# Disable tracing for zero data retention orgs
os.environ.setdefault("OPENAI_TRACING_DISABLED", "1")

if load_dotenv is not None:
    load_dotenv(BASE_DIR / ".env")

# Frontend and API are served from the same origin by default.
# Set ALLOWED_ORIGINS to a comma-separated list only if you need cross-origin access.
allowed_origins = [
    origin.strip()
    for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
]
if allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

chat_server = AirlineServer()

def get_server() -> AirlineServer:
    return chat_server

@app.get("/")
async def serve_root() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")

@app.get("/openai_logo.svg")
async def serve_logo() -> FileResponse:
    return FileResponse(STATIC_DIR / "openai_logo.svg")

@app.post("/chatkit")
async def chatkit_endpoint(
    request: Request, server: AirlineServer = Depends(get_server)
) -> Response:
    payload = await request.body()
    try:
        result = await server.process(payload, {"request": request})
        if isinstance(result, StreamingResult):
            return StreamingResponse(result, media_type="text/event-stream")
        if hasattr(result, "json"):
            return Response(content=result.json, media_type="application/json")
        return Response(content=result)
    except Exception as exc:
        logger.exception("ChatKit request failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/chatkit/state")
async def chatkit_state(
    thread_id: str = Query(...),
    server: AirlineServer = Depends(get_server),
) -> Dict[str, Any]:
    return await server.snapshot(thread_id, {"request": None})


@app.get("/chatkit/bootstrap")
async def chatkit_bootstrap(
    server: AirlineServer = Depends(get_server),
) -> Dict[str, Any]:
    return await server.snapshot(None, {"request": None})


@app.get("/chatkit/state/stream")
async def chatkit_state_stream(
    thread_id: str = Query(...),
    server: AirlineServer = Depends(get_server),
):
    thread = await server.ensure_thread(thread_id, {"request": None})
    queue = server.register_listener(thread.id)

    async def event_generator():
        try:
            initial = await server.snapshot(thread.id, {"request": None})
            yield f"data: {json.dumps(initial, default=str)}\n\n"
            while True:
                data = await queue.get()
                yield f"data: {data}\n\n"
        finally:
            server.unregister_listener(thread.id, queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.get("/health")
async def health_check() -> Dict[str, str]:
    return {
        "status": "healthy",
        "openai_api_key_configured": "true" if os.environ.get("OPENAI_API_KEY") else "false",
    }


__all__ = [
    "AirlineAgentChatContext",
    "AirlineAgentContext",
    "app",
    "booking_cancellation_agent",
    "chat_server",
    "create_initial_context",
    "faq_agent",
    "flight_information_agent",
    "public_context",
    "refunds_compensation_agent",
    "seat_special_services_agent",
    "triage_agent",
]
