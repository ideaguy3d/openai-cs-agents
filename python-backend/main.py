from __future__ import annotations as _annotations

import asyncio
import json
import os
from typing import Any

from chatkit.server import StreamingResult
from flask import Flask, Response, jsonify, request

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

app = Flask(__name__)

# Disable tracing for zero data retention orgs
os.environ.setdefault("OPENAI_TRACING_DISABLED", "1")

chat_server = AirlineServer()

def _run(coro: Any) -> Any:
    return asyncio.run(coro)


def _json_from_result(result: Any) -> str | None:
    json_attr = getattr(result, "json", None)
    if isinstance(json_attr, str):
        return json_attr
    if callable(json_attr):
        try:
            maybe = json_attr()
            if isinstance(maybe, str):
                return maybe
        except Exception:
            return None
    return None


def _iter_async_stream(stream: StreamingResult):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        iterator = stream.__aiter__()
        while True:
            try:
                chunk = loop.run_until_complete(iterator.__anext__())
            except StopAsyncIteration:
                break
            if isinstance(chunk, (bytes, bytearray)):
                yield bytes(chunk)
            else:
                yield str(chunk).encode("utf-8")
    finally:
        loop.run_until_complete(loop.shutdown_asyncgens())
        loop.close()
        asyncio.set_event_loop(None)


@app.after_request
def add_cors_headers(resp: Response) -> Response:
    resp.headers["Access-Control-Allow-Origin"] = "http://localhost:3000"
    resp.headers["Access-Control-Allow-Credentials"] = "true"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization"
    return resp


@app.route("/chatkit", methods=["POST", "OPTIONS"])
def chatkit_endpoint() -> Response:
    if request.method == "OPTIONS":
        return Response(status=204)

    payload = request.get_data()
    result = _run(chat_server.process(payload, {"request": request}))
    if isinstance(result, StreamingResult):
        return Response(_iter_async_stream(result), mimetype="text/event-stream")

    json_body = _json_from_result(result)
    if json_body is not None:
        return Response(json_body, mimetype="application/json")

    return Response(result)


@app.get("/chatkit/state")
def chatkit_state() -> Response:
    thread_id = request.args.get("thread_id")
    if not thread_id:
        return jsonify({"error": "thread_id is required"}), 400
    data = _run(chat_server.snapshot(thread_id, {"request": None}))
    return jsonify(data)


@app.get("/chatkit/bootstrap")
def chatkit_bootstrap() -> Response:
    data = _run(chat_server.snapshot(None, {"request": None}))
    return jsonify(data)


@app.get("/chatkit/state/stream")
def chatkit_state_stream() -> Response:
    thread_id = request.args.get("thread_id")
    if not thread_id:
        return jsonify({"error": "thread_id is required"}), 400

    def event_generator():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        thread = loop.run_until_complete(
            chat_server.ensure_thread(thread_id, {"request": None})
        )
        queue = chat_server.register_listener(thread.id)
        try:
            initial = loop.run_until_complete(
                chat_server.snapshot(thread.id, {"request": None})
            )
            yield f"data: {json.dumps(initial, default=str)}\n\n"
            while True:
                data = loop.run_until_complete(queue.get())
                yield f"data: {data}\n\n"
        finally:
            chat_server.unregister_listener(thread.id, queue)
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()
            asyncio.set_event_loop(None)

    return Response(event_generator(), mimetype="text/event-stream")


@app.get("/health")
def health_check() -> Response:
    return jsonify({"status": "healthy"})


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
